/**
 * Voice architecture — speech output, speech input and mouth movement.
 *
 * Engines are pluggable. The only engines shipped in Phase 1 are the
 * browser's Web Speech API engines (free, no API keys). A future local or
 * external engine implements the same SpeechEngine shape:
 *
 *   { id, available(): boolean, voices(): Voice[], speak(text, opts) -> handle, cancel() }
 *
 * Honest limits:
 *  - Browser voices cannot produce the Founder's specified accents (North
 *    Jersey / Persian / Kurdish). Each profile stores the target accent for a
 *    future engine; the browser engine only adjusts pitch and rate.
 *  - Mouth movement is a jaw-open envelope driven by word-boundary events
 *    when the browser fires them, otherwise by a syllable-rate oscillation
 *    while the engine reports it is speaking. It is NOT phoneme lip-sync.
 */

const g = typeof globalThis !== "undefined" ? globalThis : window;

// ---------------- speech output ----------------

export class BrowserSpeechEngine {
  constructor(synth = g.speechSynthesis, Utter = g.SpeechSynthesisUtterance) {
    this.id = "browser-web-speech";
    this.synth = synth;
    this.Utter = Utter;
    this._voices = [];
    if (this.available()) {
      this._voices = this.synth.getVoices() || [];
      this.synth.addEventListener?.("voiceschanged", () => { this._voices = this.synth.getVoices() || []; });
    }
  }
  available() { return !!(this.synth && this.Utter); }
  voices() { return this._voices; }
  /** Voices sometimes load late (Chrome/Android). Resolves after up to `ms`. */
  async ready(ms = 1500) {
    if (!this.available()) return [];
    const start = Date.now();
    while (this._voices.length === 0 && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 100));
      this._voices = this.synth.getVoices() || [];
    }
    return this._voices;
  }
  speak(text, { voice, rate = 1, pitch = 1, volume = 1, onStart, onEnd, onBoundary, onError } = {}) {
    const u = new this.Utter(text);
    if (voice) u.voice = voice;
    u.rate = rate; u.pitch = pitch; u.volume = volume;
    u.onstart = () => onStart?.();
    u.onend = () => onEnd?.();
    u.onerror = (e) => onError?.(e?.error || "unknown");
    u.onboundary = (e) => onBoundary?.(e);
    this.synth.speak(u);
    return u;
  }
  cancel() { if (this.available()) this.synth.cancel(); }
  speaking() { return !!this.synth?.speaking; }
}

/** Choose a browser voice for a profile; returns { voice, reason }. */
export function pickVoice(voices, profile, taken = []) {
  if (!voices || voices.length === 0) return { voice: null, reason: "Browser exposed no voices; it will use its default." };
  const english = voices.filter((v) => /^en/i.test(v.lang));
  const pool = english.length ? english : voices;
  const hints = profile.voice.voiceHints;
  const score = (v) => {
    let s = 0;
    hints.forEach((h, i) => { if (v.lang === h || v.name.includes(h)) s += (hints.length - i) * 2; });
    if (/female|woman|samantha|victoria|karen|moira|tessa|zira|aria|jenny/i.test(v.name)) s += 3;
    if (/male\b|daniel|fred|alex\b|david|mark\b|guy/i.test(v.name) && !/female/i.test(v.name)) s -= 6;
    if (taken.includes(v.name)) s -= 4;          // prefer distinct voices per character
    if (v.localService) s += 1;                  // works offline
    return s;
  };
  const best = [...pool].sort((a, b) => score(b) - score(a))[0];
  return { voice: best, reason: `Best available match for ${profile.name}: "${best.name}" (${best.lang}${best.localService ? ", on-device" : ", network voice"}).` };
}

/** Split text into sentence chunks — Chrome stops long utterances (~15 s). */
export function chunkText(text, max = 180) {
  const parts = String(text).replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) || [];
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ""; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------- mouth envelope ----------------

/**
 * Produces a 0..1 mouth-open value over time.
 * pulse() on each word boundary; while active with no recent boundaries it
 * falls back to a syllable-rate oscillation.
 */
export class MouthEnvelope {
  constructor(rng = Math.random) {
    this.rng = rng; this.active = false; this.value = 0; this.t = 0;
    this.lastPulse = -1; this.pulseLevel = 0; this.boundaryEvents = 0;
  }
  start() { this.active = true; this.t = 0; this.lastPulse = -1; }
  stop() { this.active = false; }
  pulse() { this.pulseLevel = 0.75 + this.rng() * 0.25; this.lastPulse = this.t; this.boundaryEvents++; }
  get mode() { return !this.active ? "silent" : (this.lastPulse >= 0 && this.t - this.lastPulse < 0.6 ? "word-boundaries" : "oscillation-fallback"); }
  update(dt) {
    this.t += dt;
    let target = 0;
    if (this.active) {
      if (this.mode === "word-boundaries") {
        const since = this.t - this.lastPulse;
        target = this.pulseLevel * Math.max(0, Math.sin(Math.min(Math.PI, since * 14)));
        target = Math.max(target, 0.12 + 0.12 * Math.abs(Math.sin(this.t * 17)));
      } else {
        const syl = Math.abs(Math.sin(this.t * Math.PI * 5.2));
        target = 0.15 + 0.6 * syl * (0.7 + 0.3 * Math.sin(this.t * 2.3));
      }
    }
    this.value += (target - this.value) * Math.min(1, dt * 22);
    if (!this.active && this.value < 0.01) this.value = 0;
    return this.value;
  }
}

// ---------------- voice controller ----------------

export class VoiceController {
  constructor(engine = new BrowserSpeechEngine()) {
    this.engine = engine;
    this.envelopes = new Map();      // characterId -> MouthEnvelope
    this.current = null;             // { characterId, id }
    this.listeners = new Set();
    this.assigned = new Map();       // characterId -> voice
    this.settings = new Map();       // characterId -> { rate, pitch, volume } chosen in the studio
    this.seq = 0;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, detail) { for (const fn of this.listeners) fn({ type, ...detail }); }

  envelope(id) {
    if (!this.envelopes.has(id)) this.envelopes.set(id, new MouthEnvelope());
    return this.envelopes.get(id);
  }

  /** Founder's chosen voice/pitch/rate/volume for a character (studio session). */
  configure(characterId, { voiceName, rate, pitch, volume } = {}) {
    if (voiceName !== undefined) {
      const v = this.engine.voices().find((x) => x.name === voiceName) || null;
      this.assigned.set(characterId, v);
    }
    const cur = this.settings.get(characterId) || {};
    this.settings.set(characterId, {
      ...cur,
      ...(rate !== undefined ? { rate: Math.min(2, Math.max(0.5, +rate)) } : {}),
      ...(pitch !== undefined ? { pitch: Math.min(2, Math.max(0, +pitch)) } : {}),
      ...(volume !== undefined ? { volume: Math.min(1, Math.max(0, +volume)) } : {}),
    });
    return this.settingsFor({ id: characterId, voice: {} });
  }
  settingsFor(profile) {
    const s = this.settings.get(profile.id) || {};
    const v = this.assigned.get(profile.id);
    return {
      voiceName: v ? v.name : null,
      rate: s.rate ?? profile.voice.browserRate ?? 1,
      pitch: s.pitch ?? profile.voice.browserPitch ?? 1,
      volume: s.volume ?? profile.voice.browserVolume ?? 1,
    };
  }

  async assignVoices(profiles) {
    await this.engine.ready?.();
    const taken = [];
    const report = {};
    for (const p of profiles) {
      const { voice, reason } = pickVoice(this.engine.voices(), p, taken);
      if (voice) taken.push(voice.name);
      this.assigned.set(p.id, voice);
      report[p.id] = { voice: voice ? `${voice.name} (${voice.lang})` : "browser default", onDevice: voice ? !!voice.localService : null, reason };
    }
    return report;
  }

  /**
   * Speak as a character. `label` says what is being spoken (e.g. "voice
   * test", "founder-established greeting") so the log never presents a test
   * line as the intelligence talking.
   */
  speak(profile, text, label = "voice test") {
    if (!this.engine.available()) {
      this.emit("speech-unavailable", { characterId: profile.id, reason: "This browser has no speech synthesis." });
      return null;
    }
    this.cancel("superseded");
    const id = ++this.seq;
    const env = this.envelope(profile.id);
    const chunks = chunkText(text);
    this.current = { characterId: profile.id, id, started: false };
    this.emit("speech-requested", { characterId: profile.id, id, text, label, chunks: chunks.length });
    const voice = this.assigned.get(profile.id) || null;
    const set = this.settingsFor(profile);
    let i = 0;
    const next = () => {
      if (!this.current || this.current.id !== id) return;
      if (i >= chunks.length) {
        env.stop();
        if (this.current.started) this.emit("speech-ended", { characterId: profile.id, id, boundaryEvents: env.boundaryEvents });
        else this.emit("speech-no-start", { characterId: profile.id, id, note: "The browser finished the request without ever reporting that speech started, so no speech is claimed." });
        this.current = null;
        return;
      }
      const chunk = chunks[i++];
      this.engine.speak(chunk, {
        voice, rate: set.rate, pitch: set.pitch, volume: set.volume,
        onStart: () => {
          if (!this.current || this.current.id !== id) return;
          if (!this.current.started) { this.current.started = true; env.boundaryEvents = 0; env.start(); this.emit("speech-started", { characterId: profile.id, id }); }
        },
        onBoundary: (e) => { if (!e || e.name === undefined || e.name === "word") env.pulse(); },
        onEnd: next,
        onError: (err) => {
          env.stop();
          if (err === "interrupted" || err === "canceled") return;
          this.emit("speech-error", { characterId: profile.id, id, error: err });
          this.current = null;
        },
      });
    };
    next();
    // If the engine never reports a start, say so rather than animating as if it spoke.
    setTimeout(() => {
      if (this.current && this.current.id === id && !this.current.started) {
        this.emit("speech-no-start", { characterId: profile.id, id, note: "Browser accepted the request but never reported speech starting (often needs a tap first on Android, or no voice installed)." });
      }
    }, 4000);
    return id;
  }

  cancel(reason = "stopped by user") {
    if (!this.current) { this.engine.cancel?.(); return false; }
    const { characterId, id } = this.current;
    this.current = null;
    this.engine.cancel();
    this.envelope(characterId).stop();
    this.emit("speech-cancelled", { characterId, id, reason });
    return true;
  }

  /** Advance all mouth envelopes; returns { characterId: value }. */
  update(dt) {
    const out = {};
    for (const [id, env] of this.envelopes) out[id] = env.update(dt);
    return out;
  }
}

// ---------------- speech input ----------------

export class SpeechListener {
  constructor(Rec = g.SpeechRecognition || g.webkitSpeechRecognition) {
    this.Rec = Rec; this.rec = null; this.listening = false;
  }
  available() { return !!this.Rec; }
  /**
   * Start listening once. Callbacks: onInterim(text), onFinal(text),
   * onError(code, explanation), onEnd().
   */
  start({ lang = "en-US", onInterim, onFinal, onError, onEnd } = {}) {
    if (!this.available()) { onError?.("unsupported", "This browser has no speech recognition."); return false; }
    if (this.listening) return true;
    const rec = new this.Rec();
    rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
      }
      if (interim) onInterim?.(interim);
      if (final) onFinal?.(final.trim());
    };
    rec.onerror = (e) => onError?.(e.error, EXPLAIN[e.error] || "Speech recognition error.");
    rec.onend = () => { this.listening = false; this.rec = null; onEnd?.(); };
    this.rec = rec; this.listening = true;
    try { rec.start(); } catch (err) { this.listening = false; onError?.("start-failed", String(err?.message || err)); return false; }
    return true;
  }
  stop() { if (this.rec) this.rec.stop(); }
  abort() { if (this.rec) this.rec.abort(); }
}

const EXPLAIN = {
  "not-allowed": "Microphone permission was denied, or the page is not on localhost/HTTPS.",
  "service-not-allowed": "The browser's speech service is blocked.",
  network: "Chrome's speech recognition needs an internet connection (it uses Google's servers).",
  "no-speech": "No speech was heard.",
  "audio-capture": "No microphone was found.",
  aborted: "Listening was stopped.",
  "language-not-supported": "This language is not supported.",
};
