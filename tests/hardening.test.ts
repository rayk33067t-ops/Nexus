import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// The four properties verified on 2026-10-29, each reproduced as a test:
// where rules come from, approvals under concurrency, lockdown, and whether
// the protected write enforces the decision itself.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hard-"));
const RULES = path.join(ROOT, "rules.json");
const STATE = path.join(ROOT, "state");
process.env.NEXUS_RULES_PATH = RULES;
process.env.NEXUS_STATE_DIR = STATE;
const REPO = path.join(__dirname, "..");

const store = require("../src/genesis/authority/store");
const KA = require("../src/genesis/authority/KeyAuthority");
const kaFounder = require("../src/genesis/authority/founder");
const W = require("../src/genesis/warden/founder");
const state = require("../src/genesis/warden/state");
const scaffold = require("../src/genesis/scaffold");
const { digestOf } = require("../src/genesis/authority/canonical");
const { coreGuard } = require("../src/genesis/guards/coreGuard");
const { issue, grantFor, PASS } = require("./support");

const rule = (id: string, actor: string, action: string, target: string, effect: string) => ({ id, actor, action, target, effect });
const rules = (list: object[]) => fs.writeFileSync(RULES, JSON.stringify({ version: 1, rules: list }));
const body = (o: object = {}) => ({ action: "fs.write", target: "project:demo", digest: digestOf({ p: 1 }), ...o });

let genesis: any, builder: any;
beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(RULES, { force: true });
  genesis = issue("genesis");
  builder = issue("builder");
});

// ---------- 1. where the rules (and state) come from ----------

function inChild(cwd: string, env: Record<string, string | undefined>, code: string): { status: number; out: string } {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!["NEXUS_ROOT", "NEXUS_RULES_PATH", "NEXUS_STATE_DIR"].includes(k) && v !== undefined) clean[k] = v;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  try {
    const out = execFileSync(process.execPath, ["-r", "ts-node/register", "-e", code], { cwd, env: { ...clean, TS_NODE_PROJECT: path.join(REPO, "tsconfig.json") }, stdio: "pipe" }).toString();
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

test("rules and state are anchored to the NEXUS code, not the folder NEXUS was started from", () => {
  const code = `const s = require(${JSON.stringify(path.join(REPO, "src/genesis/authority/store"))}); console.log(JSON.stringify(s.PATHS));`;
  const fromHome = JSON.parse(inChild(os.homedir(), {}, code).out);
  const fromTmp = JSON.parse(inChild(os.tmpdir(), {}, code).out);
  const repo = fs.realpathSync(REPO);
  assert.equal(fs.realpathSync(path.dirname(path.dirname(fromHome.rulesPath))), repo);
  assert.deepEqual(fromHome, fromTmp);
  assert.equal(fromHome.rulesPath, path.join(path.resolve(REPO), "config", "key-authority.json"));
  assert.equal(fromHome.stateDir, path.join(path.resolve(REPO), ".nexus"));
});

test("Genesis and both Founder CLIs refuse to start with redirected rules or state", () => {
  for (const [label, file] of [["warden", "src/genesis/warden/cli.ts"], ["authority", "src/genesis/authority/cli.ts"]]) {
    for (const v of ["NEXUS_RULES_PATH", "NEXUS_STATE_DIR", "NEXUS_ROOT"]) {
      const r = inChild(REPO, { [v]: path.join(ROOT, "elsewhere") }, `require(${JSON.stringify(path.join(REPO, file))})`);
      assert.equal(r.status, 2, `${label} with ${v}: ${r.out}`);
      assert.match(r.out, new RegExp(`Refusing to start: ${v}`));
    }
  }
  // Genesis itself: checked by source, since starting it runs the interactive runtime
  const run = fs.readFileSync(path.join(REPO, "src/genesis/run.ts"), "utf-8");
  assert.ok(run.indexOf('assertProductionPaths("Genesis")') < run.indexOf('startupGate("genesis")'));
});

test("a rules file that is a link is refused, even when it points at valid rules", () => {
  const elsewhere = path.join(ROOT, "permissive.json");
  fs.writeFileSync(elsewhere, JSON.stringify({ version: 1, rules: [rule("all", "*", "*", "**", "allow")] }));
  fs.symlinkSync(elsewhere, RULES);
  const d = KA.decide(builder.sign(body()));
  assert.equal(d.outcome, "deny");
  assert.match(d.reason, /rules file is a link/);
  fs.rmSync(RULES);
  fs.copyFileSync(elsewhere, RULES);
  assert.equal(KA.decide(builder.sign(body())).outcome, "allow", "the same rules as a real file are obeyed");
});

// ---------- 2. approvals ----------

test("approving the same plan for two agents gives each its own single-use approval", () => {
  rules([rule("q", "*", "fs.write", "**", "ask")]);
  const D = digestOf({ shared: "plan" });
  const gid = KA.decide(genesis.sign(body({ digest: D }))).requestId;
  const bid = KA.decide(builder.sign(body({ digest: D }))).requestId;
  kaFounder.approve(gid, PASS);
  kaFounder.approve(bid, PASS);
  assert.equal(fs.readdirSync(store.DIRS.approvals).length, 2);
  assert.equal(KA.decide(genesis.sign(body({ digest: D }))).outcome, "allow");
  assert.equal(KA.decide(builder.sign(body({ digest: D }))).outcome, "allow");
  assert.equal(KA.decide(genesis.sign(body({ digest: D }))).outcome, "ask");
  assert.equal(KA.decide(builder.sign(body({ digest: D }))).outcome, "ask");
});

test("an approval is checked after it is claimed: one that doesn't match is voided, not used", () => {
  rules([rule("q", "*", "fs.write", "**", "ask")]);
  const id = KA.decide(genesis.sign(body())).requestId;
  kaFounder.approve(id, PASS);
  // swap the approval's contents for another agent's, at the same file
  const f = path.join(store.DIRS.approvals, fs.readdirSync(store.DIRS.approvals)[0]);
  const a = JSON.parse(fs.readFileSync(f, "utf-8"));
  fs.writeFileSync(f, JSON.stringify({ ...a, actor: "builder" }));
  assert.equal(KA.decide(genesis.sign(body())).outcome, "ask");
  assert.equal(fs.readdirSync(store.DIRS.approvals).length, 0, "the mismatched approval was taken out of reach");
  assert.equal(fs.readdirSync(path.join(STATE, "voided")).length, 1);
});

test("racing processes: one approval allows exactly one request", { timeout: 180_000 }, async (t) => {
  rules([rule("q", "*", "fs.write", "**", "ask")]);
  const N = 8, ROUNDS = 4;
  const dir = fs.mkdtempSync(path.join(ROOT, "race-"));
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < N; i++) fs.writeFileSync(path.join(dir, `r${r}-${i}.json`), JSON.stringify(genesis.sign(body({ digest: digestOf({ race: r }) }))));
  }
  const racer = `
    const fs = require("fs");
    const KA = require(${JSON.stringify(path.join(REPO, "src/genesis/authority/KeyAuthority"))});
    for (let r = 0; r < ${ROUNDS}; r++) {
      const signed = JSON.parse(fs.readFileSync(${JSON.stringify(dir)} + "/r" + r + "-" + process.env.RACER + ".json", "utf-8"));
      fs.writeFileSync(${JSON.stringify(dir)} + "/ready-" + r + "-" + process.env.RACER, "");
      while (!fs.existsSync(${JSON.stringify(dir)} + "/go-" + r)) {}
      fs.appendFileSync(${JSON.stringify(dir)} + "/out-" + r, KA.decide(signed).outcome + "\\n");
    }`;
  const procs: any[] = [];
  const kids = Array.from({ length: N }, (_, i) => new Promise<void>((res, rej) => {
    const c = spawn(process.execPath, ["-r", "ts-node/register", "-e", racer], { cwd: REPO, env: { ...process.env, RACER: String(i) }, stdio: "ignore" });
    procs.push(c);
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`racer exited ${code}`))));
  }));
  kids.forEach((k) => k.catch(() => {}));
  t.after(() => { for (const c of procs) if (c.exitCode === null) c.kill("SIGKILL"); }); // never leave racers spinning
  const wait = async (ok: () => boolean) => { while (!ok()) await new Promise((s) => setTimeout(s, 10)); };
  const count = (p: string) => fs.readdirSync(dir).filter((f) => f.startsWith(p)).length;
  const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean) : []);
  for (let r = 0; r < ROUNDS; r++) {
    kaFounder.approve(KA.decide(genesis.sign(body({ digest: digestOf({ race: r }) }))).requestId, PASS);
    await wait(() => count(`ready-${r}-`) === N);
    fs.writeFileSync(path.join(dir, `go-${r}`), "");
    await wait(() => lines(path.join(dir, `out-${r}`)).length === N);
    const allows = lines(path.join(dir, `out-${r}`)).filter((x) => x === "allow").length;
    assert.equal(allows, 1, `round ${r}: ${allows} requests were allowed by one approval`);
  }
  await Promise.all(kids);
});

// ---------- 3. lockdown ----------

test("deleting the lockdown file doesn't end lockdown; only the Founder's clear does", () => {
  rules([rule("ok", "*", "fs.write", "**", "allow")]);
  KA.reportHostile(null, "test incident");
  fs.rmSync(store.LOCKDOWN_FILE);
  assert.equal(KA.isLockedDown(), true);
  const d = KA.decide(builder.sign(body()));
  assert.equal(d.outcome, "ask");
  assert.match(d.reason, /lockdown/);
  assert.match(kaFounder.lockdownStatus().incidents[0].reason, /hasn't cleared/);
  assert.throws(() => W.clearLockdown("not the passphrase"), /Wrong or missing/);
  assert.equal(KA.isLockedDown(), true);
  assert.equal(W.clearLockdown(PASS), true);
  assert.equal(KA.isLockedDown(), false);
  assert.equal(KA.decide(builder.sign(body())).outcome, "allow");
  // and a new incident locks it again
  KA.reportHostile(null, "again");
  assert.equal(KA.isLockedDown(), true);
});

test("a log that can't be trusted keeps NEXUS locked, and lockdown can't be cleared until it's reviewed", () => {
  rules([rule("ok", "*", "fs.write", "**", "allow")]);
  state.logEvent({ type: "x" });
  fs.writeFileSync(state.HEAD_FILE, "f".repeat(64) + "\n"); // the log no longer matches its head
  assert.equal(KA.isLockedDown(), true);
  assert.equal(KA.decide(builder.sign(body())).outcome, "ask");
  assert.throws(() => W.clearLockdown(PASS), /can't be trusted/);
  W.resetLog(PASS);
  assert.equal(KA.isLockedDown(), false);
});

// ---------- 4. the protected write enforces the decision itself ----------

const plan = { files: [{ path: "a.txt", content: "should only exist with a grant" }] };

test("calling the writer directly, skipping the guard, writes nothing", () => {
  rules([]); // nothing allowed
  const base = path.join(ROOT, "out-direct");
  const snap = scaffold.snapshotProject("direct", plan);
  for (const forged of [undefined, null, {}, { action: "fs.write", target: "project:direct", digest: scaffold.planDigest(base, snap), actor: "genesis", expiresAt: Date.now() + 60_000 }]) {
    assert.throws(() => scaffold.writeProjectConfined(base, snap, forged), (e: any) => e.code === "GUARD_DENIED" && /no grant from the guard/.test(e.message));
  }
  assert.equal(fs.existsSync(base), false, "nothing was created, not even the output folder");
});

test("a grant works once, only for its exact plan, project and output folder", () => {
  rules([rule("ok", "builder", "fs.write", "project:*", "allow")]);
  const base = path.join(ROOT, "out-g");
  const snap = scaffold.snapshotProject("one", plan);
  const other = scaffold.snapshotProject("one", { files: [{ path: "a.txt", content: "different content" }] });
  const elsewhere = scaffold.snapshotProject("two", plan);

  assert.throws(() => scaffold.writeProjectConfined(base, other, grantFor(builder, base, snap)), /different action, target or plan/);
  assert.throws(() => scaffold.writeProjectConfined(base, elsewhere, grantFor(builder, base, snap)), /different action, target or plan/);
  assert.throws(() => scaffold.writeProjectConfined(path.join(ROOT, "out-other-root"), snap, grantFor(builder, base, snap)), /different action, target or plan/);

  const g = grantFor(builder, base, snap);
  assert.equal(scaffold.writeProjectConfined(base, snap, g).filesCreated, 1);
  fs.rmSync(path.join(base, "one"), { recursive: true });
  assert.throws(() => scaffold.writeProjectConfined(base, snap, g), /no grant from the guard/, "a grant can't be reused");
  assert.equal(fs.existsSync(path.join(base, "one")), false);
});

test("an expired grant is refused", () => {
  rules([rule("ok", "builder", "fs.write", "project:*", "allow")]);
  const base = path.join(ROOT, "out-exp");
  const snap = scaffold.snapshotProject("late", plan);
  const g = grantFor(builder, base, snap);
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60_000;
  try {
    assert.throws(() => scaffold.writeProjectConfined(base, snap, g), /expired/);
  } finally {
    Date.now = realNow;
  }
  assert.equal(fs.existsSync(path.join(base, "late")), false);
});

test("denied and pending decisions carry no grant", () => {
  rules([rule("q", "builder", "fs.write", "**", "ask"), rule("n", "genesis", "fs.write", "**", "deny")]);
  const pending = coreGuard(builder.sign(body()));
  const denied = coreGuard(genesis.sign(body()));
  assert.equal(pending.pending, true);
  assert.equal(pending.grant, null);
  assert.equal(denied.allowed, false);
  assert.equal(denied.grant, null);
});
