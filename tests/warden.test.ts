import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// A throwaway git repo stands in for NEXUS, with its own state and rules.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-warden-"));
const REPO = path.join(ROOT, "repo");
const STATE = path.join(ROOT, "state");
const RULES = path.join(REPO, "config", "key-authority.json");
process.env.NEXUS_ROOT = REPO;
process.env.NEXUS_STATE_DIR = STATE;
process.env.NEXUS_RULES_PATH = RULES;

const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, stdio: "pipe" });
fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
fs.mkdirSync(path.join(REPO, "config"), { recursive: true });
fs.writeFileSync(path.join(REPO, "src", "agent.ts"), "export const ok = true;\n");
git("init", "-q");
git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");

const KA = require("../src/genesis/authority/KeyAuthority");
const kaFounder = require("../src/genesis/authority/founder");
const { digestOf } = require("../src/genesis/authority/canonical");
const state = require("../src/genesis/warden/state");
const log = require("../src/genesis/warden/log");
const W = require("../src/genesis/warden/Warden");
const F = require("../src/genesis/warden/founder");

const PASS = "correct horse battery";
const D = digestOf({ plan: "x" });
const req = (over: object = {}) => ({ actor: "genesis", action: "fs.write", target: "project:demo", digest: D, ...over });
const rule = (id: string, actor: string, action: string, target: string, effect: string) => ({ id, actor, action, target, effect });
const rules = (list: object[]) => fs.writeFileSync(RULES, JSON.stringify({ version: 1, rules: list }));

beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.writeFileSync(path.join(REPO, "src", "agent.ts"), "export const ok = true;\n");
  rules([rule("ok", "*", "fs.write", "project:*", "allow")]);
});

// ---------- event log ----------

test("the event log detects edits, truncation, and stays flagged after new appends", () => {
  for (let i = 0; i < 3; i++) state.logEvent({ type: "t", i });
  assert.equal(log.verifyLog(state.LOG_FILE, state.HEAD_FILE).ok, true);

  const lines = fs.readFileSync(state.LOG_FILE, "utf-8").trim().split("\n");
  const edited = JSON.parse(lines[1]); edited.event.i = 99; lines[1] = JSON.stringify(edited);
  fs.writeFileSync(state.LOG_FILE, lines.join("\n") + "\n");
  assert.match(log.verifyLog(state.LOG_FILE, state.HEAD_FILE).reason, /chain broken at entry 1/);

  state.logEvent({ type: "after" });
  assert.equal(log.verifyLog(state.LOG_FILE, state.HEAD_FILE).ok, false);
});

test("deleting the newest log line is caught by the head", () => {
  for (let i = 0; i < 3; i++) state.logEvent({ type: "t", i });
  const lines = fs.readFileSync(state.LOG_FILE, "utf-8").trim().split("\n");
  fs.writeFileSync(state.LOG_FILE, lines.slice(0, 2).join("\n") + "\n");
  assert.match(log.verifyLog(state.LOG_FILE, state.HEAD_FILE).reason, /recorded head/);
});

// ---------- automatic containment ----------

test("a hostile request quarantines that agent at once and Key Authority then denies it", () => {
  assert.equal(KA.decide(req()).outcome, "allow");
  KA.reportHostile({ actor: "genesis", action: "fs.write", target: "project:x", reason: "path traversal" });
  assert.equal(state.getAgent("genesis").status, "quarantined");
  assert.match(KA.decide(req()).reason, /quarantined by the Warden/);
  assert.equal(state.getAgent("savannah").status, "active");
});

test("quarantine voids the agent's pending requests and unused approvals, not others'", () => {
  rules([rule("q", "*", "fs.write", "**", "ask")]);
  const g = KA.decide(req()).requestId;
  KA.decide(req({ actor: "builder", digest: digestOf({ other: 1 }) }));
  kaFounder.approve(g);
  state.quarantine("genesis", "test");
  assert.equal(kaFounder.listPending().length, 1);
  assert.equal(kaFounder.listPending()[0].actor, "builder");
  assert.equal(fs.readdirSync(state.VOIDED_DIR).length, 1);
});

test("repeated rule denials quarantine an agent", () => {
  rules([rule("n", "genesis", "key.use", "**", "deny"), rule("ok", "*", "fs.write", "**", "allow")]);
  for (let i = 0; i < state.THRESHOLDS.denials - 1; i++) KA.decide(req({ action: "key.use", target: "key:x" }));
  assert.equal(state.getAgent("genesis").status, "active");
  KA.decide(req({ action: "key.use", target: "key:x" }));
  assert.equal(state.getAgent("genesis").status, "quarantined");
  assert.equal(KA.decide(req()).outcome, "deny");
});

test("an invalid agent name is treated as quarantined", () => {
  assert.equal(KA.decide(req({ actor: "../genesis" })).outcome, "deny");
  assert.equal(KA.decide(req({ actor: "Genesis" })).outcome, "deny");
});

// ---------- code integrity ----------

test("unpinned code is reported but does not block", () => {
  const r = W.check();
  assert.equal(r.pinned, false);
  assert.equal(r.integrity.ok, true);
  assert.equal(W.startupGate("genesis").ok, true);
});

test("changed code after pinning quarantines every agent and blocks startup", () => {
  F.setPassphrase(PASS);
  F.pin(PASS);
  assert.equal(W.check().integrity.ok, true);

  fs.writeFileSync(path.join(REPO, "src", "agent.ts"), "export const ok = false; // tampered\n");
  const r = W.check();
  assert.equal(r.integrity.ok, false);
  assert.match(r.integrity.detail, /changed: src\/agent\.ts/);
  for (const a of state.KNOWN_AGENTS) assert.equal(state.getAgent(a).status, "quarantined");
  assert.equal(W.startupGate("genesis").ok, false);
  assert.equal(KA.isLockedDown(), true);
});

test("a new file planted in the code is caught too", () => {
  F.setPassphrase(PASS);
  F.pin(PASS);
  fs.writeFileSync(path.join(REPO, "src", "backdoor.ts"), "export {};\n");
  assert.match(W.check().integrity.detail, /added: src\/backdoor\.ts/);
  fs.rmSync(path.join(REPO, "src", "backdoor.ts"));
});

test("editing the rules file after pinning counts as a code change", () => {
  F.setPassphrase(PASS);
  F.pin(PASS);
  rules([rule("all", "*", "*", "**", "allow")]);
  assert.match(W.check().integrity.detail, /config\/key-authority\.json/);
});

// ---------- founder recovery ----------

test("recovery: restore code, release to probation, then trust", () => {
  F.setPassphrase(PASS);
  F.pin(PASS);
  fs.writeFileSync(path.join(REPO, "src", "agent.ts"), "tampered\n");
  W.check();

  assert.throws(() => F.release("genesis", PASS), /Code still differs/);
  fs.writeFileSync(path.join(REPO, "src", "agent.ts"), "export const ok = true;\n");

  assert.throws(() => F.release("genesis", "wrong passphrase!!"), /Wrong passphrase/);
  F.release("genesis", PASS);
  assert.equal(state.getAgent("genesis").status, "probation");
  assert.throws(() => F.clearLockdown(PASS), /still quarantined: savannah/);

  F.release("savannah", PASS);
  F.clearLockdown(PASS);
  const d = KA.decide(req());
  assert.equal(d.outcome, "ask");
  assert.match(d.reason, /on probation/);

  F.trust("genesis", PASS);
  assert.equal(KA.decide(req()).outcome, "allow");
  assert.equal(W.startupGate("genesis").ok, true);
});

test("an agent cannot be trusted straight out of quarantine", () => {
  F.setPassphrase(PASS);
  state.quarantine("genesis", "test");
  assert.throws(() => F.trust("genesis", PASS), /only an agent on probation/);
});

test("passphrase rules: minimum length, and changing it needs the old one", () => {
  assert.throws(() => F.setPassphrase("short"), /at least 10/);
  F.setPassphrase(PASS);
  assert.throws(() => F.setPassphrase("another long passphrase", "wrong one here"), /current passphrase is wrong/);
  F.setPassphrase("another long passphrase", PASS);
  assert.equal(F.verifyPassphrase(PASS), false);
  assert.equal(F.verifyPassphrase("another long passphrase"), true);
});

test("a tampered log quarantines everyone until the founder archives it", () => {
  F.setPassphrase(PASS);
  state.logEvent({ type: "x" });
  fs.writeFileSync(state.HEAD_FILE, "f".repeat(64) + "\n");
  assert.equal(W.check().log.ok, false);
  assert.equal(state.getAgent("genesis").status, "quarantined");
  assert.throws(() => F.release("genesis", PASS), /event log is still damaged/);
  F.resetLog(PASS);
  F.release("genesis", PASS);
  assert.equal(state.getAgent("genesis").status, "probation");
});

// ---------- structure ----------

test("only the Warden CLI imports the Warden founder module", () => {
  const src = path.join(__dirname, "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(ent.name) && !p.endsWith(path.join("warden", "cli.ts")) && !p.includes(path.join("authority", ""))) {
        if (/["'][^"']*warden\/founder["']|["']\.\/founder["']/.test(fs.readFileSync(p, "utf-8"))) offenders.push(p);
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});
