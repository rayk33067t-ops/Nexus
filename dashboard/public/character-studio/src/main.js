/**
 * NEXUS Character Development Studio — boot and wiring.
 * Connects the separate modules; holds no character logic of its own.
 */
import * as THREE from "../vendor/three.module.min.js";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { buildEnvironment, STAGE_RADIUS } from "./scene/environment.js";
import { PROFILES, CHARACTER_IDS } from "./characters/profiles.js";
import { buildCharacter } from "./characters/builder.js";
import { AnimationController, EXPRESSIONS } from "./animation/controller.js";
import { VoiceController, SpeechListener } from "./voice/voice.js";
import { createAdapters, NOT_CONNECTED } from "./conversation/adapters.js";
import { FEATURES, summarize, detectCapabilities } from "./status/status.js";

// ---------- small DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const hex = (n) => "#" + n.toString(16).padStart(6, "0");
const store = {
  get(k, d) { try { const v = localStorage.getItem("nexus-studio:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("nexus-studio:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------- renderer / scene / camera ----------
const canvas = document.getElementById("stage");
const caps = detectCapabilities(window);
const isPhone = caps.touch || Math.min(innerWidth, innerHeight) < 600;
let quality = store.get("quality", isPhone ? "phone" : "high");

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === "high", powerPreference: "high-performance" });
} catch (err) {
  document.body.append(h("div", { class: "toast show", style: "top:40%" }, "WebGL could not start on this device: " + (err?.message || err)));
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, quality === "high" ? 2 : 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = quality === "high" ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 80);
camera.position.set(0, 1.7, 6.2);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.45;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI * 0.53;
controls.target.set(0, 1.0, 0);
controls.autoRotateSpeed = 1.2;

const world = buildEnvironment(scene, renderer, { quality: quality === "high" ? "high" : "low" });

// ---------- characters ----------
const START = { savannah: [-1.9, 0.25], genesis: [0, 0], aria: [1.9, 0.25] };
const chars = {};
for (const id of ["savannah", "genesis", "aria"]) {
  const p = PROFILES[id];
  const rig = buildCharacter(p);
  rig.root.position.set(START[id][0], 0, START[id][1]);
  scene.add(rig.root);
  world.addPad(id, START[id][0], START[id][1], p.palette.pad);
  chars[id] = { profile: p, rig, ctl: null };
}
const obstacles = () => CHARACTER_IDS.map((id) => ({ id, position: chars[id].rig.root.position }));
for (const id of CHARACTER_IDS) {
  chars[id].ctl = new AnimationController(chars[id].rig, chars[id].profile, { boundsRadius: STAGE_RADIUS - 0.45, getObstacles: obstacles });
}

// ---------- systems ----------
const voice = new VoiceController();
const listener = new SpeechListener();
const adapters = createAdapters();
const voiceReport = { pending: true };
voice.assignVoices(CHARACTER_IDS.map((id) => PROFILES[id])).then((r) => { Object.assign(voiceReport, r, { pending: false }); if (activeTab === "Voice") renderTab(); });

// ---------- event log ----------
const LOG = [];
const t0 = performance.now();
function log(source, type, detail = {}) {
  const entry = { t: ((performance.now() - t0) / 1000).toFixed(1), source, type, detail };
  LOG.push(entry);
  if (LOG.length > 400) LOG.shift();
  if (activeTab === "Log") appendLogLine(entry);
}
for (const id of CHARACTER_IDS) chars[id].ctl.on((ev) => log(ev.character, ev.type, ev.detail));
voice.on((ev) => {
  log(ev.characterId || "studio", ev.type, { ...ev, type: undefined, characterId: undefined });
  if (ev.type === "speech-error") toast(`Speech error: ${ev.error}`);
  if (ev.type === "speech-no-start") toast(ev.note);
  if (ev.type === "speech-unavailable") toast(ev.reason);
  if (activeTab === "Voice") updateSpeakingState();
});

// ---------- selection ----------
let selected = store.get("selected", "genesis");
if (!chars[selected]) selected = "genesis";
let follow = false;
let lookAtCamera = false;
let tapToWalk = false;

const chipsEl = document.getElementById("chips");
function renderChips() {
  chipsEl.replaceChildren(...CHARACTER_IDS.map((id) => {
    const p = PROFILES[id];
    return h("button", { class: "chip" + (id === selected ? " active" : ""), "data-id": id, type: "button", onclick: () => select(id) },
      h("span", { class: "dot", style: `background:${hex(p.palette.pad)}` }), h("b", {}, p.name), h("small", {}, p.title));
  }));
}
function select(id, { frame = true } = {}) {
  if (!chars[id]) return;
  if (lookAtCamera) chars[selected].ctl.lookAt(null, "studio");
  selected = id;
  store.set("selected", id);
  world.highlightPad(id);
  renderChips();
  if (lookAtCamera) chars[id].ctl.lookAt(camera.position, "camera toggle");
  if (frame) frameView("full");
  log("studio", "select", { character: id });
  renderTab();
}

// ---------- camera views ----------
const camAnim = { active: false, fromP: new THREE.Vector3(), toP: new THREE.Vector3(), fromT: new THREE.Vector3(), toT: new THREE.Vector3(), t: 0 };
function frameView(kind) {
  const c = chars[selected];
  const pos = c.rig.root.position, H = c.profile.heightM.value, hd = c.ctl.heading;
  const fwd = new THREE.Vector3(Math.sin(hd), 0, Math.cos(hd));
  const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
  const v = visibleRect();
  const visFrac = (v.y1 - v.y0) / innerHeight;          // share of the screen height we can use
  const fit = (size) => (size / visFrac) / (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.min(1, camera.aspect * 1.6);
    let target, eye;
  if (kind === "face") {
    target = new THREE.Vector3(pos.x, c.rig.dims.eyeHeightWorld - 0.02, pos.z);
    eye = target.clone().addScaledVector(fwd, Math.max(0.45, fit(0.36))).add(new THREE.Vector3(0, 0.02, 0));
  } else if (kind === "side") {
    target = new THREE.Vector3(pos.x, H * 0.55, pos.z);
    eye = target.clone().addScaledVector(side, fit(H * 1.15));
  } else if (kind === "back") {
    target = new THREE.Vector3(pos.x, H * 0.55, pos.z);
    eye = target.clone().addScaledVector(fwd, -fit(H * 1.15));
  } else {
    target = new THREE.Vector3(pos.x, H * 0.55, pos.z);
    eye = target.clone().addScaledVector(fwd, fit(H * 1.08)).add(new THREE.Vector3(0, 0.25, 0));
  }
  Object.assign(camAnim, { active: true, t: 0, start: performance.now() });
  camAnim.fromP.copy(camera.position); camAnim.toP.copy(eye);
  camAnim.fromT.copy(controls.target); camAnim.toT.copy(target);
}
controls.addEventListener("start", () => { camAnim.active = false; });

// ---------- tap: select a character or walk to a floor point ----------
const ray = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const quick = performance.now() - downAt.t < 400;
  downAt = null;
  if (moved > 8 || !quick) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(CHARACTER_IDS.map((id) => chars[id].rig.root), true);
  if (hits.length) { const id = hits[0].object.userData.characterId; if (id && id !== selected) select(id, { frame: false }); return; }
  if (tapToWalk) {
    const f = ray.intersectObject(world.floor, false)[0];
    if (f) chars[selected].ctl.moveTo(f.point.x, f.point.z, "tap on floor");
  }
});

// ---------- keyboard ----------
const keys = new Set();
addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) { keys.add(k); e.preventDefault(); }
  if (k === " ") { chars[selected].ctl.stop("keyboard"); e.preventDefault(); }
  if (k === "1" || k === "2" || k === "3") select(["savannah", "genesis", "aria"][+k - 1]);
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
let keyDriving = false;

/** Camera-relative stick (x right, y up) → world XZ direction. */
function stickToWorld(x, y) {
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  return { x: right.x * x + fwd.x * y, z: right.z * x + fwd.z * y };
}

// ---------- joystick ----------
const joy = document.getElementById("joystick");
const knob = joy.querySelector(".knob");
let joyId = null;
function joyMove(e) {
  const r = joy.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2 - 12, len = Math.hypot(dx, dy);
  if (len > max) { dx *= max / len; dy *= max / len; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const mag = Math.min(1, len / max);
  chars[selected].ctl.setDrive(mag < 0.15 ? null : stickToWorld((dx / max), -(dy / max)), "joystick");
}
joy.addEventListener("pointerdown", (e) => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); joyMove(e); });
joy.addEventListener("pointermove", (e) => { if (e.pointerId === joyId) joyMove(e); });
const joyEnd = (e) => { if (e.pointerId !== joyId) return; joyId = null; knob.style.transform = ""; chars[selected].ctl.setDrive(null, "joystick"); };
joy.addEventListener("pointerup", joyEnd);
joy.addEventListener("pointercancel", joyEnd);

// ---------- toast ----------
const toastEl = document.getElementById("toast");
let toastTimer;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3800); }

// ---------- panel & tabs ----------
const TABS = ["Profile", "Move", "Voice", "Talk", "Status", "Log"];
let activeTab = store.get("tab", "Profile");
if (!TABS.includes(activeTab)) activeTab = "Profile";
const tabsEl = document.getElementById("tabs");
const body = document.getElementById("tabbody");
const panel = document.getElementById("panel");
document.getElementById("grip").addEventListener("click", () => {
  panel.classList.toggle("collapsed");
  document.body.classList.toggle("collapsed", panel.classList.contains("collapsed"));
  setTimeout(() => { onResize(); frameView("full"); }, 280);
});

function renderTabs() {
  tabsEl.replaceChildren(...TABS.map((t) => h("button", { class: "tab" + (t === activeTab ? " active" : ""), role: "tab", type: "button", onclick: () => { activeTab = t; store.set("tab", t); renderTabs(); renderTab(); } }, t)));
  joy.hidden = activeTab !== "Move";
}
const sec = (title, ...kids) => h("div", { class: "sec" }, h("h3", {}, title), ...kids);
const badge = (s) => h("span", { class: "badge", "data-s": s }, s);

function renderTab() {
  const c = chars[selected], p = c.profile, ctl = c.ctl;
  body.replaceChildren();
  if (activeTab === "Profile") {
    const ap = p.appearance;
    body.append(
      h("div", { class: "title-line" }, h("h2", {}, p.name), h("span", {}, p.title)),
      h("p", { class: "note" }, p.role),
      h("div", { class: "swatches" }, ...["suit", "hair", "hairHighlight", "iris", "accent", "accent2"].map((k) => h("i", { title: k, style: `background:${hex(p.palette[k])}` }))),
      sec("Identity", h("dl", { class: "kv" },
        h("dt", {}, "Height"), h("dd", {}, `${p.heightM.value.toFixed(2)} m${p.heightM.note ? " (" + p.heightM.note + ")" : ""}`, p.heightM.founderConfirmed ? "" : h("span", { class: "note warn" }, " · studio default")),
        h("dt", {}, "Age"), h("dd", {}, p.apparentAge),
        h("dt", {}, "Eyes"), h("dd", {}, ap.eyes),
        h("dt", {}, "Hair"), h("dd", {}, ap.hair),
        h("dt", {}, "Outfit"), h("dd", {}, ap.outfit),
        h("dt", {}, "Accents"), h("dd", {}, ap.accents),
        h("dt", {}, "Presence"), h("dd", {}, ap.presence))),
      sec("Build (this character's own configuration)", h("dl", { class: "kv" },
        h("dt", {}, "Proportions"), h("dd", {}, `shoulders ${p.body.shoulders} · hips ${p.body.hips} · legs ${p.body.legRatio} · neck ${p.body.neck}`),
        h("dt", {}, "Hair build"), h("dd", {}, p.hairStyle),
        h("dt", {}, "Suit cut"), h("dd", {}, p.suitCut),
        h("dt", {}, "Animation"), h("dd", {}, `tempo ${p.animation.tempo} · sway ${p.animation.idleSway} · look ${p.animation.lookFrequency} · signature "${p.animation.gesture}"`))),
      sec("Intelligence", connBox(selected)),
      sec("Camera",
        h("div", { class: "grid2" },
          h("button", { type: "button", onclick: () => frameView("full") }, "Full body"),
          h("button", { type: "button", onclick: () => frameView("face") }, "Face close-up"),
          h("button", { type: "button", onclick: () => frameView("side") }, "Side"),
          h("button", { type: "button", onclick: () => frameView("back") }, "Back"),
          h("button", { type: "button", class: controls.autoRotate ? "on" : "", onclick: (e) => { controls.autoRotate = !controls.autoRotate; e.target.classList.toggle("on", controls.autoRotate); if (controls.autoRotate) controls.target.copy(new THREE.Vector3(c.rig.root.position.x, p.heightM.value * 0.55, c.rig.root.position.z)); } }, "Orbit inspect"),
          h("button", { type: "button", class: follow ? "on" : "", onclick: (e) => { follow = !follow; e.target.classList.toggle("on", follow); } }, "Follow")),
        h("p", { class: "note" }, "Drag to rotate · pinch or scroll to zoom · two fingers to pan · tap a character to select.")),
    );
  } else if (activeTab === "Move") {
    const btn = (label, fn, cls = "") => h("button", { type: "button", class: cls, onclick: fn }, label);
    body.append(
      sec("Walk",
        h("p", { class: "note" }, "Use the joystick (bottom-left), WASD/arrow keys, or turn on tap-to-walk and tap the floor. Space stops."),
        h("div", { class: "row" },
          btn(tapToWalk ? "Tap-to-walk: on" : "Tap-to-walk: off", (e) => { tapToWalk = !tapToWalk; e.target.textContent = tapToWalk ? "Tap-to-walk: on" : "Tap-to-walk: off"; e.target.classList.toggle("on", tapToWalk); }, tapToWalk ? "on" : ""),
          btn("Stop", () => ctl.stop("button"), "danger"),
          btn("Return to pad", () => ctl.moveTo(START[selected][0], START[selected][1], "button")))),
      sec("Turn",
        h("div", { class: "row" },
          btn("⟲ 45°", () => ctl.turnBy(Math.PI / 4, "button")),
          btn("⟳ 45°", () => ctl.turnBy(-Math.PI / 4, "button")),
          btn("About-face", () => ctl.turnBy(Math.PI, "button")),
          btn("Face camera", () => { const d = camera.position.clone().sub(c.rig.root.position); ctl.turnTo(Math.atan2(d.x, d.z), "button"); }))),
      sec("Gesture & look",
        h("div", { class: "row" },
          btn(`Signature (${p.animation.gesture})`, () => ctl.playGesture("signature", "button")),
          btn("Wave", () => ctl.playGesture("wave", "button")),
          btn("Nod", () => ctl.playGesture("nod", "button")),
          btn("Look around", () => ctl.lookAround("button")),
          btn(lookAtCamera ? "Look at camera: on" : "Look at camera: off", (e) => {
            lookAtCamera = !lookAtCamera; e.target.classList.toggle("on", lookAtCamera);
            e.target.textContent = lookAtCamera ? "Look at camera: on" : "Look at camera: off";
            ctl.lookAt(lookAtCamera ? camera.position : null, "camera toggle");
          }, lookAtCamera ? "on" : ""),
          btn("Blink", () => ctl.blink()))),
      sec("Expression",
        h("div", { class: "row" }, ...Object.keys(EXPRESSIONS).map((name) => {
          const b = btn(name, (e) => {
            ctl.setExpression(name);
            body.querySelectorAll("[data-expr]").forEach((x) => x.classList.remove("on"));
            e.target.classList.add("on");
          }, ctl.expressionName === name ? "on" : "");
          b.dataset.expr = name;
          return b;
        }))),
      sec("Navigation test",
        h("p", { class: "note" }, "Walks a 4-waypoint square around this character's pad. Each arrival is logged with the measured position error."),
        h("div", { class: "row" }, btn("Run course", () => {
          const [x, z] = START[selected]; const d = 1.1;
          ctl.runCourse([[x, z + d], [x + d, z + d], [x + d, z], [x, z]], "button");
          activeTab = "Log"; store.set("tab", "Log"); renderTabs(); renderTab();
        }))),
    );
  } else if (activeTab === "Voice") {
    renderVoiceTab(c);
  } else if (activeTab === "Talk") {
    renderTalkTab(c);
  } else if (activeTab === "Status") {
    renderStatusTab();
  } else if (activeTab === "Log") {
    const box = h("div", { class: "log", id: "logbox" });
    body.append(
      h("div", { class: "row" },
        h("button", { type: "button", class: "ghost", onclick: () => { LOG.length = 0; renderTab(); } }, "Clear"),
        h("button", { type: "button", class: "ghost", onclick: copyLog }, "Copy log")),
      h("p", { class: "note" }, "Every line is an event the systems actually measured or received. Animations never log actions that did not happen."),
      box);
    LOG.slice(-150).forEach(appendLogLine);
  }
}

function connBox(id) {
  const s = adapters[id].status();
  return h("div", { class: "conn" + (s.state === NOT_CONNECTED ? "" : " ok") },
    h("div", { class: "title-line" }, badge(s.state), h("span", {}, `${PROFILES[id].name} runtime`)),
    h("p", { class: "note" }, s.detail),
    h("p", { class: "note" }, adapters[id].boundary));
}

function appendLogLine(e) {
  const box = document.getElementById("logbox");
  if (!box) return;
  const d = Object.entries(e.detail || {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${Array.isArray(v) ? "[" + v.join(", ") + "]" : typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
  box.prepend(h("div", {}, h("span", { class: "t" }, e.t + "s "), h("span", { class: "c-" + e.source }, e.source), " ", h("b", {}, e.type), " ", d));
  while (box.childElementCount > 200) box.lastChild.remove();
}
async function copyLog() {
  const text = LOG.map((e) => `${e.t}s ${e.source} ${e.type} ${JSON.stringify(e.detail)}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast("Log copied."); } catch { toast("Clipboard unavailable here."); }
}

// ---------- Voice tab ----------
let speakBtn, stopBtn;
function updateSpeakingState() {
  if (!stopBtn) return;
  stopBtn.disabled = !voice.current;
}
function renderVoiceTab(c) {
  const p = c.profile;
  const set = voice.settingsFor(p);
  const voices = voice.engine.voices();
  const rep = voiceReport[p.id];
  const slider = (label, key, min, max, step) => {
    const out = h("output", {}, set[key].toFixed(2));
    const input = h("input", { type: "range", min, max, step, value: set[key], oninput: (e) => { voice.configure(p.id, { [key]: +e.target.value }); out.textContent = (+e.target.value).toFixed(2); } });
    return h("label", { class: "slider" }, label, input, out);
  };
  const select = h("select", { onchange: (e) => { voice.configure(p.id, { voiceName: e.target.value || null }); log("studio", "voice-selected", { character: p.id, voice: e.target.value || "browser default" }); } },
    h("option", { value: "" }, "Browser default"),
    ...voices.map((v) => h("option", { value: v.name, selected: v.name === set.voiceName }, `${v.name} · ${v.lang}${v.localService ? " · on-device" : " · network"}`)));
  const custom = h("textarea", { rows: 2, placeholder: `Type a line for ${p.name} to read (voice test)` });
  const greetLabel = p.voice.greetingIsPlaceholder ? "placeholder greeting" : "Founder-established greeting";
  speakBtn = h("button", { type: "button", onclick: () => voice.speak(p, p.voice.greeting, greetLabel) }, `Preview greeting`);
  stopBtn = h("button", { type: "button", class: "danger", onclick: () => voice.cancel("stopped by user"), disabled: !voice.current }, "Stop");
  body.append(
    sec("Voice test",
      h("p", { class: "note" }, `"${p.voice.greeting}" `, h("span", { class: p.voice.greetingIsPlaceholder ? "note warn" : "note" }, `(${greetLabel})`)),
      h("div", { class: "row" }, speakBtn, stopBtn),
      custom,
      h("div", { class: "row", style: "margin-top:6px" }, h("button", { type: "button", onclick: () => custom.value.trim() && voice.speak(p, custom.value.trim(), "voice test (typed by Founder)") }, "Speak typed line"))),
    sec("Browser voice",
      caps.speechSynthesis ? select : h("p", { class: "note warn" }, "This browser has no speech synthesis."),
      voiceReport.pending ? h("p", { class: "note" }, "Loading voices…") : rep ? h("p", { class: "note" }, rep.reason) : null,
      slider("Pitch", "pitch", 0, 2, 0.01),
      slider("Rate", "rate", 0.5, 1.6, 0.01),
      slider("Volume", "volume", 0, 1, 0.01),
      h("p", { class: "note" }, "Settings apply to this session. Mouth movement runs while the browser reports speech; it follows word timing where the browser provides it, otherwise a steady syllable rhythm. It is not lip-sync.")),
    sec("Target voice (stored for a future engine)",
      h("p", { class: "note warn" }, "Browser voices cannot produce this accent. Pitch and rate are the only things changed here; the accent and character below are NOT being reproduced."),
      h("p", { class: "note" }, h("b", {}, "Accent: "), p.voice.targetAccent),
      p.voice.officialProfile ? h("dl", { class: "kv" }, ...Object.entries(p.voice.officialProfile).flatMap(([k, v]) => [h("dt", {}, k), h("dd", { class: "note" }, v)])) : null),
  );
}

// ---------- Talk tab ----------
const chatHistory = { genesis: [], savannah: [], aria: [] };
function renderTalkTab(c) {
  const p = c.profile, ad = adapters[p.id];
  const chat = h("div", { class: "chat" }, ...chatHistory[p.id].map((m) => h("div", { class: "msg " + m.kind }, m.text)));
  const input = h("input", { type: "text", placeholder: `Say something to ${p.name}`, enterkeyhint: "send" });
  const push = (kind, text) => { chatHistory[p.id].push({ kind, text }); chat.append(h("div", { class: "msg " + kind }, text)); };
  async function send(text, via) {
    text = String(text || "").trim();
    if (!text) return;
    push("you", text);
    log("studio", "message-to-intelligence", { character: p.id, via, chars: text.length });
    const r = await ad.ask(text);
    if (r.reply) {
      push("sys", `${p.name}: ${r.reply}`);
      voice.speak(p, r.reply, "intelligence reply");
      log(p.id, "intelligence-reply", { chars: r.reply.length });
    } else {
      push("sys", r.note);
      log(p.id, "no-reply", { state: ad.status().state });
    }
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { send(input.value, "typed"); input.value = ""; } });
  const micBtn = h("button", { type: "button", disabled: !listener.available() }, listener.available() ? "🎙 Listen" : "Listen (unsupported)");
  micBtn.addEventListener("click", () => {
    if (listener.listening) { listener.stop(); return; }
    voice.cancel("listening started");
    const ok = listener.start({
      onInterim: (t) => { input.value = t; },
      onFinal: (t) => { input.value = ""; log("studio", "speech-recognized", { chars: t.length }); send(t, "speech"); },
      onError: (code, why) => { log("studio", "listen-error", { code }); toast(why); },
      onEnd: () => { micBtn.textContent = "🎙 Listen"; micBtn.classList.remove("on"); },
    });
    if (ok) { micBtn.textContent = "■ Stop listening"; micBtn.classList.add("on"); log("studio", "listen-start", {}); }
  });
  body.append(
    connBox(p.id),
    chat,
    h("div", { class: "inline" }, input, h("button", { type: "button", onclick: () => { send(input.value, "typed"); input.value = ""; } }, "Send")),
    h("div", { class: "row", style: "margin-top:6px" }, micBtn),
    h("p", { class: "note" }, listener.available()
      ? "Speech input uses the browser's recognizer. In Chrome (including Android) audio is sent to Google's servers, so it needs internet."
      : "This browser has no speech recognition. Typed input still works."),
    h("p", { class: "note" }, "While a runtime is NOT CONNECTED, nothing answers and the character does not speak. The studio never invents replies."),
  );
}

// ---------- Status tab ----------
let fpsEl;
function renderStatusTab() {
  const counts = summarize();
  const avail = (b) => badge(b ? "AVAILABLE" : "UNAVAILABLE");
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "hidden by browser";
  fpsEl = h("dd", {}, "measuring…");
  const areas = [...new Set(FEATURES.map((f) => f.area))];
  body.append(
    sec("Summary", h("div", { class: "row" }, ...Object.entries(counts).map(([s, n]) => h("span", {}, badge(s), ` ${n}  `)))),
    sec("Intelligence connections", ...CHARACTER_IDS.map((id) => h("div", { class: "feat" }, h("span", {}, PROFILES[id].name), badge(adapters[id].status().state)))),
    sec("This device (detected live)", h("dl", { class: "kv" },
      h("dt", {}, "3D"), h("dd", {}, caps.webgl, " · ", gpu),
      h("dt", {}, "Frame rate"), fpsEl,
      h("dt", {}, "Speech out"), h("dd", {}, avail(caps.speechSynthesis), ` ${voice.engine.voices().length} voices (${voice.engine.voices().filter((v) => v.localService).length} on-device)`),
      h("dt", {}, "Speech in"), h("dd", {}, avail(caps.speechRecognition)),
      h("dt", {}, "Secure page"), h("dd", {}, avail(caps.secureContext), caps.secureContext ? "" : " (mic needs localhost or HTTPS)"),
      h("dt", {}, "Network"), h("dd", {}, navigator.onLine ? "online" : "offline"),
      h("dt", {}, "Quality"), h("dd", {}, quality))),
    ...areas.map((a) => sec(a, ...FEATURES.filter((f) => f.area === a).map((f) => h("div", { class: "feat" }, h("span", {}, f.name), badge(f.state), f.note ? h("small", {}, f.note) : null)))),
  );
}

// ---------- quality toggle ----------
const qBtn = document.getElementById("quality");
qBtn.textContent = `Quality: ${quality}`;
qBtn.addEventListener("click", () => { store.set("quality", quality === "high" ? "phone" : "high"); location.reload(); });

// ---------- resize ----------
/**
 * Keep the subject centred in the part of the screen not covered by the
 * header and the control panel (bottom sheet on phones, side panel on wide).
 */
function visibleRect() {
  const r = panel.getBoundingClientRect();
  const top = 104;
  if (innerWidth >= 960) return { x0: 0, x1: Math.max(200, r.left), y0: top, y1: innerHeight };
  return { x0: 0, x1: innerWidth, y0: top, y1: Math.max(top + 120, r.top) };
}
function onResize() {
  const w = innerWidth, hgt = innerHeight;
  camera.aspect = w / hgt;
  const v = visibleRect();
  const cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
  camera.setViewOffset(w, hgt, w / 2 - cx, hgt / 2 - cy, w, hgt);
  camera.updateProjectionMatrix();
  renderer.setSize(w, hgt);
}
addEventListener("resize", onResize);

// ---------- loop ----------
const clock = new THREE.Clock();
let frames = 0, fpsT = 0, fps = 0;
const followOffset = new THREE.Vector3();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  // Keyboard drive (camera-relative).
  const kx = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
  const ky = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
  if (kx || ky) { chars[selected].ctl.setDrive(stickToWorld(kx, ky), "keyboard"); keyDriving = true; }
  else if (keyDriving) { chars[selected].ctl.setDrive(null, "keyboard"); keyDriving = false; }

  const mouths = voice.update(dt);
  const sel = chars[selected];
  const before = sel.rig.root.position.clone();
  for (const id of CHARACTER_IDS) {
    chars[id].ctl.setMouth(mouths[id] || 0);
    chars[id].ctl.update(dt);
  }
  world.update(t, dt);

  if (camAnim.active) {
    camAnim.t = Math.min(1, (performance.now() - camAnim.start) / 900);   // wall-clock, smooth on slow devices
    const e = camAnim.t * camAnim.t * (3 - 2 * camAnim.t);
    camera.position.lerpVectors(camAnim.fromP, camAnim.toP, e);
    controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
    if (camAnim.t >= 1) camAnim.active = false;
  } else if (follow) {
    followOffset.copy(sel.rig.root.position).sub(before);
    camera.position.add(followOffset);
    controls.target.add(followOffset);
  }
  controls.update();
  renderer.render(scene, camera);

  frames++; fpsT += dt;
  if (fpsT > 1) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; if (fpsEl && fpsEl.isConnected) fpsEl.textContent = `${fps} fps`; }
  requestAnimationFrame(frame);
}

// ---------- boot ----------
onResize();
renderChips();
renderTabs();
world.highlightPad(selected);
select(selected, { frame: true });
log("studio", "ready", { quality, webgl: caps.webgl, speechOut: caps.speechSynthesis, speechIn: caps.speechRecognition });
requestAnimationFrame(frame);

// Read-only handle for automated tests in this development environment.
window.__studio = Object.freeze({ chars, voice, adapters, LOG, select, frameView, camera, controls, renderer, getFps: () => fps });
