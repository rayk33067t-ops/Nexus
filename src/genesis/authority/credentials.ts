import crypto from "crypto";
import fs from "fs";
import path from "path";

import { canonicalJSON } from "./canonical";
import { PATHS, ensureDir, listJSON, readJSON } from "./store";

/**
 * Agent credentials: who is asking is proven by a signature, never by a name.
 *
 *  - Each agent has its own Ed25519 key pair, issued by the Founder with
 *    `npm run warden -- issue <agent>` (passphrase required).
 *  - The agent keeps the private key in its own key file. Key Authority keeps
 *    only a credential record: the agent's name, the SHA-256 fingerprint of
 *    the agent's public key, and when the credential was issued, expires or
 *    was revoked. No key material is stored by Key Authority.
 *  - Every request carries the agent's public key and a signature. Key
 *    Authority checks the public key's fingerprint against its records and
 *    then the signature. The identity comes from the matching record. A
 *    request that names an actor itself is refused.
 *  - Each signature covers the action, target, plan digest, summary, a
 *    random nonce and the time it was made. A changed request breaks the
 *    signature; a reused nonce, or one older than MAX_SKEW_MS, is refused.
 *  - "founder" is reserved. No credential can carry that name, so no agent
 *    can act as the Founder. Founder powers exist only through the Founder
 *    CLI and the passphrase.
 *  - NEXUS credentials are separate from external AI-provider credentials
 *    (API keys in environment variables). Nothing here reads environment
 *    variables for keys, and a provider key can't be used as a NEXUS one.
 *
 * Limit: Genesis and the Founder run as the same Termux user, so code running
 * as that user could read an agent's key file. Signatures stop identity by
 * name alone and make every request attributable to a key; they do not give
 * operating-system isolation. That needs a separate OS user or an isolated
 * service, which an ordinary Android phone with Termux doesn't provide.
 *
 * This module only reads and verifies. Issuing and revoking live in the
 * Warden's Founder module and need the passphrase.
 */

export const RESERVED_IDENTITIES = Object.freeze(["founder"]);
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const CRED_DIR = path.join(PATHS.stateDir, "credentials");
export const KEYS_DIR = path.join(PATHS.stateDir, "keys");
export const NONCE_DIR = path.join(PATHS.stateDir, "nonces");

/** How far a request's signing time may be from now. */
export const MAX_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_TTL_DAYS = 90;

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const MAX_PUBLIC_KEY_B64 = 200;

export interface CredentialRecord {
  agent: string;
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** The request an agent signs. It never contains a name. */
export interface RequestBody {
  action: string;
  target: string;
  digest: string;
  summary?: string;
}

export interface SignedRequest extends RequestBody {
  v: 1;
  publicKey: string;   // base64 SPKI DER of the agent's Ed25519 public key
  nonce: string;       // 32 hex chars, random per request
  issuedAt: number;    // ms since epoch, when it was signed
  signature: string;   // base64 Ed25519 signature
}

export type AuthResult =
  | { ok: true; agent: string; fingerprint: string }
  | { ok: false; reason: string; fingerprint: string | null; credentialOf: string | null };

export function isReserved(name: string): boolean {
  return RESERVED_IDENTITIES.includes(name.toLowerCase());
}

export function validAgentName(name: unknown): name is string {
  return typeof name === "string" && AGENT_NAME_RE.test(name) && !isReserved(name);
}

export function keyFile(agent: string): string {
  return path.join(KEYS_DIR, `${agent}.pem`);
}

export function recordFile(fingerprint: string): string {
  return path.join(CRED_DIR, `${fingerprint}.json`);
}

export function fingerprintOf(publicKeyDer: Buffer): string {
  return crypto.createHash("sha256").update(publicKeyDer).digest("hex");
}

/** Exactly what the signature covers. The summary is covered by its hash. */
export function signedPayload(r: Omit<SignedRequest, "signature">): string {
  const summaryHash = crypto.createHash("sha256").update(r.summary ?? "", "utf-8").digest("hex");
  return canonicalJSON({
    v: r.v, publicKey: r.publicKey, nonce: r.nonce, issuedAt: r.issuedAt,
    action: r.action, target: r.target, digest: r.digest, summaryHash,
  });
}

export function listCredentials(): CredentialRecord[] {
  return listJSON(CRED_DIR)
    .map((f) => readJSON(path.join(CRED_DIR, f)) as CredentialRecord | null)
    .filter((r): r is CredentialRecord => !!r && typeof r.agent === "string" && FINGERPRINT_RE.test(r.fingerprint ?? ""));
}

/** The agent's current, usable credential, if any. */
export function activeCredential(agent: string, now = Date.now()): CredentialRecord | null {
  return listCredentials().find((r) => r.agent === agent && !r.revokedAt && Date.parse(r.expiresAt) > now) ?? null;
}

function fail(reason: string, fingerprint: string | null = null, credentialOf: string | null = null): AuthResult {
  return { ok: false, reason, fingerprint, credentialOf };
}

/** Remove nonce records older than twice the allowed clock skew. */
function pruneNonces(dir: string, now: number): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const ts = Number(n.split("-")[0]);
    if (Number.isFinite(ts) && now - ts > 2 * MAX_SKEW_MS) {
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* gone */ }
    }
  }
}

/**
 * Work out who signed a request. Order matters: the signature is checked
 * before the nonce is used up, so unsigned junk can't burn nonces.
 * `credentialOf` is set only when the request carries a key Key Authority
 * issued; it says whose key it was, not that the agent sent it.
 */
export function authenticate(r: Record<string, unknown>, now = Date.now()): AuthResult {
  if ("actor" in r || "agent" in r) return fail("requests may not name their own actor; identity comes from the signature");
  if (r.signature === undefined && r.publicKey === undefined) return fail("unsigned request");
  if (r.v !== 1) return fail("unsupported request format");
  for (const k of ["publicKey", "nonce", "signature", "action", "target", "digest"]) {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0) return fail(`malformed request: ${k}`);
  }
  if (typeof r.issuedAt !== "number" || !Number.isFinite(r.issuedAt)) return fail("malformed request: issuedAt");
  if (r.summary !== undefined && typeof r.summary !== "string") return fail("malformed request: summary");
  if ((r.publicKey as string).length > MAX_PUBLIC_KEY_B64) return fail("malformed request: publicKey");
  if (!NONCE_RE.test(r.nonce as string)) return fail("malformed request: nonce");

  let der: Buffer, key: crypto.KeyObject;
  try {
    der = Buffer.from(r.publicKey as string, "base64");
    key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return fail("not a valid NEXUS public key");
  }
  if (key.asymmetricKeyType !== "ed25519") return fail("not a NEXUS agent key (Ed25519 required)");

  const fingerprint = fingerprintOf(der);
  const rec = readJSON(recordFile(fingerprint)) as CredentialRecord | null;
  if (!rec || rec.fingerprint !== fingerprint) return fail("unknown credential", fingerprint);

  const req = r as unknown as SignedRequest;
  let good = false;
  try {
    good = crypto.verify(null, Buffer.from(signedPayload(req), "utf-8"), key, Buffer.from(req.signature, "base64"));
  } catch {
    good = false;
  }
  if (!good) return fail("invalid signature", fingerprint, null);

  // From here the request really was signed with this key.
  if (!validAgentName(rec.agent)) return fail("credential names a reserved or invalid identity", fingerprint, rec.agent);
  if (rec.revokedAt) return fail("credential revoked", fingerprint, rec.agent);
  if (!(Date.parse(rec.expiresAt) > now)) return fail("credential expired", fingerprint, rec.agent);
  if (Math.abs(now - req.issuedAt) > MAX_SKEW_MS) return fail("request is too old or dated in the future", fingerprint, rec.agent);

  const dir = path.join(NONCE_DIR, fingerprint);
  ensureDir(dir);
  pruneNonces(dir, now);
  try {
    // "wx" fails if the file exists, atomically: the second use of a nonce loses.
    fs.writeFileSync(path.join(dir, `${req.issuedAt}-${req.nonce}`), "", { flag: "wx", mode: 0o600 });
  } catch {
    return fail("replayed request (nonce already used)", fingerprint, rec.agent);
  }
  return { ok: true, agent: rec.agent, fingerprint };
}

// ---------- the agent's side ----------

export interface AgentSigner {
  /** The public key this signer presents, base64 SPKI DER. */
  readonly publicKey: string;
  sign(body: RequestBody): SignedRequest;
}

/** Sign with a private key held in memory. The key never leaves this closure. */
export function signerFromPem(privateKeyPem: string): AgentSigner {
  const priv = crypto.createPrivateKey(privateKeyPem);
  if (priv.asymmetricKeyType !== "ed25519") throw new Error("Not a NEXUS agent key (Ed25519 required).");
  const publicKey = crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  const sign = (body: RequestBody): SignedRequest => {
    const unsigned = {
      v: 1 as const, publicKey,
      nonce: crypto.randomBytes(16).toString("hex"),
      issuedAt: Date.now(),
      action: body.action, target: body.target, digest: body.digest,
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
    };
    const signature = crypto.sign(null, Buffer.from(signedPayload(unsigned), "utf-8"), priv).toString("base64");
    return { ...unsigned, signature };
  };
  return Object.freeze({ publicKey, sign });
}

/** Load an agent's signer from its key file (readable only by this user). */
export function loadAgentSigner(agent: string): AgentSigner {
  if (!validAgentName(agent)) throw new Error(`Not a valid agent name: ${agent}`);
  let pem: string;
  try {
    pem = fs.readFileSync(keyFile(agent), "utf-8");
  } catch {
    throw new Error(`No credential issued for ${agent}. The Founder issues one with: npm run warden -- issue ${agent}`);
  }
  return signerFromPem(pem);
}
