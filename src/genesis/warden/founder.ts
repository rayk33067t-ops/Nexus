import crypto from "crypto";
import fs from "fs";
import path from "path";

import { LOCKDOWN_FILE, ensureDir, writeJSONAtomic } from "../authority/store";
import {
  CRED_DIR,
  CredentialRecord,
  DEFAULT_TTL_DAYS,
  KEYS_DIR,
  fingerprintOf,
  keyFile,
  listCredentials,
  recordFile,
  validAgentName,
} from "../authority/credentials";
import { manifest } from "./integrity";
import { tamperFile, verifyLog } from "./log";
import { hasPassphrase, requireFounder, setPassphrase, verifyPassphrase } from "./passphrase";
import { AGENT_RE, BASELINE_FILE, HEAD_FILE, LOG_FILE, WARDEN_DIR, allAgents, getAgent, lockdownActive, logEvent, restoreAgent } from "./state";
import { Baseline, ROOT, check } from "./Warden";

/**
 * Founder-only Warden operations. Every one that changes trust checks the
 * Founder passphrase itself (warden/passphrase), so calling it directly
 * without the passphrase fails and changes nothing. Only the Warden CLI
 * imports this module; a test enforces that.
 */

export { hasPassphrase, setPassphrase, verifyPassphrase };

/** Record the current code as known-good. Only do this for code you trust. */
export function pin(pass: string): Baseline {
  requirePass(pass, "warden.pin");
  const lc = verifyLog(LOG_FILE, HEAD_FILE);
  const b: Baseline = { ...manifest(ROOT), pinnedAt: new Date().toISOString(), logHead: lc.lastHash };
  writeJSONAtomic(BASELINE_FILE, b);
  logEvent({ type: "pin", commit: b.commit, files: Object.keys(b.files).length });
  return b;
}

function requirePass(pass: string, operation: string) {
  return requireFounder(pass, operation);
}

/** Quarantined → probation. Refused while any tripwire is still failing. */
export function release(agent: string, pass: string): void {
  const proof = requirePass(pass, "agent.release");
  if (!AGENT_RE.test(agent)) throw new Error(`Not a valid agent name: ${agent}`);
  const r = check();
  if (!r.integrity.ok) throw new Error(`Code still differs from the pinned version (${r.integrity.detail}). Restore it first, for example with: git status, then git checkout -- <file> or git reset --hard origin/<branch>.`);
  if (!r.log.ok) throw new Error(`The event log is still damaged (${r.log.detail}). Review it with npm run warden -- log, then archive it with npm run warden -- reset-log.`);
  const a = getAgent(agent);
  if (a.status !== "quarantined") throw new Error(`${agent} is ${a.status}, not quarantined.`);
  restoreAgent({ agent, status: "probation", since: new Date().toISOString(), reasons: [`released by founder after: ${a.reasons.join("; ")}`].slice(0, 1) }, proof);
  logEvent({ type: "release", agent });
}

/** Probation → active. */
export function trust(agent: string, pass: string): void {
  const proof = requirePass(pass, "agent.trust");
  const a = getAgent(agent);
  if (a.status !== "probation") throw new Error(`${agent} is ${a.status}; only an agent on probation can be trusted again.`);
  restoreAgent({ agent, status: "active", since: new Date().toISOString(), reasons: [] }, proof);
  logEvent({ type: "trust", agent });
}

/**
 * End Key Authority lockdown. This is the only way to end it. Refused while
 * any agent is still quarantined.
 */
export function clearLockdown(pass: string): boolean {
  requirePass(pass, "lockdown.clear");
  const stuck = allAgents().filter((a) => a.status === "quarantined").map((a) => a.agent);
  if (stuck.length) throw new Error(`Release or keep these agents first; they are still quarantined: ${stuck.join(", ")}.`);
  const state = lockdownActive();
  if (!state.locked) return false;
  if (state.why.startsWith("the Warden's event log can't be trusted")) {
    throw new Error(`Can't clear lockdown while ${state.why}. Review it with npm run warden -- log, then archive it with npm run warden -- reset-log.`);
  }
  fs.rmSync(LOCKDOWN_FILE, { force: true });
  logEvent({ type: "lockdown-cleared" });
  return true;
}

/** After reviewing a damaged log, archive it and start a fresh chain. */
export function resetLog(pass: string): string {
  requirePass(pass, "log.reset");
  const dir = path.join(WARDEN_DIR, "archive", String(Date.now()));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of [LOG_FILE, HEAD_FILE, tamperFile(LOG_FILE)]) {
    try { fs.renameSync(f, path.join(dir, path.basename(f))); } catch { /* absent */ }
  }
  logEvent({ type: "log-reset", archivedTo: dir });
  return dir;
}

// ---------- agent credentials ----------

export interface IssuedCredential extends CredentialRecord { keyFile: string }

/**
 * Issue an agent its own Ed25519 credential. Any earlier credential for that
 * agent is revoked. The private key goes to the agent's key file (0600, in a
 * 0700 folder); Key Authority keeps only the public key's fingerprint.
 * "founder" and other reserved names are refused.
 */
export function issueCredential(agent: string, pass: string, ttlDays: number = DEFAULT_TTL_DAYS): IssuedCredential {
  requirePass(pass, "credential.issue");
  if (!validAgentName(agent)) throw new Error(`Can't issue a credential for "${agent}": not an agent name, or reserved.`);
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 3650) throw new Error("Credential lifetime must be between 1 and 3650 days.");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const now = Date.now();
  const rec: CredentialRecord = {
    agent,
    fingerprint: fingerprintOf(der),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * 86_400_000).toISOString(),
    revokedAt: null,
  };

  revokeAll(agent, "replaced by a new credential");
  ensureDir(CRED_DIR);
  ensureDir(KEYS_DIR);
  fs.chmodSync(KEYS_DIR, 0o700);
  const kf = keyFile(agent);
  const tmp = `${kf}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, kf);
  writeJSONAtomic(recordFile(rec.fingerprint), rec);
  logEvent({ type: "credential-issued", agent, fingerprint: rec.fingerprint.slice(0, 16), expiresAt: rec.expiresAt });
  return { ...rec, keyFile: kf };
}

function revokeAll(agent: string, why: string): number {
  let n = 0;
  const at = new Date().toISOString();
  for (const r of listCredentials()) {
    if (r.agent !== agent || r.revokedAt) continue;
    writeJSONAtomic(recordFile(r.fingerprint), { ...r, revokedAt: at });
    logEvent({ type: "credential-revoked", agent, fingerprint: r.fingerprint.slice(0, 16), why });
    n++;
  }
  return n;
}

/** Revoke every active credential an agent has, and delete its key file. */
export function revokeCredential(agent: string, pass: string): number {
  requirePass(pass, "credential.revoke");
  if (!AGENT_RE.test(agent)) throw new Error(`Not a valid agent name: ${agent}`);
  const n = revokeAll(agent, "revoked by founder");
  fs.rmSync(keyFile(agent), { force: true });
  return n;
}
