import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// The NEXUS Key Vault. Each test starts from empty state.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vault-"));
const STATE = path.join(ROOT, "state");
process.env.NEXUS_RULES_PATH = path.join(ROOT, "rules.json");
process.env.NEXUS_STATE_DIR = STATE;

const V = require("../src/genesis/vault/keyVault");
const creds = require("../src/genesis/authority/credentials");
const W = require("../src/genesis/warden/founder");
const { readLog } = require("../src/genesis/warden/log");
const { LOG_FILE } = require("../src/genesis/warden/state");
const { issue, PASS } = require("./support");

const vaultText = () => fs.readFileSync(V.VAULT_FILE, "utf-8");
const pemOf = (agent: string) => fs.readFileSync(creds.keyFile(agent), "utf-8");

beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  issue("genesis");
  issue("savannah");
});

test("each agent gets its own drawer, and the vault file holds no readable key", () => {
  V.sealAgent("genesis", PASS);
  V.sealAgent("savannah", PASS);
  const labels = V.listDrawers();
  assert.deepEqual(labels.map((d: any) => d.agent), ["genesis", "savannah"]);
  assert.ok(labels.every((d: any) => d.credential === "active"));

  const raw = vaultText();
  for (const agent of ["genesis", "savannah"]) {
    const pem = pemOf(agent);
    const body = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
    assert.ok(!raw.includes(body), `${agent}'s key must not appear in the vault file`);
  }
  assert.ok(!raw.includes("PRIVATE KEY"));
  assert.ok(!raw.includes(PASS));
  // Separate seals: separate salts, IVs and sealed bytes.
  const v = JSON.parse(raw);
  assert.notEqual(v.drawers.genesis.kdf.salt, v.drawers.savannah.kdf.salt);
  assert.notEqual(v.drawers.genesis.iv, v.drawers.savannah.iv);
});

test("only the Founder passphrase opens a drawer, and every refusal is logged", () => {
  V.sealAgent("genesis", PASS);
  assert.throws(() => V.checkDrawer("genesis", "wrong passphrase!!"), /passphrase/);
  assert.throws(() => V.restoreAgent("genesis", ""), /passphrase/);
  assert.throws(() => V.sealAgent("savannah", undefined), /passphrase/);
  assert.equal(V.checkDrawer("genesis", PASS), true);

  const book = V.logbook();
  assert.ok(book.ok);
  const refused = book.entries.filter((e: any) => e.event.type === "vault-refused");
  assert.equal(refused.length, 3);
  // The Warden's own log records the failed Founder checks too.
  assert.ok(readLog(LOG_FILE).some((e: any) => e.event.type === "founder-auth-failed" && e.event.operation === "vault.check"));
  // Neither log ever holds the passphrase or a key.
  const logs = fs.readFileSync(V.VAULT_LOG, "utf-8") + fs.readFileSync(LOG_FILE, "utf-8");
  assert.ok(!logs.includes(PASS) && !logs.includes("wrong passphrase!!") && !logs.includes("PRIVATE KEY"));
});

test("a restored key is the same identity: it signs and Key Authority accepts it", () => {
  V.sealAgent("genesis", PASS);
  const before = pemOf("genesis");
  fs.rmSync(creds.keyFile("genesis")); // the phone was lost
  V.restoreAgent("genesis", PASS);
  assert.equal(pemOf("genesis"), before);
  assert.equal(fs.statSync(creds.keyFile("genesis")).mode & 0o777, 0o600);

  const signer = creds.loadAgentSigner("genesis");
  const r = creds.authenticate(signer.sign({ action: "fs.write", target: "project:x", digest: "sha256:" + "a".repeat(64) }));
  assert.equal(r.ok, true);
  assert.equal(r.agent, "genesis");
});

test("restore never overwrites a key already on the device", () => {
  V.sealAgent("genesis", PASS);
  const before = pemOf("genesis");
  assert.throws(() => V.restoreAgent("genesis", PASS), (e: any) => e.code === "KEY_EXISTS");
  assert.equal(pemOf("genesis"), before);
});

test("a changed byte, or a key moved into another agent's drawer, will not open", () => {
  V.sealAgent("genesis", PASS);
  V.sealAgent("savannah", PASS);
  const original = vaultText();

  // Move Genesis's sealed key into Savannah's drawer.
  const swapped = JSON.parse(original);
  for (const k of ["kdf", "iv", "tag", "sealed"]) swapped.drawers.savannah[k] = swapped.drawers.genesis[k];
  fs.writeFileSync(V.VAULT_FILE, JSON.stringify(swapped));
  assert.throws(() => V.checkDrawer("savannah", PASS), (e: any) => e.code === "DRAWER_DAMAGED");

  // Relabel a drawer with another fingerprint.
  const relabeled = JSON.parse(original);
  relabeled.drawers.genesis.fingerprint = relabeled.drawers.savannah.fingerprint;
  fs.writeFileSync(V.VAULT_FILE, JSON.stringify(relabeled));
  assert.throws(() => V.checkDrawer("genesis", PASS), (e: any) => e.code === "DRAWER_DAMAGED");

  // Flip one byte of the sealed key.
  const flipped = JSON.parse(original);
  const b = Buffer.from(flipped.drawers.genesis.sealed, "base64");
  b[5] ^= 1;
  flipped.drawers.genesis.sealed = b.toString("base64");
  fs.writeFileSync(V.VAULT_FILE, JSON.stringify(flipped));
  assert.throws(() => V.checkDrawer("genesis", PASS), (e: any) => e.code === "DRAWER_DAMAGED");

  // Damage to Genesis's drawer doesn't touch Savannah's.
  assert.equal(V.checkDrawer("savannah", PASS), true);
});

test("there is no Founder drawer, and invalid names are refused", () => {
  for (const name of ["founder", "Founder", "../genesis", "", "a/b"]) {
    assert.throws(() => V.sealAgent(name, PASS), (e: any) => e.code === "INVALID_AGENT", name);
  }
});

test("only keys of active credentials are sealed", () => {
  W.revokeCredential("savannah", PASS);
  assert.throws(() => V.sealAgent("savannah", PASS), (e: any) => e.code === "NO_KEY" || e.code === "NOT_ACTIVE");
  assert.equal(V.listDrawers().length, 0);
});

test("re-issuing a key and re-sealing replaces only that agent's drawer", () => {
  V.sealAgent("genesis", PASS);
  V.sealAgent("savannah", PASS);
  const savBefore = JSON.parse(vaultText()).drawers.savannah;
  const oldFp = V.listDrawers().find((d: any) => d.agent === "genesis").fingerprint;

  issue("genesis"); // a new key; the old credential is revoked
  assert.equal(V.listDrawers().find((d: any) => d.agent === "genesis").credential, "revoked");
  V.sealAgent("genesis", PASS);
  const after = V.listDrawers();
  assert.notEqual(after.find((d: any) => d.agent === "genesis").fingerprint, oldFp);
  assert.equal(after.find((d: any) => d.agent === "genesis").credential, "active");
  assert.deepEqual(JSON.parse(vaultText()).drawers.savannah, savBefore);
  assert.ok(V.logbook().entries.some((e: any) => e.event.type === "vault-resealed"));
});

test("the logbook is hash-chained: editing an entry is detected", () => {
  V.sealAgent("genesis", PASS);
  V.checkDrawer("genesis", PASS);
  assert.ok(V.logbook().ok);
  const lines = fs.readFileSync(V.VAULT_LOG, "utf-8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.event.agent = "savannah";
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(V.VAULT_LOG, lines.join("\n") + "\n");
  assert.equal(V.logbook().ok, false);
});

test("the vault page shows names and fingerprints only, never a key", () => {
  V.sealAgent("genesis", PASS);
  V.sealAgent("savannah", PASS);
  const page = V.vaultPage();
  for (const d of V.listDrawers()) assert.ok(page.includes(d.fingerprint));
  assert.ok(page.includes("genesis") && page.includes("savannah"));
  assert.ok(!page.includes("PRIVATE KEY"));
  const raw = JSON.parse(vaultText());
  assert.ok(!page.includes(raw.drawers.genesis.sealed));
  for (const agent of ["genesis", "savannah"]) {
    const body = pemOf(agent).split("\n").filter((l) => l && !l.startsWith("-----")).join("");
    assert.ok(!page.includes(body));
  }
});

test("nothing in the vault module hands a private key back to its caller", () => {
  const exported = Object.keys(V).sort();
  assert.deepEqual(exported, [
    "VAULT_DIR", "VAULT_FILE", "VAULT_HEAD", "VAULT_LOG", "VaultError",
    "checkDrawer", "listDrawers", "logbook", "restoreAgent", "sealAgent", "vaultPage",
  ]);
  V.sealAgent("genesis", PASS);
  const outputs = [V.listDrawers(), V.checkDrawer("genesis", PASS), V.logbook(), V.vaultPage()];
  assert.ok(!JSON.stringify(outputs).includes("PRIVATE KEY"));
});
