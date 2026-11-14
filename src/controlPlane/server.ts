import fs from "fs";
import http from "http";
import path from "path";

import { isLockedDown } from "../genesis/authority/KeyAuthority";
import { authenticate } from "../genesis/authority/credentials";
import { PATHS, ensureDir, readJSON, writeJSONAtomic } from "../genesis/authority/store";
import { MAX_PROMPT_CHARS, ModelPlan, modelTarget, planDigest } from "../genesis/providers/modelGateway";
import { appendLog, readLog, verifyLog } from "../genesis/warden/log";
import { getAgent } from "../genesis/warden/state";
import { ControlPlaneConfig } from "./config";

/**
 * The NEXUS Control Plane — the server side of the Model Gateway.
 *
 * Agents never talk to an AI company. They send the Control Plane a request
 * signed with their NEXUS identity key, for a NEXUS model name. The Control
 * Plane:
 *
 *   1. checks the signature against the credentials Key Authority issued
 *      (and that the nonce was never used before);
 *   2. re-computes the plan digest and refuses anything that doesn't match
 *      what the agent signed;
 *   3. refuses agents not on its list, agents the Warden has quarantined, and
 *      everything while NEXUS is in lockdown;
 *   4. enforces a per-agent daily token budget, failing closed;
 *   5. sends the call to the first configured open-weight backend for that
 *      model, falling back to the next only when the first certainly did not
 *      run it (unreachable, or busy: 429/502/503). A timeout never falls back,
 *      because the first backend may already have been paid;
 *   6. records who, when, which model, which backend and how many tokens in a
 *      hash-chained log. Never a prompt, an answer or a key.
 *
 * Provider keys are read from this process's environment at the moment of a
 * call and are never logged, stored or returned.
 */

export const CP_DIR = path.join(PATHS.stateDir, "control-plane");
export const CP_LOG = path.join(CP_DIR, "events.log");
export const CP_HEAD = path.join(CP_DIR, "events.head");
export const CP_USAGE_DIR = path.join(CP_DIR, "usage");
export const MODEL_PATH = "/v1/nexus/model";
export const MAX_BODY_BYTES = 512 * 1024;

const SIGNED_FIELDS = ["v", "publicKey", "nonce", "issuedAt", "signature", "action", "target", "digest", "summary"];
const BUSY = new Set([429, 502, 503]);

export type Fetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface ControlPlaneOptions {
  config: ControlPlaneConfig;
  /** Where provider keys are read from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  now?: () => number;
}

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------- the event log and usage (no prompts, no answers, no keys) ----------

function logEvent(event: Record<string, unknown>): void {
  ensureDir(CP_DIR);
  appendLog(CP_LOG, CP_HEAD, event);
}

export function controlPlaneLog(): { ok: boolean; reason: string; entries: ReturnType<typeof readLog> } {
  const v = verifyLog(CP_LOG, CP_HEAD);
  return { ok: v.ok, reason: v.reason ?? "", entries: fs.existsSync(CP_LOG) ? readLog(CP_LOG) : [] };
}

interface Usage {
  day: string;
  agents: Record<string, { tokens: number; calls: number }>;
}

function usageFile(day: string): string {
  return path.join(CP_USAGE_DIR, `${day}.json`);
}

function readUsage(day: string): Usage {
  const f = usageFile(day);
  if (!fs.existsSync(f)) return { day, agents: {} };
  const u = readJSON(f) as Usage | null;
  if (!u || u.day !== day || !u.agents || typeof u.agents !== "object") {
    throw new Refusal(503, "the usage ledger is unreadable; refusing to spend until it is fixed");
  }
  return u;
}

function writeUsage(u: Usage): void {
  ensureDir(CP_USAGE_DIR);
  writeJSONAtomic(usageFile(u.day), u);
}

// ---------- reading a request ----------

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Refusal(413, "request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Refusal(400, "request is not valid JSON"));
      }
    });
    req.on("error", () => reject(new Refusal(400, "request could not be read")));
  });
}

function checkPlan(cfg: ControlPlaneConfig, raw: unknown): ModelPlan {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") throw new Refusal(400, "missing plan");
  const { model, maxTokens, system, prompt } = p;
  if (typeof model !== "string" || !Object.prototype.hasOwnProperty.call(cfg.models, model)) throw new Refusal(400, "unknown NEXUS model");
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > cfg.maxOutputTokens) {
    throw new Refusal(400, `maxTokens must be 1..${cfg.maxOutputTokens}`);
  }
  if (typeof system !== "string" || system.length > MAX_PROMPT_CHARS) throw new Refusal(400, "bad system text");
  if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) throw new Refusal(400, "bad prompt");
  return { model, maxTokens, system, prompt };
}

/** Who is asking. Checks everything the agent signed before any money can be spent. */
function whoIsAsking(cfg: ControlPlaneConfig, rawRequest: unknown, plan: ModelPlan, now: number): string {
  const r = rawRequest as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Refusal(401, "missing signed request");
  const copy: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
  if (copy.action !== "model.call") throw new Refusal(401, "request is not a model call");
  if (copy.target !== modelTarget(plan.model)) throw new Refusal(401, "request was signed for a different model");
  if (copy.digest !== planDigest(plan)) throw new Refusal(401, "plan does not match what the agent signed");
  const auth = authenticate(copy, now);
  if (auth.ok !== true) {
    logEvent({ type: "refused", reason: `not authenticated: ${(auth as { reason: string }).reason}` });
    throw new Refusal(401, "not authenticated");
  }
  const agent = (auth as { agent: string }).agent;
  if (!cfg.agents.includes(agent)) {
    logEvent({ type: "refused", agent, reason: "agent is not allowed to use models" });
    throw new Refusal(403, `${agent} is not allowed to use NEXUS models`);
  }
  if (getAgent(agent).status === "quarantined") {
    logEvent({ type: "refused", agent, reason: "quarantined by the Warden" });
    throw new Refusal(403, `${agent} is quarantined by the Warden`);
  }
  if (isLockedDown()) {
    logEvent({ type: "refused", agent, reason: "NEXUS is in lockdown" });
    throw new Refusal(423, "NEXUS is in lockdown");
  }
  return agent;
}

// ---------- calling a backend ----------

interface Answer {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  provider: string;
}

const wholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

async function callBackends(
  cfg: ControlPlaneConfig,
  plan: ModelPlan,
  env: Record<string, string | undefined>,
  doFetch: Fetch,
  agent: string
): Promise<Answer> {
  const chain = cfg.models[plan.model];
  let configured = 0;
  const messages = [...(plan.system ? [{ role: "system", content: plan.system }] : []), { role: "user", content: plan.prompt }];

  for (const backend of chain) {
    const provider = cfg.providers[backend.provider];
    const key = provider.keyEnv ? env[provider.keyEnv] : null;
    if (provider.keyEnv && !key) continue; // not set up on this device: skip, never guess
    configured += 1;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
    let status = 0;
    let body: unknown = null;
    try {
      const res = await doFetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: backend.model, messages, max_tokens: plan.maxTokens, stream: false }),
        signal: controller.signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      if (controller.signal.aborted) {
        logEvent({ type: "backend-timeout", agent, model: plan.model, provider: backend.provider });
        throw new Refusal(504, "the model did not answer in time (not retried: it may already have run)");
      }
      logEvent({ type: "backend-unreachable", agent, model: plan.model, provider: backend.provider });
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (BUSY.has(status)) {
      logEvent({ type: "backend-busy", agent, model: plan.model, provider: backend.provider, status });
      continue;
    }
    const b = body as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;
    const text = b?.choices?.[0]?.message?.content;
    if (status !== 200 || typeof text !== "string") {
      logEvent({ type: "backend-error", agent, model: plan.model, provider: backend.provider, status });
      throw new Refusal(502, `the model backend failed (HTTP ${status})`);
    }
    return {
      text,
      inputTokens: wholeNumber(b?.usage?.prompt_tokens) ? (b!.usage!.prompt_tokens as number) : null,
      outputTokens: wholeNumber(b?.usage?.completion_tokens) ? (b!.usage!.completion_tokens as number) : null,
      provider: backend.provider,
    };
  }
  if (configured === 0) throw new Refusal(503, `no backend is set up for ${plan.model} on this device`);
  throw new Refusal(503, `every backend for ${plan.model} is unreachable or busy`);
}

// ---------- the server ----------

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** What anyone on this device may see: names and whether each backend is set up. Never a key. */
export function health(cfg: ControlPlaneConfig, env: Record<string, string | undefined>) {
  const models: Record<string, { provider: string; model: string; ready: boolean }[]> = {};
  for (const [name, chain] of Object.entries(cfg.models)) {
    models[name] = chain.map((b) => {
      const p = cfg.providers[b.provider];
      return { provider: b.provider, model: b.model, ready: p.keyEnv === null || Boolean(env[p.keyEnv]) };
    });
  }
  return { ok: true, service: "NEXUS Control Plane", lockdown: isLockedDown(), agents: cfg.agents, models };
}

export function createControlPlane(opts: ControlPlaneOptions): http.Server {
  const cfg = opts.config;
  const env = opts.env ?? process.env;
  const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return send(res, 200, health(cfg, env));
      if (req.url !== MODEL_PATH) return send(res, 404, { ok: false, error: "not found" });
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "use POST" });

      const body = (await readBody(req)) as { request?: unknown; plan?: unknown } | null;
      if (!body || typeof body !== "object") throw new Refusal(400, "bad request");
      const plan = checkPlan(cfg, body.plan);
      const agent = whoIsAsking(cfg, body.request, plan, now());

      // Budget, before anything is sent: reserve the worst case for this agent.
      const day = new Date(now()).toISOString().slice(0, 10);
      const usage = readUsage(day);
      const mine = usage.agents[agent] ?? { tokens: 0, calls: 0 };
      const reserve = Math.ceil((plan.prompt.length + plan.system.length) / 2) + 16 + plan.maxTokens;
      if (mine.tokens + reserve > cfg.perAgentDailyTokenCap) {
        logEvent({ type: "refused", agent, model: plan.model, reason: "daily token budget" });
        throw new Refusal(429, `${agent}'s daily token budget would be exceeded`);
      }
      mine.tokens += reserve;
      mine.calls += 1;
      usage.agents[agent] = mine;
      writeUsage(usage);

      let answer: Answer;
      try {
        answer = await callBackends(cfg, plan, env, doFetch, agent);
      } catch (err) {
        // The reservation stays counted: a failed call may still have cost money.
        throw err;
      }
      if (answer.inputTokens !== null && answer.outputTokens !== null) {
        const settled = readUsage(day);
        const a = settled.agents[agent] ?? { tokens: 0, calls: 0 };
        a.tokens += answer.inputTokens + answer.outputTokens - reserve;
        settled.agents[agent] = a;
        writeUsage(settled);
      }
      logEvent({
        type: "answered", agent, model: plan.model, provider: answer.provider,
        inputTokens: answer.inputTokens, outputTokens: answer.outputTokens,
      });
      return send(res, 200, {
        ok: true,
        text: answer.text,
        model: plan.model,
        servedBy: answer.provider,
        usage: { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens },
      });
    } catch (err: unknown) {
      if (err instanceof Refusal) return send(res, err.status, { ok: false, error: err.message });
      return send(res, 500, { ok: false, error: "internal error" });
    }
  });
}

/** Start listening. Resolves with the port actually used (useful with port 0). */
export function startControlPlane(opts: ControlPlaneOptions): Promise<{ server: http.Server; port: number }> {
  const server = createControlPlane(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.config.port, opts.config.host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : opts.config.port });
    });
  });
}
