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
 */

import { decide } from "../authority/KeyAuthority";

export const PROTECTED_ACTIONS = Object.freeze([
  "fs.write",
  "key.use",
  "chronicle.append",
] as const);

export interface GuardDecision {
  readonly allowed: boolean;
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
  requestId: string | null = null
): GuardDecision {
  return Object.freeze({ allowed, pending, requestId, reason, actor, action, target });
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
  if (out.outcome === "allow") return decision(true, out.reason, who, action, target);
  if (out.outcome === "ask") return decision(false, out.reason, who, action, target, true, out.requestId);
  return decision(false, out.reason, who, action, target);
}
