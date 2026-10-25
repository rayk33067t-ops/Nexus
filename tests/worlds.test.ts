import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { loadWorlds, validateWorlds, missingFromMap } from "../src/genesis/worlds/registry";

const ROOT = path.join(__dirname, "..");
const ok = () => ({ id: "x-world", name: "X", status: "future", purpose: "p", intro: { scene: "", durationMs: 6000, tagline: "t", palette: ["#111111", "#222222", "#000000"] } });

test("every world in the registry is valid and has a cinematic intro", () => {
  const { worlds, problems } = loadWorlds(ROOT);
  assert.deepEqual(problems, []);
  assert.ok(worlds.length >= 10);
  assert.ok(worlds.find((w) => w.id === "chronicle"));
});

test("every system on the ecosystem map has a world", () => {
  const map = { activeSystems: [{ name: "Chronicle" }], futureSystems: [{ name: "New Place" }] };
  assert.deepEqual(missingFromMap([{ ...ok(), name: "Chronicle" } as any], map), ["New Place"]);
});

test("a world without an intro, or with a bad scene, palette or duration, is rejected", () => {
  const cases: [string, (w: any) => void][] = [
    ["no intro", (w) => { delete w.intro; }],
    ["non-Spline scene", (w) => { w.intro.scene = "https://evil.example/scene.splinecode"; }],
    ["editor file, not export", (w) => { w.intro.scene = "https://prod.spline.design/abc/scene.spline"; }],
    ["bad palette", (w) => { w.intro.palette = ["red", "blue", "green"]; }],
    ["too short", (w) => { w.intro.durationMs = 500; }],
    ["bad id", (w) => { w.id = "Bad World"; }],
  ];
  for (const [name, mutate] of cases) {
    const w = ok(); mutate(w);
    assert.ok(validateWorlds({ version: 1, worlds: [w] }).problems.length > 0, name);
  }
  const good = ok(); good.intro.scene = "https://prod.spline.design/6Wq1Q7YGyM-iab9i/scene.splinecode";
  assert.deepEqual(validateWorlds({ version: 1, worlds: [good] }).problems, []);
  assert.match(validateWorlds({ version: 1, worlds: [ok(), ok()] }).problems.join(), /duplicate id/);
});

test("the dashboard runs no commands and only listens on this device", () => {
  const src = fs.readFileSync(path.join(ROOT, "dashboard", "server.js"), "utf-8");
  assert.doesNotMatch(src, /child_process|execSync|exec\(|spawn/);
  assert.match(src, /const HOST = "127\.0\.0\.1"/);
  assert.match(src, /app\.listen\(PORT, HOST/);
  assert.match(src, /Content-Security-Policy/);
});

test("pages have no inline scripts, so the security policy can block injected ones", () => {
  for (const page of ["index.html", "world.html"]) {
    const html = fs.readFileSync(path.join(ROOT, "dashboard", "public", page), "utf-8");
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.match(tag, /src="\/spine\//, `${page}: ${tag}`);
    assert.doesNotMatch(html, /\son[a-z]+=/i, `${page} has an inline event handler`);
  }
});

test("the intro engine only accepts exported Spline scenes and pins the runtime version", () => {
  const intro = fs.readFileSync(path.join(ROOT, "dashboard", "public", "spine", "intro.js"), "utf-8");
  assert.match(intro, /@splinetool\/runtime@\d+\.\d+\.\d+\//);
  assert.match(intro, /prod\\\.spline\\\.design/);
});
