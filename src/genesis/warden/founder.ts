import crypto from "crypto";
import fs from "fs";
import path from "path";

import { LOCKDOWN_FILE, readJSON, writeJSONAtomic } from "../authority/store";
import { manifest } from "./integrity";
import { tamperFile, verifyLog } from "./log";
import { AGENT_RE, BASELINE_FILE, HEAD_FILE, LOG_FILE, SECRET_FILE, WARDEN_DIR, allAgents, getAgent, logEvent, setAgent } from "./state";
import { Baseline, ROOT, check } from "./Warden";

/**
 * Founder-only Warden operations. Each one that restores trust needs the
 * founder passphrase, which is never stored: only a slow scrypt hash of it
 * is. Only the Warden CLI imports this module; a test enforces that.
 */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

interface Secret { salt: string; hash: string; N: number; r: number; p: number }

function derive(passphrase: string, salt: Buffer, s = SCRYPT): Buffer {
  return crypto.scryptSync(passphrase, salt, s.keylen, { N: s.N, r: s.r, p: s.p, maxmem: s.maxmem });
}

export function hasPassphrase(): boolean {
  return fs.existsSync(SECRET_FILE);
}

export function setPassphrase(newPass: string, oldPass?: string): void {
  if (hasPassphrase() && !verifyPassphrase(oldPass ?? "")) throw new Error("The current passphrase is wrong.");
  if (typeof newPass !== "string" || newPass.length < 10) throw new Error("Use a passphrase of at least 10 characters.");
  const salt = crypto.randomBytes(16);
  const secret: Secret = { salt: salt.toString("hex"), hash: derive(newPass, salt).toString("hex"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  writeJSONAtomic(SECRET_FILE, secret);
  logEvent({ type: "passphrase-set" });
}

export function verifyPassphrase(pass: string): boolean {
  const s = readJSON(SECRET_FILE) as Secret | null;
  if (!s || typeof pass !== "string") return false;
  const got = derive(pass, Buffer.from(s.salt, "hex"), { ...SCRYPT, N: s.N, r: s.r, p: s.p });
  const want = Buffer.from(s.hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function requirePass(pass: string): void {
  if (!hasPassphrase()) throw new Error("No founder passphrase yet. Run: npm run warden -- init");
  if (!verifyPassphrase(pass)) {
    logEvent({ type: "founder-auth-failed" });
    throw new Error("Wrong passphrase.");
  }
}

/** Record the current code as known-good. Only do this for code you trust. */
export function pin(pass: string): Baseline {
  requirePass(pass);
  const lc = verifyLog(LOG_FILE, HEAD_FILE);
  const b: Baseline = { ...manifest(ROOT), pinnedAt: new Date().toISOString(), logHead: lc.lastHash };
  writeJSONAtomic(BASELINE_FILE, b);
  logEvent({ type: "pin", commit: b.commit, files: Object.keys(b.files).length });
  return b;
}

/** Quarantined → probation. Refused while any tripwire is still failing. */
export function release(agent: string, pass: string): void {
  requirePass(pass);
  if (!AGENT_RE.test(agent)) throw new Error(`Not a valid agent name: ${agent}`);
  const r = check();
  if (!r.integrity.ok) throw new Error(`Code still differs from the pinned version (${r.integrity.detail}). Restore it first, for example with: git status, then git checkout -- <file> or git reset --hard origin/<branch>.`);
  if (!r.log.ok) throw new Error(`The event log is still damaged (${r.log.detail}). Review it with npm run warden -- log, then archive it with npm run warden -- reset-log.`);
  const a = getAgent(agent);
  if (a.status !== "quarantined") throw new Error(`${agent} is ${a.status}, not quarantined.`);
  setAgent({ agent, status: "probation", since: new Date().toISOString(), reasons: [`released by founder after: ${a.reasons.join("; ")}`].slice(0, 1) });
  logEvent({ type: "release", agent });
}

/** Probation → active. */
export function trust(agent: string, pass: string): void {
  requirePass(pass);
  const a = getAgent(agent);
  if (a.status !== "probation") throw new Error(`${agent} is ${a.status}; only an agent on probation can be trusted again.`);
  setAgent({ agent, status: "active", since: new Date().toISOString(), reasons: [] });
  logEvent({ type: "trust", agent });
}

/** End Key Authority lockdown. Refused while any agent is still quarantined. */
export function clearLockdown(pass: string): boolean {
  requirePass(pass);
  const stuck = allAgents().filter((a) => a.status === "quarantined").map((a) => a.agent);
  if (stuck.length) throw new Error(`Release or keep these agents first; they are still quarantined: ${stuck.join(", ")}.`);
  if (!fs.existsSync(LOCKDOWN_FILE)) return false;
  fs.rmSync(LOCKDOWN_FILE, { force: true });
  logEvent({ type: "lockdown-cleared" });
  return true;
}

/** After reviewing a damaged log, archive it and start a fresh chain. */
export function resetLog(pass: string): string {
  requirePass(pass);
  const dir = path.join(WARDEN_DIR, "archive", String(Date.now()));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of [LOG_FILE, HEAD_FILE, tamperFile(LOG_FILE)]) {
    try { fs.renameSync(f, path.join(dir, path.basename(f))); } catch { /* absent */ }
  }
  logEvent({ type: "log-reset", archivedTo: dir });
  return dir;
}
