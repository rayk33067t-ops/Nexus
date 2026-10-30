import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Point Key Authority at an empty, private state dir and a missing rules file
// before it loads, so these tests see the "no rules, deny everything" state.
const KA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ka-security-"));
process.env.NEXUS_RULES_PATH = path.join(KA_DIR, "missing-rules.json");
process.env.NEXUS_STATE_DIR = path.join(KA_DIR, "state");

const { coreGuard, PROTECTED_ACTIONS } = require("../src/genesis/guards/coreGuard");
const {
  ScaffoldEngine,
  ScaffoldError,
  ensureDirectories,
  snapshotProject,
  writeProjectConfined,
} = require("../src/genesis/scaffold");
const { issue, grantFor } = require("./support");

const D = "sha256:" + "0".repeat(64);

// Real agents, each with its own credential. Requests are signed, never named.
const signers: Record<string, any> = { genesis: issue("genesis"), savannah: issue("savannah") };
const signed = (agent: string, over: object = {}) => signers[agent].sign({ action: "fs.write", target: "project:demo", digest: D, ...over });

// ---------- coreGuard: default deny, structured request, decision only ----------

test("guard denies every protected action when there is no rules file", () => {
  for (const action of PROTECTED_ACTIONS) {
    for (const agent of ["genesis", "savannah"]) {
      const d = coreGuard(signed(agent, { action }));
      assert.equal(d.allowed, false, `${agent} ${action}`);
      assert.match(d.reason, /no usable rules/);
      assert.equal(d.actor, agent);
    }
  }
});

test("guard denies unknown actions", () => {
  const d = coreGuard(signed("genesis", { action: "fs.delete", target: "x" }));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /unknown action/);
});

test("guard rejects raw strings, unsigned and malformed requests", () => {
  for (const bad of ["build login system", null, undefined, 42, {}, { action: "fs.write", target: "x", digest: D },
                     { action: "fs.write", target: 5, digest: D }, { action: "fs.write", target: "x\0", digest: D }]) {
    assert.equal(coreGuard(bad).allowed, false, JSON.stringify(bad));
  }
});

test("a request that names its own actor is refused, even when validly signed", () => {
  for (const name of ["genesis", "founder", "savannah"]) {
    const d = coreGuard({ ...signed("genesis"), actor: name });
    assert.equal(d.allowed, false);
    assert.match(d.reason, /may not name their own actor/);
  }
});

test("caller-supplied approval fields are ignored", () => {
  const d = coreGuard({ ...signed("genesis", { target: "x" }), allowed: true, policy: () => true, authority: { allow: () => true } } as any);
  assert.equal(d.allowed, false);
});

test("decision is frozen and does not hand back the caller's object", () => {
  const req = signed("genesis", { target: "project:a" });
  const d = coreGuard(req);
  assert.notEqual(d as unknown, req);
  assert.throws(() => { (d as any).allowed = true; });
  req.target = "project:b";
  assert.equal(d.target, "project:a");
});

test("each request field is read exactly once", () => {
  let reads = 0;
  const base = signed("genesis", { target: "x" });
  const req = { ...base };
  delete (req as any).action;
  Object.defineProperty(req, "action", { enumerable: true, get() { reads++; return reads === 1 ? "fs.write" : "fs.delete"; } });
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

// The writer needs a real grant. These tests run with no rules file, so allow
// builds just long enough to get one, then remove the rules again.
const RULES = process.env.NEXUS_RULES_PATH as string;
// A separate agent: Genesis is (correctly) quarantined by a traversal test above.
const writer = issue("writer");
const write = (base: string, name: unknown, structure: unknown): any => {
  const snap = snapshotProject(name, structure);
  fs.writeFileSync(RULES, JSON.stringify({ version: 1, rules: [{ id: "t", actor: "writer", action: "fs.write", target: "project:*", effect: "allow" }] }));
  let grant;
  try { grant = grantFor(writer, base, snap); } finally { fs.rmSync(RULES, { force: true }); }
  return writeProjectConfined(base, snap, grant);
};

test("createProject refuses every build when there are no rules, and writes nothing", () => {
  const { base } = sandbox();
  for (const agent of ["genesis", "savannah"]) {
    const engine = new ScaffoldEngine(base, signers[agent]);
    assert.equal(code(() => engine.createProject("demo", { files: [{ path: "a.txt", content: "a" }] })), "GUARD_DENIED");
  }
  assert.equal(code(() => new ScaffoldEngine(base).createProject("demo", { files: [{ path: "a.txt", content: "a" }] })), "GUARD_DENIED");
  assert.equal(fs.existsSync(path.join(base, "demo")), false);
});

test("createProject validates before asking the guard", () => {
  const { base } = sandbox();
  const engine = new ScaffoldEngine(base, signers.genesis);
  assert.equal(code(() => engine.createProject("demo", { files: [{ path: "../x", content: "x" }] })), "INVALID_PATH");
});

test("engine base path cannot be swapped after construction", () => {
  const { base, outside } = sandbox();
  const engine = new ScaffoldEngine(base, signers.genesis);
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
