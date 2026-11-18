/**
 * NEXUS voice configuration and request checks (pure: no authority, no files, no network).
 *
 * Mirrors config.ts: names NEXUS voices ("nexus-genesis") and, for each, an ordered chain of
 * backends. It never holds a key: a provider names the environment variable its key is read
 * from (NEXUS_KEY_...). Agents ask for a NEXUS voice name and never see a provider's.
 *
 * Voice is OUTPUT only. It never authorizes anything.
 */

export const VOICE_NAME_RE = /^[a-z][a-z0-9.-]{0,63}$/;
export const KEY_ENV_RE = /^NEXUS_KEY_[A-Z0-9_]{1,48}$/; // same rule as config.ts
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const VOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Agents whose voices are reserved: they may only use a voice that names them as owner. */
export const RESERVED_AGENTS: readonly string[] = Object.freeze(["genesis", "savannah", "aria", "orb"]);
/** Genesis and Savannah are always women's voices (Founder rule). */
export const FEMALE_ONLY_AGENTS: readonly string[] = Object.freeze(["genesis", "savannah"]);
export const GENDERS = ["female", "male", "neutral"] as const;
export type Gender = (typeof GENDERS)[number];
export type ProviderKind = "elevenlabs" | "openai-speech";

export interface VoiceProvider {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly keyEnv: string | null;
}
export interface VoiceBackend {
  readonly provider: string;
  readonly voiceId: string;
  readonly model: string;
  /** e.g. { fa: "eleven_v3" } — a different upstream model for one language. */
  readonly modelByLanguage: Readonly<Record<string, string>>;
}
export interface VoiceDef {
  readonly ownerAgent: string | null;
  readonly gender: Gender;
  readonly accent: string;
  readonly languages: readonly string[];
  /** Empty until the Founder has tested the language. Unverified languages never speak. */
  readonly verifiedLanguages: readonly string[];
  readonly chain: readonly VoiceBackend[];
}
export interface VoiceConfig {
  readonly clientUrl: string;
  readonly clientTimeoutMs: number;
  readonly providers: Readonly<Record<string, VoiceProvider>>;
  readonly voices: Readonly<Record<string, VoiceDef>>;
  readonly perAgentDailyCharCap: number;
  readonly maxTextChars: number;
  readonly upstreamTimeoutMs: number;
}
export interface VoicePlan {
  readonly voice: string;
  readonly language: string;
  readonly text: string;
}

export class VoiceConfigError extends Error {
  constructor(message: string) {
    super(`Voice config: ${message}`);
    this.name = "VoiceConfigError";
  }
}
export class VoiceRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "VoiceRefusal";
    this.status = status;
  }
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function checkUrl(label: string, raw: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new VoiceConfigError(`${label}: not a valid URL`);
  }
  if (url.username || url.password) throw new VoiceConfigError(`${label}: must not contain credentials`);
  if (url.search || url.hash) throw new VoiceConfigError(`${label}: must not carry a query or fragment`);
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !local) throw new VoiceConfigError(`${label}: must use https (plain http only on this device)`);
  return url;
}

function parseProvider(name: string, raw: unknown): VoiceProvider {
  if (!isObj(raw)) throw new VoiceConfigError(`provider ${name} is not an object`);
  if (raw.kind !== "elevenlabs" && raw.kind !== "openai-speech") {
    throw new VoiceConfigError(`provider ${name}: kind must be "elevenlabs" or "openai-speech"`);
  }
  const url = checkUrl(`provider ${name} baseUrl`, raw.baseUrl);
  const keyEnv = (raw.keyEnv === undefined ? null : raw.keyEnv) as string | null;
  if (keyEnv !== null && (typeof keyEnv !== "string" || !KEY_ENV_RE.test(keyEnv))) {
    throw new VoiceConfigError(`provider ${name}: keyEnv must be null or a NEXUS_KEY_... variable name (never the key itself)`);
  }
  const local = url.protocol === "http:";
  if (keyEnv === null && !local) throw new VoiceConfigError(`provider ${name}: a remote provider needs a keyEnv`);
  return Object.freeze({ kind: raw.kind, baseUrl: url.toString().replace(/\/+$/, ""), keyEnv });
}

function parseVoice(name: string, raw: unknown, agents: readonly string[], providers: Record<string, VoiceProvider>): VoiceDef {
  if (!VOICE_NAME_RE.test(name)) throw new VoiceConfigError(`voice name "${name}" is not allowed`);
  if (!isObj(raw)) throw new VoiceConfigError(`voice ${name} is not an object`);
  const owner = (raw.ownerAgent === undefined ? null : raw.ownerAgent) as string | null;
  if (owner !== null && (typeof owner !== "string" || !agents.includes(owner))) {
    throw new VoiceConfigError(`voice ${name}: ownerAgent must be null or a known agent`);
  }
  if (!GENDERS.includes(raw.gender as Gender)) throw new VoiceConfigError(`voice ${name}: gender must be female, male or neutral`);
  if (owner !== null && FEMALE_ONLY_AGENTS.includes(owner) && raw.gender !== "female") {
    throw new VoiceConfigError(`voice ${name}: ${owner} must have a female voice`);
  }
  if (typeof raw.accent !== "string" || !raw.accent.trim() || raw.accent.length > 64) throw new VoiceConfigError(`voice ${name}: accent required`);
  const langs = raw.languages;
  if (!Array.isArray(langs) || langs.length === 0 || !langs.every((l) => typeof l === "string" && LANG_RE.test(l))) {
    throw new VoiceConfigError(`voice ${name}: languages must be a non-empty list of language codes`);
  }
  const verified = raw.verifiedLanguages === undefined ? [] : raw.verifiedLanguages;
  if (!Array.isArray(verified) || !verified.every((l) => typeof l === "string" && langs.includes(l))) {
    throw new VoiceConfigError(`voice ${name}: verifiedLanguages must be a subset of languages`);
  }
  const chain = raw.chain;
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > 5) throw new VoiceConfigError(`voice ${name} needs 1 to 5 backends`);
  const backends = chain.map((b, i): VoiceBackend => {
    if (!isObj(b) || typeof b.provider !== "string" || !providers[b.provider]) {
      throw new VoiceConfigError(`voice ${name}, backend ${i + 1}: unknown provider`);
    }
    if (typeof b.voiceId !== "string" || !VOICE_ID_RE.test(b.voiceId)) throw new VoiceConfigError(`voice ${name}, backend ${i + 1}: bad voiceId`);
    if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) throw new VoiceConfigError(`voice ${name}, backend ${i + 1}: bad model id`);
    const mbl = b.modelByLanguage === undefined ? {} : b.modelByLanguage;
    if (!isObj(mbl) || !Object.entries(mbl).every(([k, v]) => /^[a-z]{2,3}$/.test(k) && typeof v === "string" && MODEL_RE.test(v))) {
      throw new VoiceConfigError(`voice ${name}, backend ${i + 1}: modelByLanguage must map language codes to model ids`);
    }
    return Object.freeze({ provider: b.provider, voiceId: b.voiceId, model: b.model, modelByLanguage: Object.freeze({ ...(mbl as Record<string, string>) }) });
  });
  return Object.freeze({
    ownerAgent: owner,
    gender: raw.gender as Gender,
    accent: raw.accent.trim(),
    languages: Object.freeze(langs.slice() as string[]),
    verifiedLanguages: Object.freeze(verified.slice() as string[]),
    chain: Object.freeze(backends),
  });
}

/** `agents` is the Control Plane's agent list (config.agents). */
export function parseVoiceConfig(raw: unknown, agents: readonly string[]): VoiceConfig {
  if (!isObj(raw)) throw new VoiceConfigError("not an object");
  const clientUrl = checkUrl("clientUrl", raw.clientUrl === undefined ? "http://127.0.0.1:4100/v1/nexus/voice" : raw.clientUrl);
  const clientTimeoutMs = raw.clientTimeoutMs === undefined ? 60_000 : raw.clientTimeoutMs;
  if (!isPositiveInt(clientTimeoutMs) || clientTimeoutMs > 300_000) throw new VoiceConfigError("clientTimeoutMs must be 1..300000");

  if (!isObj(raw.providers)) throw new VoiceConfigError("providers must be an object");
  const providers: Record<string, VoiceProvider> = {};
  for (const [n, p] of Object.entries(raw.providers)) {
    if (!NAME_RE.test(n)) throw new VoiceConfigError(`provider name "${n}" is not allowed`);
    providers[n] = parseProvider(n, p);
  }
  if (!isObj(raw.voices) || Object.keys(raw.voices).length === 0) throw new VoiceConfigError("voices must name at least one NEXUS voice");
  const voices: Record<string, VoiceDef> = {};
  for (const [n, v] of Object.entries(raw.voices)) voices[n] = parseVoice(n, v, agents, providers);

  if (!isPositiveInt(raw.perAgentDailyCharCap)) throw new VoiceConfigError("perAgentDailyCharCap must be a positive whole number");
  const maxTextChars = raw.maxTextChars === undefined ? 1000 : raw.maxTextChars;
  if (!isPositiveInt(maxTextChars) || maxTextChars > 5000) throw new VoiceConfigError("maxTextChars must be 1..5000");
  if (!isPositiveInt(raw.upstreamTimeoutMs) || raw.upstreamTimeoutMs > 120_000) throw new VoiceConfigError("upstreamTimeoutMs must be 1..120000");

  return Object.freeze({
    clientUrl: clientUrl.toString(),
    clientTimeoutMs,
    providers: Object.freeze(providers),
    voices: Object.freeze(voices),
    perAgentDailyCharCap: raw.perAgentDailyCharCap,
    maxTextChars,
    upstreamTimeoutMs: raw.upstreamTimeoutMs,
  });
}

/** Who may use which voice. Reserved agents use only their own; nobody takes a reserved voice. */
export function canUseVoice(cfg: VoiceConfig, agent: string, voice: string): boolean {
  const v = Object.prototype.hasOwnProperty.call(cfg.voices, voice) ? cfg.voices[voice] : undefined;
  if (!v) return false;
  if (v.ownerAgent !== null) return v.ownerAgent === agent;
  return !RESERVED_AGENTS.includes(agent); // library voices: not for the reserved agents, and the Orb stays silent
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MARKUP_RE = /<\s*\/?\s*(speak|voice|prosody|audio|break|say-as|phoneme)\b/i;

/** Validates the plan an agent signed. Throws VoiceRefusal(400). */
export function checkVoicePlan(cfg: VoiceConfig, raw: unknown): VoicePlan {
  if (!isObj(raw)) throw new VoiceRefusal(400, "missing plan");
  const { voice, language, text } = raw;
  if (typeof voice !== "string" || !Object.prototype.hasOwnProperty.call(cfg.voices, voice)) throw new VoiceRefusal(400, "unknown NEXUS voice");
  if (typeof language !== "string" || !LANG_RE.test(language)) throw new VoiceRefusal(400, "bad language");
  if (typeof text !== "string" || text.trim().length === 0) throw new VoiceRefusal(400, "text must not be empty");
  if (text.length > cfg.maxTextChars) throw new VoiceRefusal(400, `text is longer than ${cfg.maxTextChars} characters`);
  if (CONTROL_RE.test(text)) throw new VoiceRefusal(400, "text has control characters");
  if (MARKUP_RE.test(text)) throw new VoiceRefusal(400, "markup is not allowed in spoken text");
  return Object.freeze({ voice, language, text });
}

/** A language speaks only when the Founder has listed it as verified for that voice. */
export function languageVerified(cfg: VoiceConfig, plan: VoicePlan): boolean {
  return cfg.voices[plan.voice].verifiedLanguages.includes(plan.language);
}
