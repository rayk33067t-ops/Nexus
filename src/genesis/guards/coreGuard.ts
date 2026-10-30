/**
 * coreGuard — the default-deny gate in front of protected operations.
 *
 * coreGuard is not the authority and its answer is not a capability:
 *  - It decides nothing itself. It asks Key Authority, which checks who
 *    signed the request and then applies the founder's rules and approvals.
 *    No caller can supply a policy, an authority, an `allowed` value or an
 *    identity: a request that names its own actor is refused.
 *  - It takes a signed request (see authority/credentials): the action, the
 *    target, the digest of the exact plan, the agent's public key, a nonce,
 *    the signing time and the signature. It copies those fields once and
 *    never keeps or returns the caller's object.
 *  - It returns a frozen decision only. It does not write files, open paths,
 *    or append to the Chronicle.
 *  - An allow is not permission to act later. The protected operation must
 *    still do its own checks at the moment of use, on its private snapshot.
 *  - Any error inside Key Authority is a denial.
 *  - An allow comes with a grant: a one-time token for exactly that action,
 *    target and plan digest. Protected operations refuse to act without one
 *    (consumeGrant), so calling them directly, skipping the guard, does
 *    nothing. Grants can only be made here: they live in a private WeakSet,
 *    so an object that merely looks like one is refused. A grant expires
 *    after GRANT_TTL_MS and works once.
 */

import { decide } from "../authority/KeyAuthority";

export const PROTECTED_ACTIONS = Object.freeze([
  "fs.write",
  "key.use",
  "chronicle.append",
] as const);

/** A one-time permission for one exact protected action. Opaque outside this module. */
export interface Grant {
  readonly action: string;
  readonly target: string;
  readonly digest: string;
  readonly actor: string;
  readonly expiresAt: number;
}

export const GRANT_TTL_MS = 60_000;
const grants = new WeakSet<object>();

function issueGrant(actor: string, action: string, target: string, digest: string): Grant {
  const g = Object.freeze({ actor, action, target, digest, expiresAt: Date.now() + GRANT_TTL_MS });
  grants.add(g);
  return g;
}

/**
 * For protected operations: accept a grant once, only if it was issued by
 * coreGuard for exactly this action, target and plan digest, and hasn't
 * expired. Returns the agent it was issued to, or a reason it was refused.
 */
export function consumeGrant(grant: unknown, expect: { action: string; target: string; digest: string }): { ok: true; actor: string } | { ok: false; reason: string } {
  if (!grant || typeof grant !== "object" || !grants.has(grant)) return { ok: false, reason: "no grant from the guard" };
  grants.delete(grant); // one use, whatever happens next
  const g = grant as Grant;
  if (g.expiresAt <= Date.now()) return { ok: false, reason: "the grant has expired" };
  if (g.action !== expect.action || g.target !== expect.target || g.digest !== expect.digest) {
    return { ok: false, reason: "the grant is for a different action, target or plan" };
  }
  return { ok: true, actor: g.actor };
}

export interface GuardDecision {
  readonly allowed: boolean;
  /** Present only when allowed: the one-time grant the protected operation needs. */
  readonly grant: Grant | null;
  /** True when the request is waiting for the founder's approval. */
  readonly pending: boolean;
  /** Id to approve with `npm run authority -- approve <id>` when pending. */
  readonly requestId: string | null;
  readonly reason: string;
  /** The agent Key Authority authenticated, or "" when it couldn't. */
  readonly actor: string;
  readonly action: string;
  readonly target: string;
}

const MAX_FIELD = 1024;
const MAX_SUMMARY = 64 * 1024;
const FIELDS = ["v", "publicKey", "nonce", "issuedAt", "signature", "action", "target", "digest", "summary"] as const;

function field(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  if (value.includes("\0")) return null;
  return value;
}

function decision(
  allowed: boolean,
  reason: string,
  actor = "",
  action = "",
  target = "",
  pending = false,
  requestId: string | null = null,
  grant: Grant | null = null
): GuardDecision {
  return Object.freeze({ allowed, grant, pending, requestId, reason, actor, action, target });
}

export function coreGuard(request: unknown): GuardDecision {
  if (!request || typeof request !== "object") {
    return decision(false, "request must be a signed object with action, target and digest");
  }

  // Copy the fields once; nothing below touches the caller's object again.
  const r = request as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(r, "actor") || Object.prototype.hasOwnProperty.call(r, "agent")) {
    return decision(false, "requests may not name their own actor; identity comes from the signature");
  }
  const copy: Record<string, unknown> = {};
  for (const k of FIELDS) copy[k] = r[k];

  const action = field(copy.action);
  const target = field(copy.target);
  const digest = field(copy.digest);
  if (action === null || target === null) {
    return decision(false, "action and target must be non-empty strings");
  }
  if (!(PROTECTED_ACTIONS as readonly string[]).includes(action)) {
    return decision(false, `unknown action "${action}"`, "", action, target);
  }
  if (digest === null) {
    return decision(false, "request must carry the digest of its exact plan", "", action, target);
  }
  if (copy.summary !== undefined && field(copy.summary, MAX_SUMMARY) === null && copy.summary !== "") {
    return decision(false, "summary must be text under 64 KB", "", action, target);
  }
  if (copy.summary === undefined) delete copy.summary;

  let out;
  try {
    out = decide(copy);
  } catch (err: any) {
    return decision(false, `Key Authority failed (${err?.message ?? "unknown error"}); denied`, "", action, target);
  }

  const who = out.actor ?? "";
  if (out.outcome === "allow") {
    return decision(true, out.reason, who, action, target, false, null, issueGrant(who, action, target, digest));
  }
  if (out.outcome === "ask") return decision(false, out.reason, who, action, target, true, out.requestId);
  return decision(false, out.reason, who, action, target);
}
