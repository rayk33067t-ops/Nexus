// The shared cinematic hero intro every NEXUS world opens with.
// Plays the world's Spline scene if it has one, otherwise the built-in
// cinematic. Always skippable, plays once per visit, and steps aside for
// people who have asked their device to reduce motion.

import { playPlaceholder } from "./placeholder.js";

const SPLINE_RUNTIME = "https://cdn.jsdelivr.net/npm/@splinetool/runtime@2.0.43/+esm";
const SCENE_RE = /^https:\/\/prod\.spline\.design\/[A-Za-z0-9_-]+\/scene\.splinecode$/;
const LOAD_TIMEOUT_MS = 15000;

const seenKey = (world) => `nexus-intro-seen:${world.id}`;

export function introSeen(world) {
  try { return sessionStorage.getItem(seenKey(world)) === "1"; } catch { return false; }
}

function markSeen(world) {
  try { sessionStorage.setItem(seenKey(world), "1"); } catch { /* storage blocked: intro will replay */ }
}

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Plays the intro. Resolves when it has finished or been skipped. */
export async function playIntro(world, { force = false } = {}) {
  if (!force && (introSeen(world) || prefersReducedMotion())) { markSeen(world); return; }

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.setAttribute("role", "dialog");
  stage.setAttribute("aria-label", `${world.name} intro`);
  stage.innerHTML = `
    <div class="letterbox top"></div>
    <canvas aria-hidden="true"></canvas>
    <div class="title"><h1></h1><p></p></div>
    <div class="letterbox bottom"></div>
    <button class="skip" type="button">Skip intro</button>`;
  stage.querySelector("h1").textContent = world.name;
  stage.querySelector("p").textContent = world.intro.tagline || "";
  stage.style.setProperty("--title-delay", `${Math.round(world.intro.durationMs * 0.35)}ms`);
  document.body.appendChild(stage);
  document.body.style.overflow = "hidden";

  const canvas = stage.querySelector("canvas");
  const skip = stage.querySelector(".skip");
  const abort = new AbortController();
  const skipped = new Promise((resolve) => {
    const done = () => { abort.abort(); resolve(); };
    skip.addEventListener("click", done);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") done(); }, { signal: abort.signal });
  });
  skip.focus({ preventScroll: true });

  const scene = world.intro.scene;
  let played;
  if (scene && SCENE_RE.test(scene)) {
    played = playSpline(canvas, scene, world.intro.durationMs, abort.signal).catch(() =>
      // Scene missing, offline or blocked: fall back to the built-in cinematic.
      playPlaceholder(canvas, world, world.intro.durationMs, abort.signal));
  } else {
    played = playPlaceholder(canvas, world, world.intro.durationMs, abort.signal);
  }

  await Promise.race([played, skipped]);
  abort.abort();
  markSeen(world);
  stage.classList.add("leaving");
  document.body.style.overflow = "";
  await new Promise((r) => setTimeout(r, 900));
  stage.remove();
}

async function playSpline(canvas, scene, durationMs, signal) {
  const { Application } = await import(SPLINE_RUNTIME);
  const app = new Application(canvas);
  await Promise.race([
    app.load(scene),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Spline scene took too long to load")), LOAD_TIMEOUT_MS)),
  ]);
  await new Promise((resolve) => {
    const t = setTimeout(resolve, durationMs);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); });
  });
  try { app.dispose?.(); } catch { /* older runtimes */ }
}
