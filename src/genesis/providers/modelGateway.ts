import fs from "fs";
import path from "path";

import { digestOf } from "../authority/canonical";
import { AgentSigner, fingerprintOf } from "../authority/credentials";
import { CODE_ROOT, PATHS, ensureDir, readJSON, writeJSONAtomic } from "../authority/store";
import { consumeGrant, coreGuard } from "../guards/coreGuard";

/**
 * Model Gateway client — how Genesis (and any other NEXUS agent) uses an AI
 * model without ever holding a provider's API key, and without depending on
 * any one AI company.
 *
 *  - Agents ask for NEXUS model names ("nexus-primary", "nexus-coder",
 *    "nexus-fast"), never for a company's model. The NEXUS Control Plane
 *    decides which open-weight model answers, and can swap it at any time
 *    without changing a single agent.
 *  - Provider keys live only in the Control Plane's environment. Nothing on
 *    the agent side holds, reads, logs or returns one.
 *  - Every call is a protected action: the agent signs a `key.use` request for
 *    `model:<name>`, bound to the digest of the exact call (model, output
 *    limit, system text, prompt). Key Authority decides; the default rule asks
 *    the Founder. The one-time grant is consumed here before anything is sent.
 *  - The Control Plane accepts only requests signed by an agent key Key
 *    Authority issued, re-computes the digest from the plan it receives, and
 *    refuses anything that does not match. A request cannot be altered in
 *    transit without breaking the signature or the digest.
 *  - A daily token budget is enforced here before each call and fails
 *    closed: an unreadable ledger, a missing config value or an exceeded
 *    budget stops the call.
 *  - The usage ledger records who called (key fingerprint), when, which
 *    model, the plan digest and token counts. Never the prompt, the answer or
 *    any key.
 *  - No automatic retries: a retry after a timeout could pay twice.
 */

export const MODEL_TARGET_PREFIX = "model:";
export const MAX_PROMPT_CHARS = 100_000;
export const MODEL_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const CONFIG_FILE = path.join(CODE_ROOT, "config", "model-gateway.json");
export const USAGE_DIR = path.join(PATHS.stateDir, "usage");

/** The Key Authority target for a NEXUS model name. Rules match on it, e.g. "model:*". */
export function modelTarget(model: string): string {
  return `${MODEL_TARGET_PREFIX}${model}`;
}

export interface GatewayConfig {
  /** URL of the NEXUS Control Plane's model endpoint: https, or http only on this device (loopback). */
  readonly url: string;
  readonly defaultModel: string;
  readonly allowedModels: readonly string[];
  /** Input + output tokens allowed per calendar day (UTC). */
  readonly dailyTokenCap: number;
  /** Largest output a single call may ask for. */
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface ModelPlan {
  readonly model: string;
  readonly maxTokens: number;
  readonly system: string;
  readonly prompt: string;
}

export interface ModelAnswer {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface TransportResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export type Transport = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<TransportResponse>;

export class ModelGatewayError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  constructor(code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "ModelGatewayError";
    this.code = code;
    this.requestId = requestId;
  }
}

// ---------- configuration (fails closed) ----------

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parseConfig(raw: unknown): GatewayConfig {
  const c = raw as Record<string, unknown> | null;
  const bad = (why: string): never => {
    throw new ModelGatewayError("CONFIG_INVALID", `Model gateway config: ${why}`);
  };
  if (!c || typeof c !== "object") bad("not an object");
  const cfg = c as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(String(cfg.url));
  } catch {
    return bad("url is not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    bad("url must use https, or http only to this device (127.0.0.1)");
  }
  if (url.username || url.password) bad("url must not contain credentials");
  const allowed = cfg.allowedModels;
  if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((m) => typeof m === "string" && MODEL_NAME_RE.test(m))) {
    bad("allowedModels must be a non-empty list of model names");
  }
  const models = (allowed as string[]).slice();
  if (typeof cfg.defaultModel !== "string" || !models.includes(cfg.defaultModel)) bad("defaultModel must be one of allowedModels");
  if (!isPositiveInt(cfg.dailyTokenCap)) bad("dailyTokenCap must be a positive whole number");
  if (!isPositiveInt(cfg.maxOutputTokens)) bad("maxOutputTokens must be a positive whole number");
  if (!isPositiveInt(cfg.timeoutMs) || (cfg.timeoutMs as number) > 300_000) bad("timeoutMs must be 1..300000");
  return Object.freeze({
    url: url.toString(),
    defaultModel: cfg.defaultModel as string,
    allowedModels: Object.freeze(models),
    dailyTokenCap: cfg.dailyTokenCap as number,
    maxOutputTokens: cfg.maxOutputTokens as number,
    timeoutMs: cfg.timeoutMs as number,
  });
}

export function loadConfig(file: string = CONFIG_FILE): GatewayConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    throw new ModelGatewayError("CONFIG_MISSING", `No model gateway config at ${file}; no calls are possible until the Founder adds it.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ModelGatewayError("CONFIG_INVALID", "Model gateway config is not valid JSON.");
  }
  return parseConfig(raw);
}

// ---------- the plan and its digest ----------

export function makePlan(
  cfg: GatewayConfig,
  input: { prompt: unknown; system?: unknown; model?: unknown; maxTokens?: unknown }
): ModelPlan {
  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new ModelGatewayError("INVALID_REQUEST", "Prompt must be non-empty text.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new ModelGatewayError("INVALID_REQUEST", `Prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
  }
  const system = input.system === undefined ? "" : input.system;
  if (typeof system !== "string" || system.length > MAX_PROMPT_CHARS) {
    throw new ModelGatewayError("INVALID_REQUEST", "System text must be a string within the size limit.");
  }
  const model = input.model === undefined ? cfg.defaultModel : input.model;
  if (typeof model !== "string" || !cfg.allowedModels.includes(model)) {
    throw new ModelGatewayError("INVALID_REQUEST", `Model is not on the allowed list: ${String(model)}`);
  }
  const maxTokens = input.maxTokens === undefined ? Math.min(1024, cfg.maxOutputTokens) : input.maxTokens;
  if (!isPositiveInt(maxTokens) || maxTokens > cfg.maxOutputTokens) {
    throw new ModelGatewayError("INVALID_REQUEST", `maxTokens must be 1..${cfg.maxOutputTokens}.`);
  }
  return Object.freeze({ model, maxTokens, system, prompt });
}

/** The digest both sides compute. The Control Plane re-computes it from the plan it receives. */
export function planDigest(plan: ModelPlan): string {
  return digestOf({ model: plan.model, maxTokens: plan.maxTokens, system: plan.system, prompt: plan.prompt });
}

// ---------- the usage ledger (fails closed) ----------

interface LedgerEntry {
  at: string;
  fingerprint: string;
  model: string;
  digest: string;
  reserved: number;
  inputTokens: number | null;
  outputTokens: number | null;
  status: "reserved" | "done" | "failed";
}
interface Ledger {
  day: string;
  tokens: number;
  calls: LedgerEntry[];
}

function ledgerFile(day: string): string {
  return path.join(USAGE_DIR, `${day}.json`);
}

function readLedger(day: string): Ledger {
  const file = ledgerFile(day);
  if (!fs.existsSync(file)) return { day, tokens: 0, calls: [] };
  const raw = readJSON(file) as Ledger | null;
  if (!raw || raw.day !== day || typeof raw.tokens !== "number" || !Number.isFinite(raw.tokens) || !Array.isArray(raw.calls)) {
    throw new ModelGatewayError("LEDGER_UNREADABLE", `Usage ledger ${file} is unreadable; refusing to spend until it is fixed.`);
  }
  return raw;
}

/** Rough upper bound on input tokens: never fewer than one per two characters. */
export function estimateInputTokens(plan: ModelPlan): number {
  return Math.ceil((plan.prompt.length + plan.system.length) / 2) + 16;
}

export function usageToday(now: number = Date.now()): { day: string; tokens: number } {
  const day = new Date(now).toISOString().slice(0, 10);
  const l = readLedger(day);
  return { day, tokens: l.tokens };
}

function isWholeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// ---------- the call ----------

/**
 * Ask a NEXUS model one question through the Control Plane. Throws
 * APPROVAL_REQUIRED (with the request id the Founder approves) the first time
 * a given exact call is made under an "ask" rule.
 */
export async function askModel(
  signer: AgentSigner,
  input: { prompt: unknown; system?: unknown; model?: unknown; maxTokens?: unknown },
  opts: { config?: GatewayConfig; transport?: Transport; now?: () => number } = {}
): Promise<ModelAnswer> {
  const cfg = opts.config ?? loadConfig();
  const now = opts.now ?? Date.now;
  const transport: Transport = opts.transport ?? ((url, init) => fetch(url, init));
  const plan = makePlan(cfg, input);
  const digest = planDigest(plan);
  const target = modelTarget(plan.model);
  const action = "key.use";

  // 1. Key Authority decides, on the signed request for this exact plan.
  const decision = coreGuard(
    signer.sign({
      action,
      target,
      digest,
      summary: `Model call to ${plan.model}: up to ${plan.maxTokens} output tokens, prompt of ${plan.prompt.length} characters.`,
    })
  );
  if (decision.pending) {
    throw new ModelGatewayError("APPROVAL_REQUIRED", `This model call needs Founder approval: ${decision.reason}`, decision.requestId);
  }
  if (!decision.allowed) {
    throw new ModelGatewayError("DENIED", `Model call refused: ${decision.reason}`);
  }
  const used = consumeGrant(decision.grant, { action, target, digest });
  if ("reason" in used) throw new ModelGatewayError("DENIED", `Model call refused: ${used.reason}`);

  // 2. Budget, before anything is sent. Reserve the worst case.
  const t = now();
  const day = new Date(t).toISOString().slice(0, 10);
  const ledger = readLedger(day);
  const reserve = estimateInputTokens(plan) + plan.maxTokens;
  if (ledger.tokens + reserve > cfg.dailyTokenCap) {
    throw new ModelGatewayError(
      "BUDGET_EXCEEDED",
      `Daily token budget would be exceeded (${ledger.tokens} used + ${reserve} needed > ${cfg.dailyTokenCap}).`
    );
  }
  const entry: LedgerEntry = {
    at: new Date(t).toISOString(),
    fingerprint: fingerprintOf(Buffer.from(signer.publicKey, "base64")),
    model: plan.model,
    digest,
    reserved: reserve,
    inputTokens: null,
    outputTokens: null,
    status: "reserved",
  };
  ledger.calls.push(entry);
  ledger.tokens += reserve;
  ensureDir(USAGE_DIR);
  writeJSONAtomic(ledgerFile(day), ledger);

  // 3. The Control Plane call: a fresh signature over the same digest.
  const call = signer.sign({ action: "model.call", target, digest });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let status = 0;
  let body: unknown = null;
  try {
    const res = await transport(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: call, plan }),
      signal: controller.signal,
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    entry.status = "failed";
    writeJSONAtomic(ledgerFile(day), ledger); // the reservation stays: it may have been spent
    const timedOut = controller.signal.aborted;
    throw new ModelGatewayError(timedOut ? "TIMEOUT" : "GATEWAY_UNREACHABLE", timedOut ? "The Control Plane did not answer in time." : "The Control Plane could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  const b = body as { ok?: unknown; text?: unknown; model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown }; error?: unknown } | null;
  if (status !== 200 || !b || b.ok !== true || typeof b.text !== "string") {
    entry.status = "failed";
    writeJSONAtomic(ledgerFile(day), ledger);
    const why = b && typeof b.error === "string" ? b.error.slice(0, 200) : `HTTP ${status}`;
    throw new ModelGatewayError("GATEWAY_ERROR", `The Control Plane refused or failed: ${why}`);
  }

  // 4. Settle the reservation with the real token counts when they are given.
  const inT = b.usage && isWholeNumber(b.usage.input_tokens) ? b.usage.input_tokens : null;
  const outT = b.usage && isWholeNumber(b.usage.output_tokens) ? b.usage.output_tokens : null;
  if (inT !== null && outT !== null) {
    ledger.tokens += inT + outT - reserve;
    entry.inputTokens = inT;
    entry.outputTokens = outT;
  }
  entry.status = "done";
  writeJSONAtomic(ledgerFile(day), ledger);

  return Object.freeze({
    text: b.text,
    model: typeof b.model === "string" ? b.model : plan.model,
    inputTokens: inT ?? 0,
    outputTokens: outT ?? 0,
  });
}
