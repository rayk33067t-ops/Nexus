import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// Agent identity and Founder authorization. Each test starts from empty state.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred-"));
const RULES = path.join(ROOT, "rules.json");
const STATE = path.join(ROOT, "state");
process.env.NEXUS_RULES_PATH = RULES;
process.env.NEXUS_STATE_DIR = STATE;

const KA = require("../src/genesis/authority/KeyAuthority");
const kaFounder = require("../src/genesis/authority/founder");
const creds = require("../src/genesis/authority/credentials");
const store = require("../src/genesis/authority/store");
const { digestOf } = require("../src/genesis/authority/canonical");
const { coreGuard } = require("../src/genesis/guards/coreGuard");
const { ScaffoldEngine, ScaffoldError } = require("../src/genesis/scaffold");
const W = require("../src/genesis/warden/founder");
const state = require("../src/genesis/warden/state");
const passphrase = require("../src/genesis/warden/passphrase");
const { readLog } = require("../src/genesis/warden/log");
const { issue, founder, PASS } = require("./support");

const D1 = digestOf({ plan: 1 });
const rule = (id: string, actor: string, action: string, target: string, effect: string) => ({ id, actor, action, target, effect });
const rules = (list: object[]) => fs.writeFileSync(RULES, JSON.stringify({ version: 1, rules: list }));
const body = (over: object = {}) => ({ action: "fs.write", target: "project:demo", digest: D1, summary: "demo", ...over });

let genesis: any, savannah: any;
beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  rules([rule("ok", "*", "fs.write", "project:*", "allow")]);
  genesis = issue("genesis");
  savannah = issue("savannah");
});

const events = () => readLog(state.LOG_FILE).map((e: any) => e.event);
const authDenials = () => events().filter((e: any) => e.type === "auth-denied");

/** A key pair nobody issued, used to sign like an agent would. */
function rogueSigner() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return creds.signerFromPem(privateKey.export({ type: "pkcs8", format: "pem" }) as string);
}

/** Sign an arbitrary payload with an agent's key, presenting any public key. */
function signAs(agent: string, unsigned: any) {
  const priv = crypto.createPrivateKey(fs.readFileSync(creds.keyFile(agent), "utf-8"));
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(creds.signedPayload(unsigned), "utf-8"), priv).toString("base64") };
}

/** Every file under the state folder that changes when protected state changes. */
function protectedState(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const rel = path.relative(STATE, p);
      if (ent.isDirectory()) { if (rel !== "nonces") walk(p); continue; }
      if (rel === path.join("warden", "events.log") || rel === path.join("warden", "events.head")) continue; // the audit trail is meant to grow
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  if (fs.existsSync(STATE)) walk(STATE);
  return out;
}

test("signerFromPem exports the public key matching its signature", () => {
  const signer = rogueSigner();
  const signed = signer.sign(body());
  const { signature, ...unsigned } = signed;

  const publicKey = crypto.createPublicKey({
    key: Buffer.from(signer.publicKey, "base64"),
    format: "der",
    type: "spki",
  });

  assert.equal(
    crypto.verify(
      null,
      Buffer.from(creds.signedPayload(unsigned), "utf-8"),
      publicKey,
      Buffer.from(signature, "base64"),
    ),
    true,
  );
});

// 1
test("a forged Genesis identity is refused: a key nobody issued, or just the name", () => {
  const forged = rogueSigner().sign(body());
  const d = KA.decide(forged);
  assert.equal(d.outcome, "deny");
  assert.match(d.reason, /unknown credential/);
  assert.equal(d.actor, null);

  const named = KA.decide({ actor: "genesis", ...body() });
  assert.equal(named.outcome, "deny");
  assert.equal(named.actor, null);
  // nothing was pinned on Genesis
  assert.equal(state.getAgent("genesis").status, "active");
  assert.ok(authDenials().every((e: any) => e.credentialOf === null));
});

// 2
test("nobody can become the Founder: not by name, not by credential", () => {
  assert.equal(KA.decide({ actor: "founder", ...body() }).outcome, "deny");
  assert.equal(coreGuard({ ...genesis.sign(body()), actor: "founder" }).allowed, false);
  assert.throws(() => W.issueCredential("founder", PASS), /reserved/);
  assert.throws(() => W.issueCredential("Founder", PASS), /reserved|not an agent name/);

  // even a credential record planted for "founder" is refused
  const rogue = rogueSigner();
  const der = Buffer.from(rogue.publicKey, "base64");
  const fp = creds.fingerprintOf(der);
  store.writeJSONAtomic(creds.recordFile(fp), { agent: "founder", fingerprint: fp, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null });
  const d = KA.decide(rogue.sign(body()));
  assert.equal(d.outcome, "deny");
  assert.match(d.reason, /reserved or invalid identity/);
});

// 3
test("an agent can't use another agent's name or public key", () => {
  // Savannah's signed request that also claims to be Genesis
  assert.equal(KA.decide({ ...savannah.sign(body()), actor: "genesis" }).outcome, "deny");
  // Savannah signing while presenting Genesis's (public) key
  const unsigned = { v: 1, publicKey: genesis.publicKey, nonce: crypto.randomBytes(16).toString("hex"), issuedAt: Date.now(), ...body() };
  const d = KA.decide(signAs("savannah", unsigned));
  assert.equal(d.outcome, "deny");
  assert.match(d.reason, /invalid signature/);
  assert.equal(state.getAgent("genesis").status, "active");
});

// 4
test("a valid credential binds the request to exactly its own agent", () => {
  assert.equal(KA.decide(genesis.sign(body())).actor, "genesis");
  assert.equal(KA.decide(savannah.sign(body())).actor, "savannah");
  rules([rule("q", "*", "fs.write", "**", "ask")]);
  KA.decide(savannah.sign(body()));
  assert.equal(kaFounder.listPending()[0].actor, "savannah");
  assert.equal(coreGuard(genesis.sign(body({ target: "project:other" }))).actor, "genesis");
});

// 5
test("a signature made with the wrong key is refused", () => {
  const wrong = rogueSigner().sign(body());
  const d = KA.decide({ ...wrong, publicKey: genesis.publicKey });
  assert.equal(d.outcome, "deny");
  assert.match(d.reason, /invalid signature/);
});

// 6
test("a damaged signature is refused", () => {
  const r = genesis.sign(body());
  const sig = Buffer.from(r.signature, "base64");
  sig[0] ^= 0xff;
  assert.match(KA.decide({ ...r, signature: sig.toString("base64") }).reason, /invalid signature/);
  assert.match(KA.decide({ ...genesis.sign(body()), signature: "not base64 at all!!" }).reason, /invalid signature|malformed/);
});

// 7
test("an unsigned request is refused and not pinned on anyone", () => {
  const d = KA.decide(body());
  assert.equal(d.outcome, "deny");
  assert.match(d.reason, /unsigned request/);
  assert.equal(coreGuard(body()).allowed, false);
  const last = authDenials().at(-1);
  assert.equal(last.reason, "unsigned request");
  assert.equal(last.credentialOf, null);
  assert.equal(last.credential, null);
});

// 8
test("changing any signed field after signing breaks the signature", () => {
  for (const change of [{ target: "project:elsewhere" }, { digest: digestOf({ plan: 2 }) }, { summary: "something else" }, { action: "key.use" }, { issuedAt: Date.now() + 1 }]) {
    const d = KA.decide({ ...genesis.sign(body()), ...change });
    assert.equal(d.outcome, "deny", JSON.stringify(change));
    assert.match(d.reason, /invalid signature/, JSON.stringify(change));
  }
});

// 9
test("a signed request can be used once; replays and stale requests are refused", () => {
  const r = genesis.sign(body());
  assert.equal(KA.decide(r).outcome, "allow");
  const again = KA.decide(r);
  assert.equal(again.outcome, "deny");
  assert.match(again.reason, /replayed/);
  assert.equal(coreGuard(r).allowed, false);

  const fresh = genesis.sign(body());
  const later = creds.authenticate(fresh, Date.now() + creds.MAX_SKEW_MS + 60_000);
  assert.equal(later.ok, false);
  assert.match(later.reason, /too old/);
});

// 10
test("a revoked credential is refused, and a replaced one stops working", () => {
  const before = genesis.sign(body());
  assert.equal(W.revokeCredential("genesis", PASS), 1);
  assert.match(KA.decide(before).reason, /credential revoked/);
  assert.equal(fs.existsSync(creds.keyFile("genesis")), false);

  const fresh = issue("genesis");
  assert.equal(KA.decide(fresh.sign(body())).outcome, "allow");
  const old = savannah;
  issue("savannah"); // re-issuing replaces the old credential
  assert.match(KA.decide(old.sign(body())).reason, /credential revoked/);
});

// 11
test("an expired credential is refused", () => {
  const short = issue("builder", 1);
  const r = short.sign(body());
  const after = creds.authenticate(r, Date.now() + 2 * 86_400_000);
  assert.equal(after.ok, false);
  assert.match(after.reason, /expired/);
  assert.equal(after.credentialOf, "builder");
});

// 12 + 13
test("every Founder operation refuses a missing or wrong passphrase and changes nothing", () => {
  rules([rule("q", "genesis", "fs.write", "**", "ask")]);
  const id = KA.decide(genesis.sign(body())).requestId;
  state.quarantine("savannah", "test");

  const ops: [string, (p: any) => unknown][] = [
    ["approve", (p) => kaFounder.approve(id, p)],
    ["reject", (p) => kaFounder.reject(id, p)],
    ["release", (p) => W.release("savannah", p)],
    ["trust", (p) => W.trust("savannah", p)],
    ["clear lockdown", (p) => W.clearLockdown(p)],
    ["pin", (p) => W.pin(p)],
    ["reset log", (p) => W.resetLog(p)],
    ["issue", (p) => W.issueCredential("builder", p)],
    ["revoke", (p) => W.revokeCredential("genesis", p)],
    ["change passphrase", (p) => passphrase.setPassphrase("a brand new passphrase", p)],
  ];
  for (const bad of [undefined, "", "wrong passphrase 123", PASS + " "]) {
    for (const [name, op] of ops) {
      const before = protectedState();
      assert.throws(() => op(bad), /Wrong or missing founder passphrase/, `${name} with ${JSON.stringify(bad)}`);
      assert.deepEqual(protectedState(), before, `${name} changed state without the passphrase`);
    }
  }
  const refusals = events().filter((e: any) => e.type === "founder-auth-failed");
  assert.equal(refusals.length, ops.length * 4);
  assert.ok(refusals.some((e: any) => e.reason === "missing passphrase"));
  assert.ok(refusals.some((e: any) => e.reason === "wrong passphrase"));

  // and the right passphrase does exactly the one thing asked
  kaFounder.approve(id, PASS);
  assert.equal(kaFounder.listPending().length, 0);
  assert.equal(state.getAgent("savannah").status, "quarantined");
});

// 14
test("internal calls can't bypass Founder authorization", () => {
  assert.equal(typeof kaFounder.clearLockdown, "undefined", "the passphrase-free lockdown clear is gone");
  assert.equal(typeof state.setAgent, "undefined", "agent status can't be set directly");

  state.quarantine("genesis", "test");
  const forgedProof = Object.freeze({ operation: "agent.release", at: new Date().toISOString() });
  assert.throws(() => state.restoreAgent({ agent: "genesis", status: "active", since: "", reasons: [] }, forgedProof), /needs the Founder passphrase/);
  // a real proof for a different operation doesn't work either
  const approveProof = passphrase.requireFounder(PASS, "request.approve");
  assert.throws(() => state.restoreAgent({ agent: "genesis", status: "active", since: "", reasons: [] }, approveProof), /needs the Founder passphrase/);
  // and a real one works exactly once
  const proof = passphrase.requireFounder(PASS, "agent.trust");
  state.restoreAgent({ agent: "genesis", status: "probation", since: "", reasons: [] }, proof);
  assert.throws(() => state.restoreAgent({ agent: "genesis", status: "active", since: "", reasons: [] }, proof), /needs the Founder passphrase/);
  assert.equal(state.getAgent("genesis").status, "probation");
  // quarantine (stricter) never needs the Founder
  assert.throws(() => state.restoreAgent({ agent: "genesis", status: "quarantined", since: "", reasons: [] }, null), /quarantine\(\)/);
});

// 15
test("lockdown can only be cleared through the Warden, with the passphrase", () => {
  KA.reportHostile(null, "test incident");
  assert.equal(KA.isLockedDown(), true);
  assert.throws(() => W.clearLockdown("not the passphrase"), /Wrong or missing/);
  assert.equal(KA.isLockedDown(), true);
  assert.equal(W.clearLockdown(PASS), true);
  assert.equal(KA.isLockedDown(), false);
  assert.ok(events().some((e: any) => e.type === "lockdown-cleared"));

  // supplementary: no other source file removes the lockdown file
  const src = path.join(__dirname, "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.ts$/.test(ent.name) && !p.endsWith(path.join("warden", "founder.ts"))) {
        if (/(rmSync|unlinkSync|renameSync)\(\s*LOCKDOWN_FILE/.test(fs.readFileSync(p, "utf-8"))) offenders.push(p);
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});

// 16
test("refused requests and Founder attempts are recorded, with attribution only when proven", () => {
  KA.decide(body());                                   // unsigned
  KA.decide(rogueSigner().sign(body()));               // unknown key
  KA.decide({ ...savannah.sign(body()), actor: "genesis" }); // names an actor
  const old = genesis.sign(body());
  W.revokeCredential("genesis", PASS);
  KA.decide(old);                                      // revoked: the key is known, so whose it was is recorded
  try { W.release("genesis", "nope nope nope"); } catch { /* expected */ }

  const denied = authDenials();
  assert.deepEqual(denied.map((e: any) => e.reason), [
    "unsigned request",
    "unknown credential",
    "requests may not name their own actor; identity comes from the signature",
    "credential revoked",
  ]);
  assert.deepEqual(denied.map((e: any) => e.credentialOf), [null, null, null, "genesis"]);
  assert.equal(denied[2].claimedActor, "genesis");
  assert.ok(events().some((e: any) => e.type === "founder-auth-failed" && e.operation === "agent.release"));
  // a revoked key's use is recorded, but doesn't count against the agent
  assert.equal(state.getAgent("genesis").status, "active");
});

// 17
test("no key or passphrase leaks into logs, records or errors", () => {
  const keyPem = fs.readFileSync(creds.keyFile("genesis"), "utf-8");
  const keyBody = keyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const secrets = [PASS, keyBody, "wrong passphrase 456"];

  const messages: string[] = [];
  for (const attempt of [
    () => W.release("genesis", "wrong passphrase 456"),
    () => W.issueCredential("founder", PASS),
    () => kaFounder.approve("deadbeef", "wrong passphrase 456"),
    () => creds.loadAgentSigner("nobody"),
  ]) {
    try { attempt(); } catch (e: any) { messages.push(String(e?.message)); }
  }
  KA.decide({ ...genesis.sign(body()), signature: "AAAA" });
  KA.decide(body());

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (path.dirname(p) !== creds.KEYS_DIR) files.push(p);   // the key files themselves hold keys
    }
  };
  walk(STATE);
  for (const s of secrets) {
    for (const m of messages) assert.ok(!m.includes(s), `an error message contains a secret: ${m}`);
    for (const f of files) assert.ok(!fs.readFileSync(f, "utf-8").includes(s), `${path.relative(STATE, f)} contains a secret`);
  }
  // only the agent's own key file holds its key, and only this user can read it
  assert.equal(fs.statSync(creds.keyFile("genesis")).mode & 0o077, 0);
  assert.equal(fs.statSync(creds.KEYS_DIR).mode & 0o077, 0);
  // Key Authority's record is the fingerprint only
  const rec = creds.activeCredential("genesis");
  assert.deepEqual(Object.keys(rec).sort(), ["agent", "expiresAt", "fingerprint", "issuedAt", "revokedAt"]);
});

// 18
test("Genesis keeps working under least privilege, and only within it", () => {
  rules([rule("genesis-new-projects", "genesis", "fs.write", "project:*", "allow")]);
  const base = path.join(ROOT, "out-" + crypto.randomBytes(4).toString("hex"));
  const r = new ScaffoldEngine(base, genesis).createProject("demo", { files: [{ path: "README.md", content: "hi" }] });
  assert.equal(r.filesCreated, 1);
  assert.equal(KA.decide(genesis.sign(body({ action: "key.use", target: "key:openai" }))).outcome, "deny");
  assert.equal(KA.decide(genesis.sign(body({ action: "chronicle.append", target: "chronicle:day" }))).outcome, "deny");
  assert.equal(KA.decide(genesis.sign(body({ target: "project:a/b" }))).outcome, "deny");
  assert.equal(KA.decide(savannah.sign(body())).outcome, "deny");
  try { new ScaffoldEngine(base, savannah).createProject("other", { files: [{ path: "a", content: "a" }] }); assert.fail("savannah built"); }
  catch (e: any) { assert.ok(e instanceof ScaffoldError && e.code === "GUARD_DENIED"); }
});

test("NEXUS credentials are separate from external AI-provider credentials", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-not-a-real-key";
  process.env.OPENAI_API_KEY = "sk-not-a-real-key";
  try {
    const d = KA.decide({ ...body(), v: 1, publicKey: process.env.ANTHROPIC_API_KEY, nonce: "0".repeat(32), issuedAt: Date.now(), signature: "AAAA" });
    assert.equal(d.outcome, "deny");
    assert.match(d.reason, /not a valid NEXUS public key/);
    assert.throws(() => creds.signerFromPem(process.env.OPENAI_API_KEY));
    // supplementary: the credential code never reads keys from the environment
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "genesis", "authority", "credentials.ts"), "utf-8");
    assert.doesNotMatch(src, /process\.env/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }
});

test("a Warden-issued credential is required before an agent can sign at all", () => {
  founder();
  assert.throws(() => creds.loadAgentSigner("builder"), /No credential issued for builder/);
  assert.throws(() => creds.loadAgentSigner("founder"), /Not a valid agent name/);
});
