import test from "node:test";
import assert from "node:assert/strict";

import { callVoiceBackends, modelFor } from "../src/controlPlane/voiceBackends";
import type { AudioFetch } from "../src/controlPlane/voiceBackends";
import { VoiceRefusal, parseVoiceConfig } from "../src/controlPlane/voiceConfig";

const AGENTS = ["genesis", "teacher1"];
function cfg(timeout = 30000) {
  return parseVoiceConfig(
    {
      providers: {
        eleven: { kind: "elevenlabs", baseUrl: "https://api.elevenlabs.io", keyEnv: "NEXUS_KEY_ELEVENLABS" },
        localtts: { kind: "openai-speech", baseUrl: "http://127.0.0.1:8090/v1", keyEnv: null },
      },
      voices: {
        "nexus-genesis": {
          ownerAgent: "genesis", gender: "female", accent: "North Jersey", languages: ["en-US", "fa-IR"], verifiedLanguages: ["en-US", "fa-IR"],
          chain: [
            { provider: "eleven", voiceId: "VID", model: "eleven_multilingual_v2", modelByLanguage: { fa: "eleven_v3" } },
            { provider: "localtts", voiceId: "piper-x", model: "local" },
          ],
        },
      },
      perAgentDailyCharCap: 5000,
      upstreamTimeoutMs: timeout,
    },
    AGENTS
  );
}
const plan = { voice: "nexus-genesis", language: "en-US", text: "Welcome to NEXUS." };
const audio = (n = 4) => new Uint8Array(n).fill(7).buffer;
const reply = (status: number, bytes: ArrayBuffer = audio()) => ({ status, arrayBuffer: async () => bytes });

test("elevenlabs request: URL, key header, model; no key in result", async () => {
  let seen: any;
  const f: AudioFetch = async (url, init) => { seen = { url, init }; return reply(200); };
  const r = await callVoiceBackends(cfg(), plan, { NEXUS_KEY_ELEVENLABS: "SECRET" }, f);
  assert.match(seen.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/VID\?output_format=mp3_44100_128$/);
  assert.equal(seen.init.headers["xi-api-key"], "SECRET");
  assert.deepEqual(JSON.parse(seen.init.body), { text: plan.text, model_id: "eleven_multilingual_v2" });
  assert.equal(r.mime, "audio/mpeg");
  assert.equal(r.provider, "eleven");
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
});

test("Persian picks the v3 model", () => {
  const be = cfg().voices["nexus-genesis"].chain[0];
  assert.equal(modelFor(be, "fa-IR"), "eleven_v3");
  assert.equal(modelFor(be, "en-US"), "eleven_multilingual_v2");
});

test("busy or unreachable falls to the next backend", async () => {
  const urls: string[] = [];
  const f: AudioFetch = async (url) => { urls.push(url); if (url.includes("elevenlabs")) return reply(503); return reply(200); };
  const r = await callVoiceBackends(cfg(), plan, { NEXUS_KEY_ELEVENLABS: "k" }, f);
  assert.equal(r.provider, "localtts");
  assert.match(urls[1], /\/audio\/speech$/);
  const g: AudioFetch = async (url) => { if (url.includes("elevenlabs")) throw new Error("down"); return reply(200); };
  assert.equal((await callVoiceBackends(cfg(), plan, { NEXUS_KEY_ELEVENLABS: "k" }, g)).provider, "localtts");
});

test("a missing key skips that backend; none configured is a 503", async () => {
  const f: AudioFetch = async () => reply(200);
  assert.equal((await callVoiceBackends(cfg(), plan, {}, f)).provider, "localtts");
  const only = parseVoiceConfig(
    { providers: { eleven: { kind: "elevenlabs", baseUrl: "https://api.elevenlabs.io", keyEnv: "NEXUS_KEY_ELEVENLABS" } },
      voices: { "nexus-genesis": { ownerAgent: "genesis", gender: "female", accent: "x", languages: ["en-US"], verifiedLanguages: ["en-US"], chain: [{ provider: "eleven", voiceId: "V", model: "m" }] } },
      perAgentDailyCharCap: 1, upstreamTimeoutMs: 1000 }, AGENTS);
  await assert.rejects(callVoiceBackends(only, plan, {}, f), (e: unknown) => e instanceof VoiceRefusal && e.status === 503);
});

test("a timeout never falls back (it may already have been paid)", async () => {
  let calls = 0;
  const f: AudioFetch = (_url, init) => { calls++; return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))); };
  await assert.rejects(callVoiceBackends(cfg(20), plan, { NEXUS_KEY_ELEVENLABS: "k" }, f), (e: unknown) => e instanceof VoiceRefusal && e.status === 504);
  assert.equal(calls, 1);
});

test("a real failure is a 502 with status only, never the key", async () => {
  const f: AudioFetch = async () => reply(401);
  await assert.rejects(callVoiceBackends(cfg(), plan, { NEXUS_KEY_ELEVENLABS: "SECRET" }, f), (e: unknown) => {
    return e instanceof VoiceRefusal && e.status === 502 && !e.message.includes("SECRET");
  });
});

test("empty audio and oversized audio are refused", async () => {
  await assert.rejects(callVoiceBackends(cfg(), plan, { NEXUS_KEY_ELEVENLABS: "k" }, async () => reply(200, new ArrayBuffer(0))), /voice backend failed/);
  await assert.rejects(callVoiceBackends(cfg(), plan, { NEXUS_KEY_ELEVENLABS: "k" }, async () => reply(200, new ArrayBuffer(7 * 1024 * 1024))), /too much audio/);
});

test("events never carry text or keys", async () => {
  const events: Record<string, unknown>[] = [];
  const f: AudioFetch = async (url) => (url.includes("elevenlabs") ? reply(429) : reply(200));
  await callVoiceBackends(cfg(), plan, { NEXUS_KEY_ELEVENLABS: "SECRET" }, f, (e) => events.push(e));
  const dump = JSON.stringify(events);
  assert.equal(dump.includes("SECRET"), false);
  assert.equal(dump.includes("Welcome"), false);
  assert.equal(events[0].type, "voice-backend-busy");
});
