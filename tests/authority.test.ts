import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Key Authority reads its paths once at load, so set them first.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ka-"));
const RULES = path.join(ROOT, "rules.json");
const STATE = path.join(ROOT, "state");
process.env.NEXUS_RULES_PATH = RULES;
process.env.NEXUS_STATE_DIR = STATE;

const KA = require("../src/genesis/authority/KeyAuthority");
const founder = require("../src/genesis/authority/founder");
const { digestOf } = require("../src/genesis/authority/canonical");
const { coreGuard } = require("../src/genesis/guards/coreGuard");
const { ScaffoldEngine, ScaffoldError } = require("../src/genesis/scaffold");

const D1 = digestOf({ plan: 1 });
const D2 = digestOf({ plan: 2 });

function rules(list: object[] | string) {
  fs.writeFileSync(RULES, typeof list === "string" ? list : JSON.stringify({ version: 1, rules: list }));
}
const rule = (id: string, actor: string, action: string, target: string, effect: string) => ({ id, actor, action, target, effect });
const req = (over: object = {}) => ({ actor: "genesis", action: "fs.write", target: "project:demo", digest: D1, summary: "demo", ...over });

beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(RULES, { force: true });
});

// ---------- rules ----------

test("no rules file denies everything", () => {
  assert.equal(KA.decide(req()).outcome, "deny");
});

test("an invalid rules file denies everything", () => {
  rules("{not json");
  assert.match(KA.decide(req()).reason, /not valid JSON/);
  rules([rule("a", "genesis", "fs.write", "**", "maybe")]);
  assert.equal(KA.decide(req()).outcome, "deny");
  rules([rule("a", "genesis", "fs.delete", "**", "allow")]);
  assert.equal(KA.decide(req()).outcome, "deny");
  rules([rule("a", "genesis", "fs.write", "**", "allow"), rule("a", "genesis", "fs.write", "**", "allow")]);
  assert.match(KA.decide(req()).reason, /duplicate id/);
});

test("a request no rule matches is denied", () => {
  rules([rule("keys", "*", "key.use", "**", "allow")]);
  assert.match(KA.decide(req()).reason, /no rule matches/);
});

test("an allow rule allows, and rule edits apply without a restart", () => {
  rules([rule("ok", "genesis", "fs.write", "project:*", "allow")]);
  assert.equal(KA.decide(req()).outcome, "allow");
  rules([]);
  assert.equal(KA.decide(req()).outcome, "deny");
});

test("deny beats ask, and ask beats allow", () => {
  rules([rule("y", "*", "*", "**", "allow"), rule("n", "genesis", "fs.write", "project:*", "deny")]);
  assert.match(KA.decide(req()).reason, /rule n/);
  rules([rule("y", "*", "*", "**", "allow"), rule("q", "genesis", "*", "**", "ask")]);
  assert.equal(KA.decide(req()).outcome, "ask");
});

test("target patterns: * stays within a segment, ** crosses them", () => {
  assert.equal(KA.matchPattern("project:*", "project:demo"), true);
  assert.equal(KA.matchPattern("project:*", "project:a/b"), false);
  assert.equal(KA.matchPattern("project:**", "project:a/b"), true);
  assert.equal(KA.matchPattern("project:demo", "project:demo2"), false);
  assert.equal(KA.matchPattern("a.b", "axb"), false);
});

test("requests without a valid digest or with an unknown action are denied", () => {
  rules([rule("y", "*", "*", "**", "allow")]);
  assert.equal(KA.decide(req({ digest: "abc" })).outcome, "deny");
  assert.equal(KA.decide(req({ action: "fs.delete" })).outcome, "deny");
  assert.equal(coreGuard({ actor: "genesis", action: "fs.write", target: "project:demo" }).allowed, false);
});

// ---------- founder approval ----------

test("ask records one pending request and reuses it for the same plan", () => {
  rules([rule("q", "genesis", "fs.write", "**", "ask")]);
  const a = KA.decide(req());
  const b = KA.decide(req());
  assert.equal(a.outcome, "ask");
  assert.equal(a.requestId, b.requestId);
  assert.equal(founder.listPending().length, 1);
  assert.equal(founder.listPending()[0].summary, "demo");
});

test("an approval allows exactly once", () => {
  rules([rule("q", "genesis", "fs.write", "**", "ask")]);
  const id = KA.decide(req()).requestId;
  founder.approve(id);
  assert.equal(founder.listPending().length, 0);
  assert.equal(KA.decide(req()).outcome, "allow");
  assert.equal(KA.decide(req()).outcome, "ask");
});

test("an approval covers only that exact actor, action, target and plan", () => {
  rules([rule("q", "*", "*", "**", "ask")]);
  founder.approve(KA.decide(req()).requestId);
  assert.equal(KA.decide(req({ digest: D2 })).outcome, "ask");
  assert.equal(KA.decide(req({ target: "project:other" })).outcome, "ask");
  assert.equal(KA.decide(req({ actor: "savannah" })).outcome, "ask");
  assert.equal(KA.decide(req()).outcome, "allow");
});

test("an expired approval does not allow", () => {
  rules([rule("q", "genesis", "fs.write", "**", "ask")]);
  founder.approve(KA.decide(req()).requestId, -1);
  assert.equal(KA.decide(req()).outcome, "ask");
});

test("a deny rule wins even over an approval", () => {
  rules([rule("q", "genesis", "fs.write", "**", "ask")]);
  founder.approve(KA.decide(req()).requestId);
  rules([rule("n", "genesis", "fs.write", "**", "deny")]);
  assert.equal(KA.decide(req()).outcome, "deny");
});

test("rejecting a request removes it; bad ids are refused", () => {
  rules([rule("q", "genesis", "fs.write", "**", "ask")]);
  founder.reject(KA.decide(req()).requestId);
  assert.equal(founder.listPending().length, 0);
  assert.throws(() => founder.approve("../../etc"));
  assert.throws(() => founder.approve("deadbeef"));
});

// ---------- Savannah and lockdown ----------

test("Savannah's challenge turns allow into ask for that plan only, and cannot approve", () => {
  rules([rule("ok", "genesis", "fs.write", "**", "allow")]);
  assert.equal(KA.challenge({ actor: "genesis", digest: D1, reason: "x" }), false);
  assert.equal(KA.challenge({ actor: "savannah", digest: D1, reason: "writes outside the plan" }), true);
  assert.equal(KA.decide(req()).outcome, "ask");
  assert.equal(KA.decide(req({ digest: D2 })).outcome, "allow");
  rules([rule("n", "genesis", "fs.write", "**", "deny")]);
  assert.equal(KA.decide(req()).outcome, "deny");
});

test("a hostile report puts NEXUS in lockdown until the founder clears it", () => {
  rules([rule("ok", "genesis", "fs.write", "**", "allow")]);
  KA.reportHostile({ actor: "genesis", action: "fs.write", target: "project:x", reason: "traversal" });
  assert.equal(KA.isLockedDown(), true);
  const d = KA.decide(req());
  assert.equal(d.outcome, "ask");
  assert.match(d.reason, /lockdown/);
  assert.equal(founder.lockdownStatus().incidents.length, 1);
  founder.clearLockdown();
  assert.equal(KA.decide(req()).outcome, "allow");
});

// ---------- end to end through ScaffoldEngine ----------

function engine() {
  return new ScaffoldEngine(path.join(ROOT, "out-" + Math.random().toString(16).slice(2)));
}
const files = (content = "hello") => ({ files: [{ path: "README.md", content }] });
function code(fn: () => unknown): { code: string; requestId?: string } {
  try { fn(); } catch (e: any) { if (e instanceof ScaffoldError) return { code: e.code, requestId: e.requestId }; throw e; }
  return { code: "NO_ERROR" };
}

test("an allow rule lets Genesis build a new project", () => {
  rules([rule("ok", "genesis", "fs.write", "project:*", "allow")]);
  const e = engine();
  const r = e.createProject("demo", files());
  assert.equal(r.filesCreated, 1);
  assert.equal(fs.readFileSync(path.join(e.basePath, "demo/README.md"), "utf-8"), "hello");
});

test("an ask rule blocks the build until the founder approves that exact plan", () => {
  rules([rule("q", "genesis", "fs.write", "project:*", "ask")]);
  const e = engine();
  const first = code(() => e.createProject("demo", files()));
  assert.equal(first.code, "APPROVAL_REQUIRED");
  assert.equal(fs.existsSync(path.join(e.basePath, "demo")), false);
  assert.match(founder.getPending(first.requestId).summary, /README\.md \(5 bytes\)/);

  founder.approve(first.requestId);
  // a changed plan is not covered by the approval
  assert.equal(code(() => e.createProject("demo", files("changed"))).code, "APPROVAL_REQUIRED");
  // the approved plan goes through
  assert.equal(e.createProject("demo", files()).filesCreated, 1);
});

test("the same plan into a different output root needs its own approval", () => {
  rules([rule("q", "genesis", "fs.write", "project:*", "ask")]);
  const a = engine(), b = engine();
  founder.approve(code(() => a.createProject("demo", files())).requestId);
  assert.equal(code(() => b.createProject("demo", files())).code, "APPROVAL_REQUIRED");
});

test("a traversal attempt triggers lockdown, so even allowed builds then need approval", () => {
  rules([rule("ok", "genesis", "fs.write", "project:*", "allow")]);
  const e = engine();
  assert.equal(code(() => e.createProject("evil", { files: [{ path: "../../escape.txt", content: "x" }] })).code, "INVALID_PATH");
  assert.equal(KA.isLockedDown(), true);
  assert.equal(code(() => e.createProject("demo", files())).code, "APPROVAL_REQUIRED");
});

test("Savannah cannot build even with a permissive allow rule if a deny rule names her", () => {
  rules([rule("all", "*", "fs.write", "**", "allow"), rule("s", "savannah", "*", "**", "deny")]);
  assert.equal(code(() => engine().createProject("demo", files(), "savannah")).code, "GUARD_DENIED");
});

// ---------- structure ----------

test("only the founder CLI imports the founder module", () => {
  const src = path.join(__dirname, "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(ent.name) && !p.endsWith(path.join("authority", "cli.ts"))) {
        if (/from\s+["'][^"']*founder["']|require\(\s*["'][^"']*founder["']\s*\)/.test(fs.readFileSync(p, "utf-8"))) offenders.push(p);
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});

test("the example rules file is valid", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "key-authority.example.json"), "utf-8"));
  const r = KA.parseRules(raw);
  assert.equal(r.ok, true);
});
