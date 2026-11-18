import test from "node:test";
import assert from "node:assert/strict";

import { VoiceRefusal, canUseVoice, checkVoicePlan, languageVerified, parseVoiceConfig } from "../src/controlPlane/voiceConfig";

const AGENTS = ["genesis", "savannah", "aria", "orb", "teacher1"];

function good(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      eleven: { kind: "elevenlabs", baseUrl: "https://api.elevenlabs.io", keyEnv: "NEXUS_KEY_ELEVENLABS" },
      localtts: { kind: "openai-speech", baseUrl: "http://127.0.0.1:8090/v1", keyEnv: null },
    },
    voices: {
      "nexus-genesis": { ownerAgent: "genesis", gender: "female", accent: "North Jersey", languages: ["en-US"], verifiedLanguages: ["en-US"], chain: [{ provider: "eleven", voiceId: "abc", model: "eleven_multilingual_v2" }] },
      "nexus-savannah": { ownerAgent: "savannah", gender: "female", accent: "North Jersey", languages: ["en-US", "fa-IR"], chain: [{ provider: "eleven", voiceId: "def", model: "eleven_multilingual_v2", modelByLanguage: { fa: "eleven_v3" } }] },
      "scottish-teacher": { ownerAgent: null, gender: "male", accent: "Scottish", languages: ["en-GB"], verifiedLanguages: ["en-GB"], chain: [{ provider: "localtts", voiceId: "rory", model: "local" }] },
    },
    perAgentDailyCharCap: 5000,
    upstreamTimeoutMs: 30000,
    ...over,
  };
}

test("a good config parses; unverified languages default to none", () => {
  const cfg = parseVoiceConfig(good(), AGENTS);
  assert.equal(cfg.voices["nexus-savannah"].verifiedLanguages.length, 0);
  assert.equal(cfg.voices["nexus-savannah"].chain[0].modelByLanguage.fa, "eleven_v3");
  assert.equal(cfg.maxTextChars, 1000);
});

test("a key can never be written into the config", () => {
  const bad = good({ providers: { eleven: { kind: "elevenlabs", baseUrl: "https://api.elevenlabs.io", keyEnv: "sk-realkey123" } } });
  assert.throws(() => parseVoiceConfig(bad, AGENTS), /keyEnv/);
});

test("remote provider needs a key variable; plain http only on this device", () => {
  assert.throws(() => parseVoiceConfig(good({ providers: { eleven: { kind: "elevenlabs", baseUrl: "https://api.elevenlabs.io", keyEnv: null } } }), AGENTS), /needs a keyEnv/);
  assert.throws(() => parseVoiceConfig(good({ providers: { eleven: { kind: "elevenlabs", baseUrl: "http://example.com", keyEnv: "NEXUS_KEY_X" } } }), AGENTS), /https/);
  assert.throws(() => parseVoiceConfig(good({ providers: { eleven: { kind: "elevenlabs", baseUrl: "https://user:pw@api.elevenlabs.io", keyEnv: "NEXUS_KEY_X" } } }), AGENTS), /credentials/);
});

test("Genesis and Savannah voices must be female", () => {
  const g = good() as any;
  g.voices["nexus-genesis"].gender = "male";
  assert.throws(() => parseVoiceConfig(g, AGENTS), /female/);
});

test("verifiedLanguages must be a subset; unknown owner and unknown provider are refused", () => {
  const a = good() as any;
  a.voices["nexus-genesis"].verifiedLanguages = ["fr-FR"];
  assert.throws(() => parseVoiceConfig(a, AGENTS), /subset/);
  const b = good() as any;
  b.voices["nexus-genesis"].ownerAgent = "mole";
  assert.throws(() => parseVoiceConfig(b, AGENTS), /ownerAgent/);
  const c = good() as any;
  c.voices["nexus-genesis"].chain[0].provider = "nope";
  assert.throws(() => parseVoiceConfig(c, AGENTS), /unknown provider/);
});

test("who may use which voice", () => {
  const cfg = parseVoiceConfig(good(), AGENTS);
  assert.equal(canUseVoice(cfg, "genesis", "nexus-genesis"), true);
  assert.equal(canUseVoice(cfg, "savannah", "nexus-genesis"), false); // not hers
  assert.equal(canUseVoice(cfg, "teacher1", "nexus-genesis"), false); // reserved voice
  assert.equal(canUseVoice(cfg, "teacher1", "scottish-teacher"), true); // library voice
  assert.equal(canUseVoice(cfg, "genesis", "scottish-teacher"), false); // reserved agents only use their own
  assert.equal(canUseVoice(cfg, "orb", "scottish-teacher"), false); // the Orb stays silent
  assert.equal(canUseVoice(cfg, "teacher1", "does-not-exist"), false);
});

test("plan checks: unknown voice, empty, long, control characters, markup, bad language", () => {
  const cfg = parseVoiceConfig(good(), AGENTS);
  const ok = checkVoicePlan(cfg, { voice: "nexus-genesis", language: "en-US", text: "Welcome to NEXUS." });
  assert.equal(ok.text, "Welcome to NEXUS.");
  for (const bad of [
    { voice: "nope", language: "en-US", text: "hi" },
    { voice: "nexus-genesis", language: "en-US", text: "   " },
    { voice: "nexus-genesis", language: "en-US", text: "a".repeat(1001) },
    { voice: "nexus-genesis", language: "en-US", text: "hi\u0007" },
    { voice: "nexus-genesis", language: "en-US", text: "<speak>hi</speak>" },
    { voice: "nexus-genesis", language: "not a lang", text: "hi" },
    null,
  ]) {
    assert.throws(() => checkVoicePlan(cfg, bad), (e: unknown) => e instanceof VoiceRefusal && e.status === 400);
  }
});

test("a language speaks only when verified", () => {
  const cfg = parseVoiceConfig(good(), AGENTS);
  assert.equal(languageVerified(cfg, { voice: "nexus-genesis", language: "en-US", text: "x" }), true);
  assert.equal(languageVerified(cfg, { voice: "nexus-savannah", language: "fa-IR", text: "x" }), false);
});
