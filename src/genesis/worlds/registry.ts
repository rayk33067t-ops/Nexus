import fs from "fs";
import path from "path";

/**
 * The World Spine registry. Every NEXUS world is listed in
 * config/worlds.json, and every world must have a cinematic hero intro.
 * An empty intro.scene uses the built-in cinematic; otherwise it must be a
 * Spline scene URL exported for code (https://prod.spline.design/.../*.splinecode).
 */

export type WorldStatus = "active" | "developing" | "future";

export interface WorldIntro {
  scene: string;
  durationMs: number;
  tagline: string;
  palette: string[];
}

export interface World {
  id: string;
  name: string;
  status: WorldStatus;
  purpose: string;
  intro: WorldIntro;
}

export const SCENE_RE = /^https:\/\/prod\.spline\.design\/[A-Za-z0-9_-]+\/scene\.splinecode$/;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function validateWorlds(raw: unknown): { worlds: World[]; problems: string[] } {
  const problems: string[] = [];
  const doc = raw as { version?: unknown; worlds?: unknown };
  if (!doc || doc.version !== 1 || !Array.isArray(doc.worlds)) {
    return { worlds: [], problems: ['worlds.json must be {"version": 1, "worlds": [...]}'] };
  }
  const ids = new Set<string>();
  const worlds: World[] = [];
  for (const [i, w] of (doc.worlds as any[]).entries()) {
    const at = `world ${i + 1}${w?.id ? ` (${w.id})` : ""}`;
    if (!w || typeof w !== "object") { problems.push(`${at}: not an object`); continue; }
    if (typeof w.id !== "string" || !ID_RE.test(w.id)) problems.push(`${at}: id must be lowercase words joined by hyphens`);
    else if (ids.has(w.id)) problems.push(`${at}: duplicate id`);
    else ids.add(w.id);
    if (typeof w.name !== "string" || !w.name.trim()) problems.push(`${at}: needs a name`);
    if (!["active", "developing", "future"].includes(w.status)) problems.push(`${at}: status must be active, developing or future`);
    if (typeof w.purpose !== "string") problems.push(`${at}: needs a purpose`);
    const intro = w.intro;
    if (!intro || typeof intro !== "object") { problems.push(`${at}: every world needs a cinematic intro`); continue; }
    if (typeof intro.scene !== "string" || (intro.scene !== "" && !SCENE_RE.test(intro.scene))) {
      problems.push(`${at}: intro.scene must be empty or a Spline URL like https://prod.spline.design/<id>/scene.splinecode`);
    }
    if (typeof intro.durationMs !== "number" || intro.durationMs < 2000 || intro.durationMs > 30000) {
      problems.push(`${at}: intro.durationMs must be between 2000 and 30000`);
    }
    if (typeof intro.tagline !== "string") problems.push(`${at}: intro.tagline must be text`);
    if (!Array.isArray(intro.palette) || intro.palette.length !== 3 || !intro.palette.every((c: unknown) => typeof c === "string" && COLOR_RE.test(c))) {
      problems.push(`${at}: intro.palette must be three colours like #7c5cff (glow, accent, background)`);
    }
    worlds.push(w as World);
  }
  return { worlds, problems };
}

/** Every system on the ecosystem map must have a world. */
export function missingFromMap(worlds: World[], ecosystemMap: any): string[] {
  const names = ["activeSystems", "developingSystems", "futureSystems"]
    .flatMap((k) => (Array.isArray(ecosystemMap?.[k]) ? ecosystemMap[k] : []))
    .map((s: any) => String(s?.name ?? ""));
  const have = new Set(worlds.map((w) => w.name.toLowerCase()));
  return names.filter((n) => n && !have.has(n.toLowerCase()));
}

export function loadWorlds(root: string = process.cwd()) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "config", "worlds.json"), "utf-8"));
  const map = JSON.parse(fs.readFileSync(path.join(root, "src", "genesis", "config", "ecosystem-map.json"), "utf-8"));
  const { worlds, problems } = validateWorlds(raw);
  for (const n of missingFromMap(worlds, map)) problems.push(`"${n}" is on the ecosystem map but has no world`);
  return { worlds, problems };
}

if (require.main === module) {
  const { worlds, problems } = loadWorlds();
  for (const w of worlds) {
    console.log(`  ${w.status.padEnd(10)} ${w.name.padEnd(16)} intro: ${w.intro.scene ? "Spline scene" : "built-in cinematic"}`);
  }
  if (problems.length) {
    console.log("\nProblems:");
    for (const p of problems) console.log("  - " + p);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${worlds.length} worlds are valid, and each has a cinematic intro.`);
  }
}
