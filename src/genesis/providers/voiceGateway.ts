import { digestOf } from "../authority/canonical";
import { AgentSigner } from "../authority/credentials";
import { CODE_ROOT } from "../authority/store";
import { consumeGrant, coreGuard } from "../guards/coreGuard";
import fs from "fs";
import path from "path";
import { parseVoiceConfig, checkVoicePlan, VoiceConfig, VoicePlan, VoiceRefusal } from "../../controlPlane/voiceConfig";

/**
 * Voice Gateway client — how Genesis (and any other NEXUS agent) asks for speech without ever
 * holding a provider's key. Same shape as modelGateway.ts:
 *
 *  - Agents ask for a NEXUS voice name ("nexus-genesis"), never a company's voice.
 *  - Every call is a protected action: the agent signs a `key.use` request for `voice:<name>`,
 *    bound to the digest of the exact line of text. Key Authority decides; the default rule
 *    asks the Founder. The one-time grant is consumed here before anything is sent.
 *  - The Control Plane re-checks the signature, the digest, the agent list, quarantine,
 *    lockdown, voice ownership, verified language and the daily character budget.
 *  - The Control Plane is the budget authority for voice (no second ledger here).
 *  - No automatic retries: a retry after a timeout could pay twice.
 *  - Voice is OUTPUT only. A spoken line never authorizes anything.
 */

export const VOICE_TARGET_PREFIX = "voice:";
export const VOICE_PATH = "/v1/nexus/voice";
export const VOICE_CONFIG_FILE = path.join(CODE_ROOT, "config", "voice.json");

export function voiceTarget(voice: string): string {
  return `${VOICE_TARGET_PREFIX}${voice}`;
}
/** The digest both sides compute. The Control Plane re-computes it from the plan it receives. */
export function voicePlanDigest(plan: VoicePlan): string {
  return digestOf({ kind: "voice", voice: plan.voice, language: plan.language, text: plan.text });
}

export class VoiceGatewayError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  constructor(code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "VoiceGatewayError";
    this.code = code;
    this.requestId = requestId;
  }
}

export interface VoiceTransportResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export type VoiceTransport = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<VoiceTransportResponse>;

export interface SpokenLine {
  readonly audio: Buffer;
  readonly mime: string;
  readonly voice: string;
  readonly chars: number;
  /** The text is always returned too, so captions work and a failure still shows words. */
  readonly text: string;
}

export function loadVoiceConfig(agents: readonly string[], file: string = VOICE_CONFIG_FILE): VoiceConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    throw new VoiceGatewayError("CONFIG_MISSING", `No voice config at ${file}; no speech is possible until the Founder adds it.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VoiceGatewayError("CONFIG_INVALID", "Voice config is not valid JSON.");
  }
  return parseVoiceConfig(raw, agents);
}

export async function askVoice(
  signer: AgentSigner,
  input: { voice: unknown; text: unknown; language: unknown },
  opts: { config: VoiceConfig; transport?: VoiceTransport }
): Promise<SpokenLine> {
  const cfg = opts.config;
  const transport: VoiceTransport = opts.transport ?? ((url, init) => fetch(url, init));
  let plan: VoicePlan;
  try {
    plan = checkVoicePlan(cfg, input);
  } catch (e) {
    throw new VoiceGatewayError("INVALID_REQUEST", e instanceof VoiceRefusal ? e.message : "Invalid voice request.");
  }
  const digest = voicePlanDigest(plan);
  const target = voiceTarget(plan.voice);
  const action = "key.use";

  // 1. Key Authority decides, on the signed request for this exact line.
  const decision = coreGuard(
    signer.sign({
      action,
      target,
      digest,
      summary: `Voice call to ${plan.voice}: ${plan.text.length} characters, language ${plan.language}.`,
    })
  );
  if (decision.pending) {
    throw new VoiceGatewayError("APPROVAL_REQUIRED", `This voice call needs Founder approval: ${decision.reason}`, decision.requestId);
  }
  if (!decision.allowed) throw new VoiceGatewayError("DENIED", `Voice call refused: ${decision.reason}`);
  const used = consumeGrant(decision.grant, { action, target, digest });
  if ("reason" in used) throw new VoiceGatewayError("DENIED", `Voice call refused: ${used.reason}`);

  // 2. The Control Plane call: a fresh signature over the same digest.
  const call = signer.sign({ action: "voice.call", target, digest });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.clientTimeoutMs);
  let status = 0;
  let body: unknown = null;
  try {
    const res = await transport(cfg.clientUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: call, plan }),
      signal: controller.signal,
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    const timedOut = controller.signal.aborted;
    throw new VoiceGatewayError(timedOut ? "TIMEOUT" : "GATEWAY_UNREACHABLE", timedOut ? "The Control Plane did not answer in time." : "The Control Plane could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  const b = body as { ok?: unknown; audioBase64?: unknown; mime?: unknown; error?: unknown } | null;
  if (status !== 200 || !b || b.ok !== true || typeof b.audioBase64 !== "string" || typeof b.mime !== "string") {
    const why = b && typeof b.error === "string" ? b.error.slice(0, 200) : `HTTP ${status}`;
    throw new VoiceGatewayError("GATEWAY_ERROR", `The Control Plane refused or failed: ${why}`);
  }
  const audio = Buffer.from(b.audioBase64, "base64");
  if (audio.length === 0) throw new VoiceGatewayError("GATEWAY_ERROR", "The Control Plane returned no audio.");
  return Object.freeze({ audio, mime: b.mime, voice: plan.voice, chars: plan.text.length, text: plan.text });
}
