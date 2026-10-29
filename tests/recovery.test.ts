import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Partial-build recovery: failed and interrupted builds are undone exactly,
// unrelated files are never touched, and every outcome stays on record.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-recovery-"));
const STATE = path.join(ROOT, "state");
process.env.NEXUS_STATE_DIR = STATE;
process.env.NEXUS_RULES_PATH = path.join(ROOT, "no-rules.json");

const { snapshotProject, writeProjectConfined, ScaffoldError } = require("../src/genesis/scaffold");
const journal = require("../src/genesis/buildJournal");
const state = require("../src/genesis/warden/state");
const { readLog } = require("../src/genesis/warden/log");

let n = 0;
function sandbox() {
  const dir = path.join(ROOT, `case-${++n}`);
  const base = path.join(dir, "projects");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(outside);
  return { base, outside };
}
const plan = {
  files: [
    { path: "README.md", content: "# Demo\n" },
    { path: "src/app.ts", content: "export const app = 1;\n" },
    { path: "src/lib/util.ts", content: "export const util = 2;\n" },
  ],
};
const snap = (name = "demo") => snapshotProject(name, plan);
const failAt = (i: number) => ({ beforeFile: (index: number) => { if (index === i) throw new Error("disk full (simulated)"); } });
const listAll = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p)); if (e.isDirectory() && !e.isSymbolicLink()) walk(p); } };
  walk(dir);
  return out.sort();
};
const outcomes = (project: string, base: string) =>
  journal.readHistory(project).filter((h: any) => h.projectRoot.startsWith(fs.realpathSync(base))).map((h: any) => h.outcome);

test("a build that fails before writing any file leaves nothing behind, and a retry works", () => {
  const { base } = sandbox();
  assert.throws(() => writeProjectConfined(base, snap(), failAt(0)), /disk full \(simulated\).*0 of 3 files were written/);
  assert.deepEqual(listAll(base), []);
  const r = writeProjectConfined(base, snap());
  assert.equal(r.filesCreated, 3);
  assert.deepEqual(outcomes("demo", base), ["failed", "completed"]);
});

test("a build that fails after writing some files removes exactly those, then retries cleanly", () => {
  const { base } = sandbox();
  let err: any;
  try { writeProjectConfined(base, snap(), failAt(2)); } catch (e) { err = e; }
  assert.ok(err, "the failed build must not report success");
  assert.match(err.message, /2 of 3 files were written before stopping; removed 5 item\(s\) this build created/);
  assert.deepEqual(listAll(base), []);

  const h = journal.readHistory("demo").at(-1);
  assert.equal(h.outcome, "failed");
  assert.equal(h.filesWritten, 2);
  assert.deepEqual(h.cleanup.removed.sort(), ["(project folder)", "README.md", "src", "src/app.ts", "src/lib"].sort());
  assert.deepEqual(h.cleanup.kept, []);

  const r = writeProjectConfined(base, snap());
  assert.equal(r.filesCreated, 3);
  assert.equal(fs.readFileSync(path.join(base, "demo/src/lib/util.ts"), "utf-8"), "export const util = 2;\n");
  // the earlier failure is still on record
  assert.deepEqual(outcomes("demo", base), ["failed", "completed"]);
});

/** Run a build in a separate process that dies partway through, like a crash. */
function crashMidBuild(base: string, atIndex: number) {
  const scaffold = path.join(__dirname, "..", "src", "genesis", "scaffold");
  const code = `
    const s = require(${JSON.stringify(scaffold)});
    const snap = s.snapshotProject("demo", ${JSON.stringify(plan)});
    s.writeProjectConfined(${JSON.stringify(base)}, snap, { beforeFile: (i) => { if (i === ${atIndex}) process.exit(9); } });
  `;
  try {
    execFileSync(process.execPath, ["-r", "ts-node/register", "-e", code], { env: { ...process.env }, cwd: path.join(__dirname, ".."), stdio: "pipe" });
    assert.fail("the child should have died mid-build");
  } catch (e: any) {
    assert.equal(e.status, 9, String(e.stderr));
  }
}

test("an interrupted build is detected and undone before the retry, and stays on record", () => {
  const { base } = sandbox();
  crashMidBuild(base, 2);
  // the crash left two files and a journal behind
  assert.deepEqual(listAll(path.join(base, "demo")), ["README.md", "src", "src/app.ts", "src/lib"]);
  const projectRoot = path.join(fs.realpathSync(base), "demo");
  assert.equal(journal.readJournal(projectRoot).status, "in-progress");

  const r = writeProjectConfined(base, snap());
  assert.equal(r.filesCreated, 3);
  assert.ok(r.recoveredFrom, "the result says it recovered an earlier attempt");
  assert.equal(journal.readJournal(projectRoot), null);
  assert.deepEqual(outcomes("demo", base), ["interrupted", "completed"]);
  const interrupted = journal.readHistory("demo").find((h: any) => h.outcome === "interrupted" && h.projectRoot === projectRoot);
  assert.equal(interrupted.attemptId, r.recoveredFrom);
  assert.equal(interrupted.filesWritten, 2);
});

test("files the build did not create are never removed, and the retry is refused until they're dealt with", () => {
  const { base } = sandbox();
  crashMidBuild(base, 2);
  const projectRoot = path.join(base, "demo");
  // someone puts their own notes into the half-built project, and replaces one of its files
  fs.writeFileSync(path.join(projectRoot, "notes.txt"), "mine, keep this");
  fs.rmSync(path.join(projectRoot, "README.md"));
  fs.writeFileSync(path.join(projectRoot, "README.md"), "my own readme");

  let err: any;
  try { writeProjectConfined(base, snap()); } catch (e) { err = e; }
  assert.ok(err instanceof ScaffoldError && err.code === "PROJECT_EXISTS", String(err));
  assert.match(err.message, /did not finish/);
  assert.equal(fs.readFileSync(path.join(projectRoot, "notes.txt"), "utf-8"), "mine, keep this");
  assert.equal(fs.readFileSync(path.join(projectRoot, "README.md"), "utf-8"), "my own readme");
  assert.equal(fs.existsSync(path.join(projectRoot, "src")), false, "the build's own files were still removed");
  assert.deepEqual(outcomes("demo", base), ["recovery-incomplete"]);

  // once the owner moves their files out, the retry goes through
  fs.renameSync(path.join(projectRoot, "notes.txt"), path.join(base, "..", "notes.txt"));
  fs.rmSync(path.join(projectRoot, "README.md"));
  const r = writeProjectConfined(base, snap());
  assert.equal(r.filesCreated, 3);
  assert.deepEqual(outcomes("demo", base), ["recovery-incomplete", "interrupted", "completed"]);
});

test("an existing project is never overwritten or cleaned up", () => {
  const { base } = sandbox();
  fs.mkdirSync(path.join(base, "demo"));
  fs.writeFileSync(path.join(base, "demo", "README.md"), "existing work");
  assert.throws(() => writeProjectConfined(base, snap()), (e: any) => e.code === "PROJECT_EXISTS");
  assert.equal(fs.readFileSync(path.join(base, "demo", "README.md"), "utf-8"), "existing work");
  assert.deepEqual(listAll(path.join(base, "demo")), ["README.md"]);
  assert.deepEqual(outcomes("demo", base), []);
});

test("cleanup never follows a symlink swapped in mid-build, and never leaves the project", () => {
  const { base, outside } = sandbox();
  fs.writeFileSync(path.join(outside, "precious.txt"), "outside the project");
  const swap = {
    beforeFile: (index: number) => {
      if (index === 2) {
        // replace the build's own "src/lib" folder with a link to somewhere else
        const lib = path.join(base, "demo", "src", "lib");
        fs.rmdirSync(lib);
        fs.symlinkSync(outside, lib);
      }
    },
  };
  let err: any;
  try { writeProjectConfined(base, snap(), swap); } catch (e) { err = e; }
  assert.ok(err, "the build must fail");
  assert.deepEqual(fs.readdirSync(outside), ["precious.txt"]);
  assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf-8"), "outside the project");
  const h = journal.readHistory("demo").at(-1);
  assert.equal(h.outcome, "failed");
  assert.ok(h.cleanup.kept.some((k: any) => k.rel === "src/lib"), JSON.stringify(h.cleanup));
});

test("a traversal plan is refused before anything is written or recorded as built", () => {
  const { base, outside } = sandbox();
  assert.throws(() => snapshotProject("demo", { files: [{ path: "../../outside/x.txt", content: "x" }] }), (e: any) => e.code === "INVALID_PATH");
  assert.deepEqual(listAll(base), []);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("every build outcome reaches the Warden's event log", () => {
  const { base } = sandbox();
  try { writeProjectConfined(base, snapshotProject("logged", plan), failAt(1)); } catch { /* expected */ }
  writeProjectConfined(base, snapshotProject("logged", plan));
  const builds = readLog(state.LOG_FILE).map((e: any) => e.event).filter((e: any) => e.type === "build" && e.project === "logged");
  assert.deepEqual(builds.map((b: any) => b.outcome), ["failed", "completed"]);
  assert.equal(builds[0].filesWritten, 1);
  assert.equal(builds[1].filesWritten, 3);
});
