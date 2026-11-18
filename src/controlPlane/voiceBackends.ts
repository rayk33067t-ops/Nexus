/**
 * Calling a voice backend (pure apart from the injected fetch and event callback).
 *
 * Same fallback rule as the model route: fall to the next backend only when the first
 * certainly did not run it (unreachable, or busy 429/502/503). A timeout NEVER falls back,
 * because the first backend may already have been paid. Keys come from `env` at call time and
 * are never logged, stored, returned or put in an error message.
 */
import type { VoiceBackend, VoiceConfig, VoicePlan, VoiceProvider } from "./voiceConfig";
import { VoiceRefusal } from "./voiceConfig";

const BUSY = new Set([429, 502, 503]);
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

export type AudioFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface Spoken {
  readonly audio: Buffer;
  readonly mime: string;
  readonly provider: string;
}

export function modelFor(backend: VoiceBackend, language: string): string {
  const base = language.split("-")[0];
  return backend.modelByLanguage[base] ?? backend.model;
}

function buildRequest(provider: VoiceProvider, backend: VoiceBackend, plan: VoicePlan, key: string | null | undefined) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.kind === "elevenlabs") {
    if (key) headers["xi-api-key"] = key;
    return {
      url: `${provider.baseUrl}/v1/text-to-speech/${encodeURIComponent(backend.voiceId)}?output_format=mp3_44100_128`,
      headers,
      body: JSON.stringify({ text: plan.text, model_id: modelFor(backend, plan.language) }),
      mime: "audio/mpeg",
    };
  }
  // "openai-speech": the OpenAI-style /audio/speech shape that many local TTS servers copy.
  if (key) headers.authorization = `Bearer ${key}`;
  return {
    url: `${provider.baseUrl}/audio/speech`,
    headers,
    body: JSON.stringify({ model: modelFor(backend, plan.language), input: plan.text, voice: backend.voiceId, response_format: "mp3" }),
    mime: "audio/mpeg",
  };
}

export async function callVoiceBackends(
  cfg: VoiceConfig,
  plan: VoicePlan,
  env: Record<string, string | undefined>,
  doFetch: AudioFetch,
  onEvent: (e: Record<string, unknown>) => void = () => {}
): Promise<Spoken> {
  const chain = cfg.voices[plan.voice].chain;
  let configured = 0;
  for (const backend of chain) {
    const provider = cfg.providers[backend.provider];
    const key = provider.keyEnv ? env[provider.keyEnv] : null;
    if (provider.keyEnv && !key) continue; // not set up on this device: skip, never guess
    configured += 1;
    const req = buildRequest(provider, backend, plan, key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
    let status = 0;
    let bytes: ArrayBuffer | null = null;
    try {
      const res = await doFetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: controller.signal });
      status = res.status;
      if (status === 200) bytes = await res.arrayBuffer();
    } catch {
      if (controller.signal.aborted) {
        onEvent({ type: "voice-backend-timeout", voice: plan.voice, provider: backend.provider });
        throw new VoiceRefusal(504, "the voice did not answer in time (not retried: it may already have run)");
      }
      onEvent({ type: "voice-backend-unreachable", voice: plan.voice, provider: backend.provider });
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (BUSY.has(status)) {
      onEvent({ type: "voice-backend-busy", voice: plan.voice, provider: backend.provider, status });
      continue;
    }
    if (status !== 200 || !bytes || bytes.byteLength === 0) {
      onEvent({ type: "voice-backend-error", voice: plan.voice, provider: backend.provider, status });
      throw new VoiceRefusal(502, `the voice backend failed (HTTP ${status})`);
    }
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      onEvent({ type: "voice-backend-error", voice: plan.voice, provider: backend.provider, status: 413 });
      throw new VoiceRefusal(502, "the voice backend returned too much audio");
    }
    return { audio: Buffer.from(bytes), mime: req.mime, provider: backend.provider };
  }
  if (configured === 0) throw new VoiceRefusal(503, `no backend is set up for ${plan.voice} on this device`);
  throw new VoiceRefusal(503, `every backend for ${plan.voice} is unreachable or busy`);
}
