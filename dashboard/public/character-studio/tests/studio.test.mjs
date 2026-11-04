/**
 * Character Studio unit tests — run in Node (works in Termux):
 *   node --test dashboard/public/character-studio/tests/
 *
 * These exercise the real modules (profiles, builder, animation controller,
 * voice architecture, adapters, status registry) without a browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";
import { PROFILES, CHARACTER_IDS, getProfile } from "../src/characters/profiles.js";
import { buildCharacter } from "../src/characters/builder.js";
import { AnimationController, ARRIVE_EPS, wrapAngle, EXPRESSIONS } from "../src/animation/controller.js";
import { VoiceController, MouthEnvelope, chunkText, pickVoice } from "../src/voice/voice.js";
import { createAdapters, NOT_CONNECTED, CONNECTED } from "../src/conversation/adapters.js";
import { FEATURES, STATES } from "../src/status/status.js";

const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function sim(ctl, seconds, dt = 1 / 60) { for (let t = 0; t < seconds; t += dt) ctl.update(dt); }
function make(id, extra = {}) {
  const rig = buildCharacter(PROFILES[id]);
  const ctl = new AnimationController(rig, PROFILES[id], { boundsRadius: 5.7, rng: seeded(), ...extra });
  const events = [];
  ctl.on((e) => events.push(e));
  return { rig, ctl, events };
}

// ---------------- identities ----------------

test("three characters with the Founder's stated identities", () => {
  assert.deepEqual([...CHARACTER_IDS].sort(), ["aria", "genesis", "savannah"]);
  assert.equal(PROFILES.genesis.voice.greeting, "Hey. I'm here. What are we working on?");
  assert.equal(PROFILES.savannah.voice.greeting, "Hey. Savannah here. What's going on?");
  assert.match(PROFILES.genesis.appearance.eyes, /green/i);
  assert.match(PROFILES.savannah.appearance.eyes, /blue/i);
  assert.equal(PROFILES.savannah.heightM.value, 1.68);
  assert.ok(Object.isFrozen(PROFILES.genesis.palette), "profiles are immutable at runtime");
  assert.throws(() => getProfile("orb"));
});

test("not three skins: proportions, hair, suit cut, animation and voice all differ", () => {
  const keys = (p) => JSON.stringify([p.body, p.hairStyle, p.suitCut, p.animation, p.voice.browserPitch, p.heightM.value]);
  const set = new Set(CHARACTER_IDS.map((id) => keys(PROFILES[id])));
  assert.equal(set.size, 3);
  for (const field of ["hairStyle", "suitCut"]) assert.equal(new Set(CHARACTER_IDS.map((id) => PROFILES[id][field])).size, 3, field);
  assert.equal(new Set(CHARACTER_IDS.map((id) => PROFILES[id].animation.gesture)).size, 3);
  assert.ok(PROFILES.savannah.voice.browserPitch < PROFILES.genesis.voice.browserPitch, "Savannah's register is deeper than Genesis's");
});

test("built models differ in geometry, not just colour", () => {
  const stats = CHARACTER_IDS.map((id) => {
    const { rig } = make(id);
    let meshes = 0, verts = 0;
    rig.root.traverse((o) => { if (o.isMesh) { meshes++; verts += o.geometry.attributes.position.count; } });
    const box = new THREE.Box3().setFromObject(rig.root);
    return { id, meshes, verts, height: +(box.max.y - box.min.y).toFixed(3) };
  });
  assert.equal(new Set(stats.map((s) => s.verts)).size, 3, JSON.stringify(stats));
  // Height is measured to the top of the skull, as people are measured.
  for (const id of CHARACTER_IDS) {
    const { rig } = make(id);
    rig.root.updateMatrixWorld(true);
    const skull = rig.root.getObjectByName("cranium");
    const top = new THREE.Box3().setFromObject(skull).max.y;
    assert.ok(Math.abs(top - PROFILES[id].heightM.value) < 0.005, `${id} skull top ${top}`);
    const all = stats.find((s) => s.id === id).height;
    assert.ok(all < PROFILES[id].heightM.value + 0.2, `${id} with hair ${all} m`);
  }
  // Savannah's stated 5'6" = 1.68 m.
  assert.equal(PROFILES.savannah.heightM.value, 1.68);
});

test("procedural skeleton has every required joint", () => {
  const { rig } = make("genesis");
  for (const j of ["hips", "spine", "chest", "neck", "head", "shoulderL", "shoulderR", "elbowL", "elbowR", "wristL", "wristR", "hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR"]) {
    assert.ok(rig.joints[j]?.isObject3D, `missing joint ${j}`);
  }
  assert.equal(rig.face.eyes.length, 2);
  assert.equal(rig.face.lids.length, 2);
  assert.equal(rig.fingers.L.length, 5);
});

// ---------------- movement ----------------

test("idle animates (breathing/sway) without moving the character", () => {
  const { rig, ctl } = make("genesis");
  const a = rig.joints.chest.rotation.x;
  sim(ctl, 0.7);
  const b = rig.joints.chest.rotation.x;
  assert.notEqual(a, b, "chest pose changes over time");
  assert.equal(rig.root.position.length(), 0, "idle does not travel");
});

test("moveTo walks and reports a measured arrival", () => {
  const { ctl, events } = make("genesis");
  ctl.moveTo(2, 1.5);
  sim(ctl, 8);
  const arrived = events.find((e) => e.type === "arrived");
  assert.ok(arrived, "arrived event");
  const [x, z] = arrived.detail.position;
  assert.ok(Math.hypot(x - 2, z - 1.5) < ARRIVE_EPS, `measured ${x},${z}`);
  assert.ok(arrived.detail.error < ARRIVE_EPS);
  assert.ok(events.some((e) => e.type === "walk-start"));
  assert.ok(events.some((e) => e.type === "walk-stop"));
});

test("legs actually swing while walking", () => {
  const { rig, ctl } = make("aria");
  ctl.setDrive({ x: 0, z: 1 });
  let min = 0, max = 0;
  for (let i = 0; i < 120; i++) { ctl.update(1 / 60); const r = rig.joints.hipL.rotation.x; min = Math.min(min, r); max = Math.max(max, r); }
  assert.ok(max - min > 0.4, `hip swing range ${max - min}`);
  assert.ok(rig.root.position.z > 0.5, "drove forward");
});

test("stop halts and reports the real resting position", () => {
  const { rig, ctl, events } = make("savannah");
  ctl.moveTo(4, 0);
  sim(ctl, 1.0);
  ctl.stop();
  sim(ctl, 1.5);
  const stopped = events.filter((e) => e.type === "stopped").at(-1);
  assert.ok(stopped, "stopped event");
  assert.ok(!events.some((e) => e.type === "arrived"), "never claims arrival it did not make");
  const [x, z] = stopped.detail.position;
  assert.ok(Math.abs(x - rig.root.position.x) < 0.02 && Math.abs(z - rig.root.position.z) < 0.02);
  assert.ok(x < 3.5, "stopped well short of the target");
});

test("turn in place reaches the requested heading", () => {
  const { ctl, events } = make("genesis");
  ctl.turnBy(Math.PI / 2);
  sim(ctl, 3);
  const turned = events.find((e) => e.type === "turned");
  assert.ok(turned);
  assert.ok(Math.abs(wrapAngle(ctl.heading - Math.PI / 2)) < 0.035);
});

test("navigation course: every waypoint measured, course completes", () => {
  const { ctl, events } = make("genesis");
  ctl.runCourse([[0, 1], [1, 1], [1, 0], [0, 0]]);
  sim(ctl, 20);
  const done = events.find((e) => e.type === "course-complete");
  assert.ok(done, "course-complete");
  assert.equal(done.detail.reached, 4);
  assert.equal(events.filter((e) => e.type === "waypoint-reached").length, 4);
  assert.ok(done.detail.maxError < ARRIVE_EPS);
});

test("characters do not walk through each other; blocked is reported", () => {
  const other = { id: "aria", position: new THREE.Vector3(0, 0, 1.5) };
  const { ctl, events } = make("genesis", { getObstacles: () => [other] });
  ctl.moveTo(0, 3);
  sim(ctl, 5);
  assert.ok(events.some((e) => e.type === "blocked" && e.detail.by === "aria"));
  assert.ok(!events.some((e) => e.type === "arrived"));
  assert.ok(ctl.position.distanceTo(other.position) >= 0.5);
});

test("targets outside the stage are clamped and say so", () => {
  const { ctl, events } = make("genesis");
  ctl.moveTo(50, 0);
  assert.ok(events.some((e) => e.type === "target-clamped"));
  sim(ctl, 10);
  assert.ok(ctl.position.length() <= 5.7 + 1e-6);
});

test("gestures run and end; signature differs per character", () => {
  for (const id of CHARACTER_IDS) {
    const { rig, ctl, events } = make(id);
    sim(ctl, 0.2);
    const rest = rig.joints.elbowR.rotation.x;
    ctl.playGesture("signature");
    sim(ctl, 1.2);
    assert.ok(Math.abs(rig.joints.elbowR.rotation.x - rest) > 0.4 || Math.abs(rig.joints.head.rotation.z) > 0.05, `${id} gesture moved the arm`);
    sim(ctl, 3);
    const start = events.find((e) => e.type === "gesture-start");
    assert.equal(start.detail.gesture, PROFILES[id].animation.gesture);
    assert.ok(events.some((e) => e.type === "gesture-end"));
  }
});

test("look-around turns the head and returns; look-at aims at a point", () => {
  const { rig, ctl, events } = make("savannah");
  ctl.lookAround();
  let maxYaw = 0;
  for (let i = 0; i < 60 * 7; i++) { ctl.update(1 / 60); maxYaw = Math.max(maxYaw, Math.abs(rig.joints.head.rotation.y)); }
  assert.ok(maxYaw > 0.3, `head yaw reached ${maxYaw}`);
  assert.ok(events.some((e) => e.type === "look-around-end"));
  rig.root.updateMatrixWorld(true);
  ctl.lookAt(new THREE.Vector3(3, 1.6, 1));
  sim(ctl, 2);
  assert.ok(rig.joints.head.rotation.y > 0.3, "head turned toward +x target");
});

test("blinks happen and expressions move the brows", () => {
  const { rig, ctl } = make("genesis");
  sim(ctl, 12);
  assert.ok(ctl.blinkCount >= 2, `blinks: ${ctl.blinkCount}`);
  const y0 = rig.face.brows[0].position.y;
  ctl.setExpression("concerned");
  sim(ctl, 1);
  assert.ok(rig.face.brows[0].position.y > y0);
  assert.throws(() => ctl.setExpression("nonexistent"));
  assert.ok(Object.keys(EXPRESSIONS).length >= 5);
});

test("mouth value opens the jaw", () => {
  const { rig, ctl } = make("aria");
  ctl.setMouth(1);
  sim(ctl, 0.3);
  assert.ok(rig.face.jaw.rotation.x > 0.2);
  ctl.setMouth(0);
  sim(ctl, 0.5);
  assert.ok(rig.face.jaw.rotation.x < 0.03);
});

// ---------------- voice ----------------

/** A fake speech engine that behaves like the browser's (async start/end, boundaries). */
function fakeEngine({ boundaries = true, start = true } = {}) {
  const spoken = [];
  let cancelled = 0;
  const timers = new Set();
  return {
    spoken, get cancelled() { return cancelled; },
    available: () => true, voices: () => [{ name: "Test Female", lang: "en-US", localService: true }], ready: async () => [],
    speak(text, o) {
      spoken.push({ text, rate: o.rate, pitch: o.pitch, volume: o.volume });
      const t1 = setTimeout(() => { if (start) o.onStart?.(); if (boundaries) o.onBoundary?.({ name: "word" }); }, 5);
      const t2 = setTimeout(() => o.onEnd?.(), 25);
      timers.add(t1); timers.add(t2);
    },
    cancel() { cancelled++; for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("speech: start/end events, per-character settings, mouth moves while speaking", async () => {
  const eng = fakeEngine();
  const vc = new VoiceController(eng);
  const ev = [];
  vc.on((e) => ev.push(e.type));
  vc.configure("savannah", { pitch: 0.7, rate: 0.9, volume: 0.8 });
  vc.speak(PROFILES.savannah, "Hey. Savannah here. What's going on?", "founder greeting");
  await wait(10);
  assert.ok(ev.includes("speech-started"));
  let peak = 0;
  for (let i = 0; i < 20; i++) peak = Math.max(peak, vc.update(1 / 60).savannah);
  assert.ok(peak > 0.2, `mouth peak ${peak}`);
  await wait(120);
  assert.ok(ev.includes("speech-ended"));
  assert.deepEqual(eng.spoken[0].pitch, 0.7);
  assert.deepEqual(eng.spoken[0].volume, 0.8);
  // Genesis keeps her own defaults.
  vc.speak(PROFILES.genesis, "Hey. I'm here. What are we working on?");
  assert.equal(eng.spoken.at(-1).pitch, PROFILES.genesis.voice.browserPitch);
});

test("speech: interruption cancels and the mouth closes", async () => {
  const eng = fakeEngine();
  const vc = new VoiceController(eng);
  const ev = [];
  vc.on((e) => ev.push(e.type));
  vc.speak(PROFILES.aria, "One. Two. Three. Four.");
  await wait(8);
  assert.equal(vc.cancel("test"), true);
  assert.ok(ev.includes("speech-cancelled"));
  assert.ok(!ev.includes("speech-ended"), "a cancelled line is not reported as finished");
  let v = 1;
  for (let i = 0; i < 60; i++) v = vc.update(1 / 60).aria;
  assert.ok(v < 0.02);
});

test("speech: if the engine never starts, the studio says so", async () => {
  const eng = fakeEngine({ start: false });
  const vc = new VoiceController(eng);
  const ev = [];
  vc.on((e) => ev.push(e.type));
  vc.speak(PROFILES.genesis, "Hello.");
  await wait(60);
  assert.ok(ev.includes("speech-no-start"));
  assert.ok(!ev.includes("speech-ended"), "an utterance that never started is not reported as spoken");
  assert.ok(!ev.includes("speech-started"));
});

test("mouth envelope falls back to oscillation without word boundaries", () => {
  const m = new MouthEnvelope(seeded());
  m.start();
  let peak = 0;
  for (let i = 0; i < 60; i++) peak = Math.max(peak, m.update(1 / 60));
  assert.equal(m.mode, "oscillation-fallback");
  assert.ok(peak > 0.3);
});

test("long text is chunked for browser engines", () => {
  const long = "This is a sentence. ".repeat(30);
  const parts = chunkText(long, 180);
  assert.ok(parts.length > 2);
  assert.ok(parts.every((p) => p.length <= 200));
});

test("voice picking prefers distinct voices per character", () => {
  const voices = [{ name: "Samantha", lang: "en-US", localService: true }, { name: "Google US English", lang: "en-US", localService: false }, { name: "Daniel", lang: "en-GB", localService: true }];
  const g = pickVoice(voices, PROFILES.genesis).voice;
  const s = pickVoice(voices, PROFILES.savannah, [g.name]).voice;
  assert.notEqual(g.name, s.name);
  assert.equal(pickVoice([], PROFILES.aria).voice, null);
});

// ---------------- intelligence boundaries ----------------

test("every intelligence reports NOT CONNECTED and produces no reply", async () => {
  const ads = createAdapters();
  for (const id of CHARACTER_IDS) {
    assert.equal(ads[id].status().state, NOT_CONNECTED);
    const r = await ads[id].ask("Build me a login page.");
    assert.equal(r.connected, false);
    assert.equal(r.reply, null);
  }
  assert.match(ads.genesis.reason, /Orb/, "Genesis/Orb dependency is disclosed");
  assert.match(ads.aria.reason, /not registered/i);
});

test("the studio cannot perform actions for any character", () => {
  const ads = createAdapters();
  for (const id of CHARACTER_IDS) {
    const r = ads[id].requestAction("fs.write project:anything");
    assert.equal(r.allowed, false);
  }
});

test("a transport is only CONNECTED after a matching, successful handshake", async () => {
  const ads = createAdapters();
  await ads.genesis.attach({ handshake: async () => ({ ok: true, runtime: "orb" }), ask: async () => ({ reply: "x" }) });
  assert.equal(ads.genesis.status().state, NOT_CONNECTED, "wrong runtime identity is rejected");
  await ads.savannah.attach({ handshake: async () => { throw new Error("refused"); }, ask: async () => ({ reply: "x" }) });
  assert.equal(ads.savannah.status().state, NOT_CONNECTED);
  await ads.aria.attach({ handshake: async () => ({ ok: true, runtime: "aria" }), ask: async (t) => ({ reply: "heard: " + t }) });
  assert.equal(ads.aria.status().state, CONNECTED);
  assert.equal((await ads.aria.ask("hi")).reply, "heard: hi");
});

test("status registry never marks an intelligence feature as working", () => {
  const intel = FEATURES.filter((f) => f.area === "Intelligence");
  assert.ok(intel.length >= 4);
  for (const f of intel) assert.ok([STATES.NOT_CONNECTED, STATES.NOT_STARTED].includes(f.state), f.name);
  assert.ok(FEATURES.some((f) => /lip-sync/i.test(f.name) && f.state === STATES.NOT_STARTED));
  assert.ok(FEATURES.some((f) => /accent/i.test(f.name) && f.state === STATES.NOT_STARTED));
});
