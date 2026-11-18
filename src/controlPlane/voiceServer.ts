import fs from "fs";
import http from "http";
import path from "path";

import { isLockedDown } from "../genesis/authority/KeyAuthority";
import { authenticate } from "../genesis/authority/credentials";
import { ensureDir, readJSON, writeJSONAtomic } from "../genesis/authority/store";
import { VOICE_PATH, voicePlanDigest, voiceTarget } from "../genesis/providers/voiceGateway";
import { appendLog } from "../genesis/warden/log";
import { getAgent } from "../genesis/warden/state";
import { ControlPlaneConfig } from "./config";
import { CP_DIR, CP_HEAD, CP_LOG, CP_USAGE_DIR, ControlPlaneOptions, createControlPlane } from "./server";
import { AudioFetch, callVoiceBackends } from "./voiceBackends";
import { VoiceConfig, VoicePlan, VoiceRefusal, canUseVoice, checkVoicePlan, languageVerified } from "./voiceConfig";

/**
 * The voice route of the NEXUS Control Plane. ADDITIVE: it wraps the existing server and adds
 * one route; the model route and every existing file are untouched.
 *
 *   1. checks the signature against the credentials Key Authority issued (nonce never reused);
 *   2. re-computes the plan digest and refuses anything that doesn't match what the agent signed;
 *   3. refuses agents not on the list, quarantined agents, and everything during lockdown;
 *   4. refuses a voice the agent does not own / may not use (Genesis, Savannah, Aria and the Orb
 *      only ever speak with their own voice; the Orb has none unless the Founder assigns one);
 *   5. refuses a language the Founder has not marked verified for that voice;
 *   6. enforces a per-agent daily CHARACTER budget, failing closed;
 *   7. sends the call to the first configured backend, falling back only when the first
 *      certainly did not run it; a timeout never falls back;
 *   8. records who, when, which voice, which backend, how many characters and the plan digest in
 *      the hash-chained log. Never the text, the audio or a key.
 *
 * Voice is OUTPUT only. It never authorizes anything, and Warden quarantine / lockdown / the
 * Founder kill switch silence it. If the log cannot be written, nothing is spoken.
 */

export const VOICE_HEALTH_PATH = "/v1/nexus/voice/health";
export const MAX_VOICE_BODY_BYTES = 64 * 1024;
const SIGNED_FIELDS = ["v", "publicKey", "nonce", "issuedAt", "signature", "action", "target", "digest", "summary"];

export interface VoiceServerOptions {
  control: ControlPlaneOptions;
  voice: VoiceConfig;
  audioFetch?: AudioFetch;
}

function logEvent(event: Record<string, unknown>): void {
  ensureDir(CP_DIR);
  appendLog(CP_LOG, CP_HEAD, event); // throws if the log is unavailable: the caller fails closed
}

interface VoiceUsage {
  day: string;
  agents: Record<string, { chars: number; calls: number }>;
}
const usageFile = (day: string) => path.join(CP_USAGE_DIR, `voice-${day}.json`);
function readUsage(day: string): VoiceUsage {
  const f = usageFile(day);
  if (!fs.existsSync(f)) return { day, agents: {} };
  const u = readJSON(f) as VoiceUsage | null;
  if (!u || u.day !== day || !u.agents || typeof u.agents !== "object") {
    throw new VoiceRefusal(503, "the voice usage ledger is unreadable; refusing to spend until it is fixed");
  }
  return u;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_VOICE_BODY_BYTES) {
        reject(new VoiceRefusal(413, "request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new VoiceRefusal(400, "request is not valid JSON"));
      }
    });
    req.on("error", () => reject(new VoiceRefusal(400, "request could not be read")));
  });
}

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

function whoIsAsking(cp: ControlPlaneConfig, vc: VoiceConfig, rawRequest: unknown, plan: VoicePlan, now: number): string {
  const r = rawRequest as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new VoiceRefusal(401, "missing signed request");
  const copy: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
  if (copy.action !== "voice.call") throw new VoiceRefusal(401, "request is not a voice call");
  if (copy.target !== voiceTarget(plan.voice)) throw new VoiceRefusal(401, "request was signed for a different voice");
  if (copy.digest !== voicePlanDigest(plan)) throw new VoiceRefusal(401, "plan does not match what the agent signed");
  const auth = authenticate(copy, now);
  if (auth.ok !== true) {
    logEvent({ type: "voice-refused", reason: `not authenticated: ${(auth as { reason: string }).reason}` });
    throw new VoiceRefusal(401, "not authenticated");
  }
  const agent = (auth as { agent: string }).agent;
  if (!cp.agents.includes(agent)) {
    logEvent({ type: "voice-refused", agent, reason: "agent is not allowed to use NEXUS services" });
    throw new VoiceRefusal(403, `${agent} is not allowed to use NEXUS voices`);
  }
  if (getAgent(agent).status === "quarantined") {
    logEvent({ type: "voice-refused", agent, reason: "quarantined by the Warden" });
    throw new VoiceRefusal(403, `${agent} is quarantined by the Warden`);
  }
  if (isLockedDown()) {
    logEvent({ type: "voice-refused", agent, reason: "NEXUS is in lockdown" });
    throw new VoiceRefusal(423, "NEXUS is in lockdown");
  }
  if (!canUseVoice(vc, agent, plan.voice)) {
    logEvent({ type: "voice-refused", agent, voice: plan.voice, reason: "agent may not use this voice" });
    throw new VoiceRefusal(403, `${agent} may not use ${plan.voice}`);
  }
  return agent;
}

export function voiceHealth(cp: ControlPlaneConfig, vc: VoiceConfig, env: Record<string, string | undefined>) {
  const voices: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(vc.voices)) {
    voices[name] = {
      owner: v.ownerAgent,
      gender: v.gender,
      accent: v.accent,
      languages: v.languages,
      verifiedLanguages: v.verifiedLanguages,
      backends: v.chain.map((b) => {
        const p = vc.providers[b.provider];
        return { provider: b.provider, ready: p.keyEnv === null || Boolean(env[p.keyEnv]) };
      }),
    };
  }
  return { ok: true, service: "NEXUS Control Plane voice", lockdown: isLockedDown(), voices };
}

export function createVoiceHandler(cp: ControlPlaneConfig, opts: VoiceServerOptions) {
  const vc = opts.voice;
  const env = opts.control.env ?? process.env;
  const now = opts.control.now ?? Date.now;
  const audioFetch: AudioFetch = opts.audioFetch ?? ((url, init) => fetch(url, init));

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      if (req.method === "GET" && req.url === VOICE_HEALTH_PATH) return send(res, 200, voiceHealth(cp, vc, env));
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "use POST" });

      const body = (await readBody(req)) as { request?: unknown; plan?: unknown } | null;
      if (!body || typeof body !== "object") throw new VoiceRefusal(400, "bad request");
      const plan = checkVoicePlan(vc, body.plan);
      const agent = whoIsAsking(cp, vc, body.request, plan, now());

      if (!languageVerified(vc, plan)) {
        logEvent({ type: "voice-refused", agent, voice: plan.voice, language: plan.language, reason: "language not verified" });
        throw new VoiceRefusal(422, `${plan.language} is not verified for ${plan.voice}; showing text only`);
      }

      // Budget, before anything is sent: reserve the exact characters for this agent.
      const day = new Date(now()).toISOString().slice(0, 10);
      const usage = readUsage(day);
      const mine = usage.agents[agent] ?? { chars: 0, calls: 0 };
      if (mine.chars + plan.text.length > vc.perAgentDailyCharCap) {
        logEvent({ type: "voice-refused", agent, voice: plan.voice, reason: "daily character budget" });
        throw new VoiceRefusal(429, `${agent}'s daily voice budget would be exceeded`);
      }
      mine.chars += plan.text.length;
      mine.calls += 1;
      usage.agents[agent] = mine;
      ensureDir(CP_USAGE_DIR);
      writeJSONAtomic(usageFile(day), usage); // the reservation stays counted even if the call fails

      // The log must be writable BEFORE we pay for anything: fail closed.
      try {
        logEvent({ type: "voice-requested", agent, voice: plan.voice, language: plan.language, chars: plan.text.length, digest: voicePlanDigest(plan) });
      } catch {
        throw new VoiceRefusal(503, "the log is unavailable; nothing is spoken");
      }

      const spoken = await callVoiceBackends(vc, plan, env, audioFetch, (e) => {
        try {
          logEvent({ ...e, agent });
        } catch {
          /* already failing closed on the main path */
        }
      });
      try {
        logEvent({ type: "voice-spoken", agent, voice: plan.voice, provider: spoken.provider, chars: plan.text.length, digest: voicePlanDigest(plan) });
      } catch {
        throw new VoiceRefusal(503, "the log is unavailable; audio discarded");
      }
      return send(res, 200, {
        ok: true,
        audioBase64: spoken.audio.toString("base64"),
        mime: spoken.mime,
        voice: plan.voice,
        servedBy: spoken.provider,
        chars: plan.text.length,
      });
    } catch (err: unknown) {
      if (err instanceof VoiceRefusal) return send(res, err.status, { ok: false, error: err.message });
      return send(res, 500, { ok: false, error: "internal error" });
    }
  };
}

/**
 * The existing Control Plane server plus the voice route. Existing routes behave exactly as
 * before; only the voice paths are intercepted.
 */
export function createControlPlaneWithVoice(opts: VoiceServerOptions): http.Server {
  const server = createControlPlane(opts.control);
  const existing = server.listeners("request") as Array<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
  server.removeAllListeners("request");
  const handle = createVoiceHandler(opts.control.config, opts);
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === VOICE_PATH || req.url === VOICE_HEALTH_PATH) {
      void handle(req, res);
      return;
    }
    for (const l of existing) l.call(server, req, res);
  });
  return server;
}

/** Start listening. Resolves with the port actually used. */
export function startControlPlaneWithVoice(opts: VoiceServerOptions): Promise<{ server: http.Server; port: number }> {
  const server = createControlPlaneWithVoice(opts);
  const cfg = opts.control.config;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : cfg.port });
    });
  });
}
