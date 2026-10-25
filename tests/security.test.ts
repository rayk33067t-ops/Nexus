import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { coreGuard } from "../src/genesis/guards/coreGuard";
import { ScaffoldEngine, ScaffoldError, ensureDirectories } from "../src/genesis/scaffold";

// ---------- coreGuard ----------

test("guard denies when no policy is supplied", () => {
  const d = coreGuard("build login system");
  assert.equal(d.allowed, false);
  assert.match(d.reason, /denied by default/);
});

test("guard denies non-string input even with an allow-all policy", () => {
  const d = coreGuard({ evil: true }, { name: "all", allow: () => true });
  assert.equal(d.allowed, false);
});

test("guard allows only when the policy returns exactly true", () => {
  assert.equal(coreGuard("x", { name: "yes", allow: () => true }).allowed, true);
  assert.equal(coreGuard("x", { name: "truthy", allow: () => "yes" as any }).allowed, false);
  assert.equal(coreGuard("x", { name: "one", allow: () => 1 as any }).allowed, false);
});

test("guard denies when the policy throws", () => {
  const d = coreGuard("x", { name: "boom", allow: () => { throw new Error("boom"); } });
  assert.equal(d.allowed, false);
  assert.equal(d.policy, "boom");
});

test("guard decisions cannot be flipped after the fact", () => {
  const d = coreGuard("x");
  assert.throws(() => { (d as any).allowed = true; });
  assert.equal(d.allowed, false);
});

// ---------- ScaffoldEngine ----------

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scaffold-"));
  const base = path.join(dir, "projects");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  return { dir, base, outside, engine: new ScaffoldEngine(base) };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ScaffoldError) return e.code; throw e; }
  return "NO_ERROR";
}

test("writes a valid project and counts only files actually written", () => {
  const { base, engine } = sandbox();
  const r = engine.createProject("demo", {
    files: [
      { path: "README.md", content: "# Demo\n" },
      { path: "src/auth/login.ts", content: "export {};\n" },
      { path: "src/empty.ts", content: "" },
    ],
  });
  assert.equal(r.filesCreated, 3);
  assert.equal(fs.readFileSync(path.join(base, "demo/src/auth/login.ts"), "utf-8"), "export {};\n");
  assert.equal(fs.readFileSync(path.join(base, "demo/src/empty.ts"), "utf-8"), "");
});

test("rejects project names that are not a single plain segment", () => {
  const { engine } = sandbox();
  for (const name of ["..", ".", "../escape", "a/b", "", "-flag", "a\\b"]) {
    assert.equal(code(() => engine.createProject(name, { files: [] })), "INVALID_PROJECT_NAME", name);
  }
});

test("rejects traversal, absolute, backslash and NUL paths before writing anything", () => {
  const { base, outside, engine } = sandbox();
  const bad = [
    "../../outside/pwned.txt",
    "src/../../x",
    "/etc/passwd",
    "C:/Windows/x",
    "src\\x.ts",
    "a//b",
    "./a",
    "a\0b",
  ];
  for (const p of bad) {
    const c = code(() => engine.createProject("p" + bad.indexOf(p), {
      files: [{ path: "ok.txt", content: "ok" }, { path: p, content: "x" }],
    }));
    assert.equal(c, "INVALID_PATH", p);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
  // validation runs first, so no project directories were created at all
  assert.equal(fs.existsSync(base) ? fs.readdirSync(base).length : 0, 0);
});

test("rejects duplicate paths and file/directory conflicts", () => {
  const { engine } = sandbox();
  assert.equal(code(() => engine.createProject("d1", {
    files: [{ path: "a.ts", content: "1" }, { path: "a.ts", content: "2" }],
  })), "DUPLICATE_PATH");
  assert.equal(code(() => engine.createProject("d2", {
    files: [{ path: "a", content: "1" }, { path: "a/b.ts", content: "2" }],
  })), "PATH_CONFLICT");
});

test("rejects non-string content and missing files array", () => {
  const { engine } = sandbox();
  assert.equal(code(() => engine.createProject("c1", { files: [{ path: "a", content: 5 }] })), "INVALID_CONTENT");
  assert.equal(code(() => engine.createProject("c2", {})), "INVALID_STRUCTURE");
});

test("never overwrites an existing project", () => {
  const { base, engine } = sandbox();
  engine.createProject("same", { files: [{ path: "a.txt", content: "first" }] });
  assert.equal(code(() => engine.createProject("same", { files: [{ path: "a.txt", content: "second" }] })), "PROJECT_EXISTS");
  assert.equal(fs.readFileSync(path.join(base, "same/a.txt"), "utf-8"), "first");
});

test("a symlink planted at the project name is refused, not followed", () => {
  const { base, outside, engine } = sandbox();
  fs.mkdirSync(base, { recursive: true });
  fs.symlinkSync(outside, path.join(base, "evil"));
  assert.equal(code(() => engine.createProject("evil", { files: [{ path: "x.txt", content: "x" }] })), "PROJECT_EXISTS");
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("directory creation refuses an existing symlinked segment", () => {
  const { dir, outside } = sandbox();
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  fs.symlinkSync(outside, path.join(root, "src"));
  assert.throws(() => ensureDirectories(root, ["src", "auth"]), (e: any) => e.code === "UNSAFE_PATH");
  assert.deepEqual(fs.readdirSync(outside), []);
});
