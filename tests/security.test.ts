import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { coreGuard, PROTECTED_ACTIONS } from "../src/genesis/guards/coreGuard";
import {
  ScaffoldEngine,
  ScaffoldError,
  ensureDirectories,
  snapshotProject,
  writeProjectConfined,
} from "../src/genesis/scaffold";

// ---------- coreGuard: default deny, structured request, decision only ----------

test("guard denies every protected action while Key Authority is missing", () => {
  for (const action of PROTECTED_ACTIONS) {
    for (const actor of ["genesis", "savannah", "founder"]) {
      const d = coreGuard({ actor, action, target: "project:demo" });
      assert.equal(d.allowed, false, `${actor} ${action}`);
      assert.match(d.reason, /Key Authority is not implemented/);
    }
  }
});

test("guard denies unknown actions", () => {
  const d = coreGuard({ actor: "genesis", action: "fs.delete", target: "x" });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /unknown action/);
});

test("guard rejects raw strings and malformed requests", () => {
  for (const bad of ["build login system", null, undefined, 42, {}, { actor: "", action: "fs.write", target: "x" },
                     { actor: "genesis", action: "fs.write", target: 5 }, { actor: "g\0", action: "fs.write", target: "x" }]) {
    assert.equal(coreGuard(bad).allowed, false, JSON.stringify(bad));
  }
});

test("caller-supplied approval fields are ignored", () => {
  const d = coreGuard({ actor: "genesis", action: "fs.write", target: "x", allowed: true, policy: () => true, authority: { allow: () => true } } as any);
  assert.equal(d.allowed, false);
});

test("decision is frozen and does not hand back the caller's object", () => {
  const req = { actor: "genesis", action: "fs.write", target: "project:a" };
  const d = coreGuard(req);
  assert.notEqual(d as unknown, req);
  assert.throws(() => { (d as any).allowed = true; });
  req.target = "project:b";
  assert.equal(d.target, "project:a");
});

test("each request field is read exactly once", () => {
  let reads = 0;
  const req = { actor: "genesis", target: "x", get action() { reads++; return reads === 1 ? "fs.write" : "fs.delete"; } };
  coreGuard(req);
  assert.equal(reads, 1);
});

// ---------- ScaffoldEngine: guarded entry point ----------

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scaffold-"));
  const base = path.join(dir, "projects");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  return { dir, base, outside };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ScaffoldError) return e.code; throw e; }
  return "NO_ERROR";
}

const write = (base: string, name: unknown, structure: unknown) =>
  writeProjectConfined(base, snapshotProject(name, structure));

test("createProject refuses every build until Key Authority exists, and writes nothing", () => {
  const { base } = sandbox();
  const engine = new ScaffoldEngine(base);
  for (const actor of ["genesis", "savannah", "founder"]) {
    assert.equal(code(() => engine.createProject("demo", { files: [{ path: "a.txt", content: "a" }] }, actor)), "GUARD_DENIED");
  }
  assert.equal(fs.existsSync(path.join(base, "demo")), false);
});

test("createProject validates before asking the guard", () => {
  const { base } = sandbox();
  const engine = new ScaffoldEngine(base);
  assert.equal(code(() => engine.createProject("demo", { files: [{ path: "../x", content: "x" }] })), "INVALID_PATH");
});

test("engine base path cannot be swapped after construction", () => {
  const { base, outside } = sandbox();
  const engine = new ScaffoldEngine(base);
  assert.throws(() => { (engine as any).basePath = outside; });
});

// ---------- snapshot ----------

test("snapshot is a frozen copy unaffected by later changes to the caller's object", () => {
  const structure = { files: [{ path: "a.txt", content: "original" }] };
  const snap = snapshotProject("snap", structure);
  structure.files[0].path = "../escape.txt";
  structure.files[0].content = "tampered";
  structure.files.push({ path: "b.txt", content: "added" });
  assert.equal(snap.files.length, 1);
  assert.equal(snap.files[0].rel, "a.txt");
  assert.equal(snap.files[0].content, "original");
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.files) && Object.isFrozen(snap.files[0]));
});

// ---------- confined writer: checks at the moment of use ----------

test("writes a valid project and counts only files actually written", () => {
  const { base } = sandbox();
  const r = write(base, "demo", {
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
  for (const name of ["..", ".", "../escape", "a/b", "", "-flag", "a\\b", 7]) {
    assert.equal(code(() => snapshotProject(name, { files: [] })), "INVALID_PROJECT_NAME", String(name));
  }
});

test("rejects traversal, absolute, backslash and NUL paths", () => {
  for (const p of ["../../outside/pwned.txt", "src/../../x", "/etc/passwd", "C:/Windows/x", "src\\x.ts", "a//b", "./a", "a\0b"]) {
    assert.equal(code(() => snapshotProject("p", { files: [{ path: "ok.txt", content: "ok" }, { path: p, content: "x" }] })), "INVALID_PATH", p);
  }
});

test("rejects duplicate paths, file/directory conflicts, bad content and missing files", () => {
  assert.equal(code(() => snapshotProject("d", { files: [{ path: "a.ts", content: "1" }, { path: "a.ts", content: "2" }] })), "DUPLICATE_PATH");
  assert.equal(code(() => snapshotProject("d", { files: [{ path: "a", content: "1" }, { path: "a/b.ts", content: "2" }] })), "PATH_CONFLICT");
  assert.equal(code(() => snapshotProject("d", { files: [{ path: "a", content: 5 }] })), "INVALID_CONTENT");
  assert.equal(code(() => snapshotProject("d", {})), "INVALID_STRUCTURE");
});

test("never overwrites an existing project", () => {
  const { base } = sandbox();
  write(base, "same", { files: [{ path: "a.txt", content: "first" }] });
  assert.equal(code(() => write(base, "same", { files: [{ path: "a.txt", content: "second" }] })), "PROJECT_EXISTS");
  assert.equal(fs.readFileSync(path.join(base, "same/a.txt"), "utf-8"), "first");
});

test("a symlink planted at the project name is refused, not followed", () => {
  const { base, outside } = sandbox();
  fs.mkdirSync(base, { recursive: true });
  fs.symlinkSync(outside, path.join(base, "evil"));
  assert.equal(code(() => write(base, "evil", { files: [{ path: "x.txt", content: "x" }] })), "PROJECT_EXISTS");
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
