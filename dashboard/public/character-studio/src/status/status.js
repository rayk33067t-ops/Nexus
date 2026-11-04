/**
 * Development status registry — what exists, what is a prototype, what is a
 * placeholder, what is not started. Hand-maintained, reviewed at each phase;
 * no percentages and no progress bars, so nothing can look more finished
 * than it is. Device capabilities are detected live by detectCapabilities().
 */

export const STATES = Object.freeze({
  IMPLEMENTED: "IMPLEMENTED",     // works as described; covered by tests
  PROTOTYPE: "PROTOTYPE",         // works, but a simplified first version
  PLACEHOLDER: "PLACEHOLDER",     // stand-in content, to be replaced
  NOT_CONNECTED: "NOT CONNECTED", // interface exists, nothing behind it
  NOT_STARTED: "NOT STARTED",
});

const S = STATES;

export const FEATURES = Object.freeze([
  // Environment
  { area: "Environment", name: "3D studio scene, lighting, reflections, particles", state: S.IMPLEMENTED },
  { area: "Environment", name: "Character selection (chips or tap a character)", state: S.IMPLEMENTED },
  { area: "Environment", name: "Orbit / zoom / pan camera, view presets, follow camera", state: S.IMPLEMENTED },
  { area: "Environment", name: "Mobile layout and touch controls", state: S.IMPLEMENTED },
  { area: "Environment", name: "Quality switch (high / phone)", state: S.IMPLEMENTED },

  // Characters
  { area: "Characters", name: "Three distinct procedural models (own proportions, hair, suit cut, accessories)", state: S.PROTOTYPE, note: "Stylized primitives, not photoreal." },
  { area: "Characters", name: "Procedural skeleton (joint hierarchy)", state: S.PROTOTYPE, note: "Rigid segments, no skinned mesh; joints show seams." },
  { area: "Characters", name: "Production 3D models (sculpted, textured, skinned rig)", state: S.NOT_STARTED },
  { area: "Characters", name: "Interchangeable wardrobe (casual, professional, relaxed, formal)", state: S.NOT_STARTED, note: "Required for Savannah by her official profile; signature suits only so far." },
  { area: "Characters", name: "Aria eye colour, heights of Genesis and Aria", state: S.PLACEHOLDER, note: "Studio defaults awaiting Founder confirmation." },

  // Movement
  { area: "Movement", name: "Idle (breathing, weight sway, glances)", state: S.IMPLEMENTED },
  { area: "Movement", name: "Head/neck look-around and look-at-camera", state: S.IMPLEMENTED },
  { area: "Movement", name: "Eye direction and blinking", state: S.IMPLEMENTED },
  { area: "Movement", name: "Turn in place", state: S.IMPLEMENTED },
  { area: "Movement", name: "Gestures (signature per character, wave, nod)", state: S.PROTOTYPE },
  { area: "Movement", name: "Walk cycle and stop", state: S.PROTOTYPE, note: "Procedural gait; feet can slide slightly." },
  { area: "Movement", name: "Locomotion from real controls (joystick, tap-to-walk, keys)", state: S.IMPLEMENTED },
  { area: "Movement", name: "Navigation test course with measured arrivals", state: S.IMPLEMENTED },
  { area: "Movement", name: "Facial expressions", state: S.PROTOTYPE, note: "Brows, lids and mouth corners only." },

  // Voice
  { area: "Voice", name: "Text-to-speech per character (browser voices)", state: S.PROTOTYPE, note: "Pitch/rate only; accents not achievable with browser voices." },
  { area: "Voice", name: "Speak / stop (interruption)", state: S.IMPLEMENTED },
  { area: "Voice", name: "Speech input (listen)", state: S.PROTOTYPE, note: "Browser-dependent; Chrome needs internet." },
  { area: "Voice", name: "Mouth movement while speaking", state: S.PROTOTYPE, note: "Jaw envelope, not lip-sync." },
  { area: "Voice", name: "Phoneme lip-sync", state: S.NOT_STARTED },
  { area: "Voice", name: "Accent voices (Genesis, Savannah, Aria)", state: S.NOT_STARTED, note: "Needs a local or external speech engine." },
  { area: "Voice", name: "Voice picker, pitch, rate, volume and preview per character", state: S.IMPLEMENTED },
  { area: "Voice", name: "Aria greeting line", state: S.PLACEHOLDER, note: "Genesis's and Savannah's greetings are Founder-established." },

  // Intelligence
  { area: "Intelligence", name: "Genesis runtime", state: S.NOT_CONNECTED },
  { area: "Intelligence", name: "Savannah security runtime", state: S.NOT_CONNECTED },
  { area: "Intelligence", name: "Aria runtime", state: S.NOT_CONNECTED },
  { area: "Intelligence", name: "Spoken responses from an intelligence", state: S.NOT_CONNECTED, note: "Pipeline exists; nothing produces replies yet." },
  { area: "Intelligence", name: "Memory systems", state: S.NOT_STARTED },
]);

export function summarize(features = FEATURES) {
  const counts = {};
  for (const f of features) counts[f.state] = (counts[f.state] || 0) + 1;
  return counts;
}

/** Live device/browser checks — run in the page, never assumed. */
export function detectCapabilities(win = globalThis) {
  const canvas = win.document?.createElement?.("canvas");
  let webgl = "unknown";
  try { webgl = canvas && (canvas.getContext("webgl2") ? "WebGL 2" : canvas.getContext("webgl") ? "WebGL 1" : "none"); } catch { webgl = "none"; }
  return {
    webgl,
    speechSynthesis: !!win.speechSynthesis,
    speechRecognition: !!(win.SpeechRecognition || win.webkitSpeechRecognition),
    secureContext: !!win.isSecureContext,
    online: win.navigator ? win.navigator.onLine : null,
    touch: !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches),
    pixelRatio: win.devicePixelRatio || 1,
  };
}
