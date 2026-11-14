import crypto from "crypto";
import fs from "fs";
import path from "path";

import { canonicalJSON } from "../authority/canonical";
import { CredentialRecord, KEYS_DIR, fingerprintOf, keyFile, listCredentials, validAgentName } from "../authority/credentials";
import { PATHS, ensureDir, readJSON, writeJSONAtomic } from "../authority/store";
import { LogEntry, appendLog, readLog, verifyLog } from "../warden/log";
import { requireFounder } from "../warden/passphrase";

/**
 * The NEXUS Key Vault — a sealed backup of each agent's identity key.
 *
 *  - The vault is one file. Each agent has its own drawer in it, and each
 *    drawer is sealed on its own: its own random salt, its own key derived
 *    from the Founder passphrase with scrypt, its own random IV, sealed with
 *    AES-256-GCM. Opening one drawer reveals nothing about another.
 *  - Every drawer's seal is bound to the agent's name and public fingerprint.
 *    Moving a sealed key into another agent's drawer, or editing any byte of
 *    it, makes it refuse to open.
 *  - Only the Founder passphrase opens a drawer, and every operation checks
 *    the passphrase itself (not only the command-line tool). The passphrase
 *    is never stored, logged or put in an error.
 *  - Nothing here returns a private key to a caller. Keys go in from the
 *    agent's key file and come back out only by being restored to that same
 *    key file, which is never overwritten.
 *  - The logbook by the door is hash-chained, like the Warden's event log.
 *    It records every seal, check, restore and refusal: when, which drawer,
 *    and the key's fingerprint prefix. Never a key, never the passphrase.
 *  - The vault file holds no secret it can't protect, so it can be copied
 *    off the phone as a backup (Drive, GitHub private repo, Supabase): it is
 *    a locked box without the passphrase.
 *
 * What the vault is not: it grants no permission. An agent's key proves who
 * the agent is; what the agent may do is decided by the Founder's rules.
 * There is no "founder" drawer: Founder authority is the passphrase itself.
 *
 * Limit: the passphrase is only as strong as it is long. A short or guessed
 * passphrase can be brute-forced offline from a copied vault; scrypt makes
 * each guess slow, not impossible.
 */

export const VAULT_DIR = path.join(PATHS.stateDir, "vault");
export const VAULT_FILE = path.join(VAULT_DIR, "vault.json");
export const VAULT_LOG = path.join(VAULT_DIR, "logbook.log");
export const VAULT_HEAD = path.join(VAULT_DIR, "logbook.head");

const VAULT_ID = "nexus-key-vault";
const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 });

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

interface Kdf { name: "scrypt"; N: number; r: number; p: number; salt: string }

export interface Drawer {
  agent: string;
  fingerprint: string;
  sealedAt: string;
  kdf: Kdf;
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  sealed: string;
}

interface VaultFile { version: 1; vault: typeof VAULT_ID; drawers: Record<string, Drawer> }

export interface DrawerView {
  readonly agent: string;
  readonly fingerprint: string;
  readonly sealedAt: string;
  /** The agent's credential in Key Authority: active, expired, revoked or unknown. */
  readonly credential: "active" | "expired" | "revoked" | "unknown";
}

// ---------- the vault file ----------

function emptyVault(): VaultFile {
  return { version: 1, vault: VAULT_ID, drawers: {} };
}

function readVault(): VaultFile {
  if (!fs.existsSync(VAULT_FILE)) return emptyVault();
  const v = readJSON(VAULT_FILE) as VaultFile | null;
  if (!v || v.version !== 1 || v.vault !== VAULT_ID || !v.drawers || typeof v.drawers !== "object") {
    throw new VaultError("VAULT_DAMAGED", "The vault file is unreadable or not a NEXUS key vault.");
  }
  return v;
}

function writeVault(v: VaultFile): void {
  ensureDir(VAULT_DIR);
  fs.chmodSync(VAULT_DIR, 0o700);
  writeJSONAtomic(VAULT_FILE, v);
  fs.chmodSync(VAULT_FILE, 0o600);
}

function log(event: Record<string, unknown>): void {
  ensureDir(VAULT_DIR);
  appendLog(VAULT_LOG, VAULT_HEAD, event);
}

// ---------- sealing ----------

function deriveKey(pass: string, kdf: Kdf): Buffer {
  return crypto.scryptSync(pass, Buffer.from(kdf.salt, "base64"), SCRYPT.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem });
}

/** What every seal is bound to: the vault, the drawer's owner, the key it holds, and how it was sealed. */
function binding(agent: string, fingerprint: string, kdf: Kdf): Buffer {
  return Buffer.from(canonicalJSON({ vault: VAULT_ID, v: 1, agent, fingerprint, kdf }), "utf-8");
}

function seal(pass: string, agent: string, fingerprint: string, pem: string): Drawer {
  const kdf: Kdf = { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: crypto.randomBytes(16).toString("base64") };
  const key = deriveKey(pass, kdf);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(binding(agent, fingerprint, kdf));
  const sealed = Buffer.concat([c.update(pem, "utf-8"), c.final()]);
  key.fill(0);
  return {
    agent, fingerprint, sealedAt: new Date().toISOString(), kdf, cipher: "aes-256-gcm",
    iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), sealed: sealed.toString("base64"),
  };
}

/** Open a drawer. Private to this module: the key never leaves through a return value. */
function unseal(pass: string, d: Drawer): string {
  const kdf = d.kdf;
  if (!kdf || kdf.name !== "scrypt" || !Number.isInteger(kdf.N) || !Number.isInteger(kdf.r) || !Number.isInteger(kdf.p) || typeof kdf.salt !== "string") {
    throw new VaultError("DRAWER_DAMAGED", `The drawer for ${d.agent} is damaged.`);
  }
  const key = deriveKey(pass, kdf);
  try {
    const dc = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(d.iv, "base64"));
    dc.setAAD(binding(d.agent, d.fingerprint, kdf));
    dc.setAuthTag(Buffer.from(d.tag, "base64"));
    return Buffer.concat([dc.update(Buffer.from(d.sealed, "base64")), dc.final()]).toString("utf-8");
  } catch {
    throw new VaultError("DRAWER_DAMAGED", `The drawer for ${d.agent} would not open: it was changed, moved, or sealed with another passphrase.`);
  } finally {
    key.fill(0);
  }
}

function publicFingerprint(pem: string): string {
  let priv: crypto.KeyObject;
  try {
    priv = crypto.createPrivateKey(pem);
  } catch {
    throw new VaultError("NOT_A_KEY", "That is not a private key.");
  }
  if (priv.asymmetricKeyType !== "ed25519") throw new VaultError("NOT_A_KEY", "Not a NEXUS agent key (Ed25519 required).");
  return fingerprintOf(crypto.createPublicKey(priv).export({ type: "spki", format: "der" }));
}

function founder(pass: unknown, operation: string, agent: string): void {
  try {
    requireFounder(pass, operation);
  } catch (err: unknown) {
    log({ type: "vault-refused", operation, agent, reason: "founder passphrase not accepted" });
    throw err;
  }
}

function checkAgent(agent: unknown): string {
  if (!validAgentName(agent)) throw new VaultError("INVALID_AGENT", "Not an agent name, or a reserved name. There is no Founder drawer.");
  return agent;
}

// ---------- what the Founder can do ----------

/**
 * Seal an agent's current key into its drawer. The key must belong to an
 * active credential. An existing drawer for that agent is replaced (for
 * example after the key was re-issued); other drawers are untouched.
 */
export function sealAgent(agentIn: string, pass: string): DrawerView {
  const agent = checkAgent(agentIn);
  founder(pass, "vault.seal", agent);
  let pem: string;
  try {
    pem = fs.readFileSync(keyFile(agent), "utf-8");
  } catch {
    log({ type: "vault-refused", operation: "vault.seal", agent, reason: "no key file" });
    throw new VaultError("NO_KEY", `${agent} has no key on this device. Issue one first: npm run warden -- issue ${agent}`);
  }
  const fingerprint = publicFingerprint(pem);
  const rec = listCredentials().find((r) => r.fingerprint === fingerprint && r.agent === agent);
  if (!rec || statusOf(rec) !== "active") {
    log({ type: "vault-refused", operation: "vault.seal", agent, fingerprint: fingerprint.slice(0, 16), reason: "key is not an active credential" });
    throw new VaultError("NOT_ACTIVE", `${agent}'s key is not an active credential, so it is not worth keeping.`);
  }
  const v = readVault();
  const replaced = agent in v.drawers;
  v.drawers[agent] = seal(pass, agent, fingerprint, pem);
  writeVault(v);
  log({ type: replaced ? "vault-resealed" : "vault-sealed", agent, fingerprint: fingerprint.slice(0, 16) });
  return viewOf(v.drawers[agent]);
}

/** Prove a drawer opens with the passphrase and holds the key its label says, without taking it out. */
export function checkDrawer(agentIn: string, pass: string): boolean {
  const agent = checkAgent(agentIn);
  founder(pass, "vault.check", agent);
  const d = readVault().drawers[agent];
  if (!d) throw new VaultError("NO_DRAWER", `There is no drawer for ${agent}.`);
  try {
    const ok = publicFingerprint(unseal(pass, d)) === d.fingerprint;
    log({ type: "vault-checked", agent, fingerprint: d.fingerprint.slice(0, 16), ok });
    return ok;
  } catch (err: unknown) {
    log({ type: "vault-refused", operation: "vault.check", agent, reason: err instanceof VaultError ? err.code : "error" });
    throw err;
  }
}

/**
 * Put an agent's key back on this device from its drawer, for example after
 * the phone was replaced. Refuses if a key file already exists (nothing is
 * ever overwritten). The key is written straight to the agent's key file,
 * readable only by this user.
 */
export function restoreAgent(agentIn: string, pass: string): DrawerView {
  const agent = checkAgent(agentIn);
  founder(pass, "vault.restore", agent);
  const d = readVault().drawers[agent];
  if (!d) throw new VaultError("NO_DRAWER", `There is no drawer for ${agent}.`);
  const kf = keyFile(agent);
  if (fs.existsSync(kf)) {
    log({ type: "vault-refused", operation: "vault.restore", agent, reason: "a key file already exists" });
    throw new VaultError("KEY_EXISTS", `${agent} already has a key on this device; nothing was overwritten.`);
  }
  let pem: string;
  try {
    pem = unseal(pass, d);
  } catch (err: unknown) {
    log({ type: "vault-refused", operation: "vault.restore", agent, reason: err instanceof VaultError ? err.code : "error" });
    throw err;
  }
  if (publicFingerprint(pem) !== d.fingerprint) {
    log({ type: "vault-refused", operation: "vault.restore", agent, reason: "key does not match its label" });
    throw new VaultError("DRAWER_DAMAGED", `The key in ${agent}'s drawer does not match its label.`);
  }
  ensureDir(KEYS_DIR);
  fs.chmodSync(KEYS_DIR, 0o700);
  fs.writeFileSync(kf, pem, { mode: 0o600, flag: "wx" });
  log({ type: "vault-restored", agent, fingerprint: d.fingerprint.slice(0, 16) });
  return viewOf(d);
}

// ---------- what anyone can see (no secrets) ----------

function statusOf(r: CredentialRecord, now = Date.now()): DrawerView["credential"] {
  if (r.revokedAt) return "revoked";
  return Date.parse(r.expiresAt) > now ? "active" : "expired";
}

function viewOf(d: Drawer): DrawerView {
  const rec = listCredentials().find((r) => r.fingerprint === d.fingerprint && r.agent === d.agent);
  return Object.freeze({ agent: d.agent, fingerprint: d.fingerprint, sealedAt: d.sealedAt, credential: rec ? statusOf(rec) : "unknown" });
}

/** The drawers' labels: names, fingerprints, dates, credential status. Never a key. */
export function listDrawers(): DrawerView[] {
  return Object.values(readVault().drawers)
    .map(viewOf)
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

export function logbook(): { ok: boolean; reason: string; entries: LogEntry[] } {
  const v = verifyLog(VAULT_LOG, VAULT_HEAD);
  return { ok: v.ok, reason: v.reason ?? "", entries: fs.existsSync(VAULT_LOG) ? readLog(VAULT_LOG) : [] };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** A self-contained HTML page of the vault's labels and logbook. Contains no key. */
export function vaultPage(): string {
  const drawers = listDrawers();
  const book = logbook();
  const rows = drawers
    .map(
      (d) => `<div class="drawer"><div class="name">${esc(d.agent)}</div><div class="env">✉ sealed</div>` +
        `<div class="fp">${esc(d.fingerprint)}</div>` +
        `<div class="meta">credential: <b class="${esc(d.credential)}">${esc(d.credential)}</b> · sealed ${esc(d.sealedAt.slice(0, 16).replace("T", " "))} UTC</div></div>`
    )
    .join("\n");
  const entries = book.entries
    .slice(-25)
    .reverse()
    .map((e) => `<li><code>${esc(e.at.slice(0, 19).replace("T", " "))}</code> ${esc(String(e.event.type ?? ""))} ${esc(String(e.event.agent ?? ""))}${e.event.reason ? " — " + esc(String(e.event.reason)) : ""}</li>`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXUS Key Vault</title><style>
:root{--bg:#0b0f14;--fg:#e8eef4;--mut:#8a97a6;--card:#141b23;--line:#24303c;--ok:#3ecf8e;--bad:#ef6b6b;--warn:#e8b04b}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px}
.drawer{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:0 0 10px}
.name{font-weight:600;font-size:17px;text-transform:capitalize}.env{float:right;color:var(--mut)}
.fp{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;color:var(--mut);margin:6px 0}
.active{color:var(--ok)}.revoked,.unknown{color:var(--bad)}.expired{color:var(--warn)}
h2{font-size:16px;margin:20px 0 6px}ul{padding-left:18px;color:var(--mut);font-size:13px}code{color:var(--fg)}
</style></head><body><h1>NEXUS Key Vault</h1>
<p class="sub">${drawers.length} drawer(s). Labels only: no private key appears on this page. Logbook chain: ${book.ok ? "intact" : "DAMAGED (" + esc(book.reason) + ")"}.</p>
${rows || '<p class="sub">The vault is empty.</p>'}
<h2>Logbook (latest first)</h2><ul>${entries || "<li>No entries yet.</li>"}</ul></body></html>`;
}
