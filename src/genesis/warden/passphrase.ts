import crypto from "crypto";
import fs from "fs";

import { readJSON, writeJSONAtomic } from "../authority/store";
import { SECRET_FILE, logEvent } from "./state";

/**
 * The Founder passphrase: the one thing every privileged Founder operation
 * must present. It is never stored; only a slow scrypt hash of it is.
 *
 * requireFounder() is called INSIDE each privileged operation (approve,
 * reject, release, trust, pin, clear lockdown, reset the log, issue or
 * revoke a credential), not only by the command-line tools, so calling the
 * operation directly without the passphrase fails the same way.
 *
 * Every refusal is recorded in the Warden's event log with the operation
 * name only. The passphrase itself is never logged or put in an error.
 *
 * Limit: Genesis and the Founder run as the same Termux user. Code running as
 * that user could read or replace the hash file. The passphrase protects the
 * Founder's operations from the agents' own logic, not from hostile code
 * already running on the phone.
 */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSPHRASE = 10;

interface Secret { salt: string; hash: string; N: number; r: number; p: number }

function derive(passphrase: string, salt: Buffer, s = SCRYPT): Buffer {
  return crypto.scryptSync(passphrase, salt, s.keylen, { N: s.N, r: s.r, p: s.p, maxmem: s.maxmem });
}

export function hasPassphrase(): boolean {
  return fs.existsSync(SECRET_FILE);
}

export function verifyPassphrase(pass: unknown): boolean {
  const s = readJSON(SECRET_FILE) as Secret | null;
  if (!s || typeof pass !== "string" || pass.length === 0) return false;
  let got: Buffer;
  try {
    got = derive(pass, Buffer.from(s.salt, "hex"), { ...SCRYPT, N: s.N, r: s.r, p: s.p });
  } catch {
    return false;
  }
  const want = Buffer.from(s.hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * Set the passphrase. The first time, no old passphrase exists. After that,
 * changing it needs the current one.
 */
export function setPassphrase(newPass: string, oldPass?: string): void {
  if (hasPassphrase()) requireFounder(oldPass, "passphrase.change");
  if (typeof newPass !== "string" || newPass.length < MIN_PASSPHRASE) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  }
  const salt = crypto.randomBytes(16);
  const secret: Secret = { salt: salt.toString("hex"), hash: derive(newPass, salt).toString("hex"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  writeJSONAtomic(SECRET_FILE, secret);
  logEvent({ type: "passphrase-set" });
}

/** Proof that the Founder's passphrase was checked for one named operation. */
export interface FounderProof { readonly operation: string; readonly at: string }

// Proofs are only ever created below. A WeakSet can't be forged from outside
// this module, so an object that merely looks like a proof is refused.
const issued = new WeakSet<object>();

/**
 * Check the passphrase for one operation. Throws (and records the refusal)
 * when there is no passphrase yet or it is wrong. Returns a single-use proof.
 */
export function requireFounder(pass: unknown, operation: string): FounderProof {
  if (!hasPassphrase()) {
    logEvent({ type: "founder-auth-failed", operation, reason: "no passphrase set" });
    throw new Error("No founder passphrase yet. Run: npm run warden -- init");
  }
  if (!verifyPassphrase(pass)) {
    logEvent({ type: "founder-auth-failed", operation, reason: pass === undefined || pass === "" ? "missing passphrase" : "wrong passphrase" });
    throw new Error("Wrong or missing founder passphrase.");
  }
  const proof = Object.freeze({ operation, at: new Date().toISOString() });
  issued.add(proof);
  return proof;
}

/** Accept a proof once, for one of the given operations. */
export function consumeProof(proof: unknown, allowed: readonly string[]): boolean {
  if (!proof || typeof proof !== "object" || !issued.has(proof)) return false;
  const op = (proof as FounderProof).operation;
  if (!allowed.includes(op)) return false;
  issued.delete(proof);
  return true;
}
