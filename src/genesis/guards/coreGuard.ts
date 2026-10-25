/**
 * coreGuard — the default-deny gate in front of protected operations.
 *
 * coreGuard is not the authority and its answer is not a capability:
 *  - It decides nothing itself. It asks Key Authority, which applies the
 *    founder's rules and approvals. No caller can supply a policy, an
 *    authority, or an `allowed` value.
 *  - It takes a structured request (who, what action, which target, and the
 *    digest of the exact plan), copies the fields it needs once, and never
 *    keeps or returns the caller's object.
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

export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];

export interface GuardRequest {
  /** Who is asking, e.g. "genesis". */
  actor: string;
  /** What they want to do; must be one of PROTECTED_ACTIONS. */
  action: string;
  /** What it applies to, e.g. "project:demo". */
  target: string;
  /** "sha256:<hex>" digest of the exact plan the operation will carry out. */
  digest: string;
  /** Human-readable description shown to the founder when approval is needed. */
  summary?: string;
}

export interface GuardDecision {
  readonly allowed: boolean;
  /** True when the request is waiting for the founder's approval. */
  readonly pending: boolean;
  /** Id to approve with `npm run authority -- approve <id>` when pending. */
  readonly requestId: string | null;
  readonly reason: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
}

const MAX_FIELD = 1024;

function field(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_FIELD) return null;
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
    return decision(false, "request must be an object with actor, action, target and digest");
  }

  // Copy the fields once; nothing below touches the caller's object again.
  const r = request as Record<string, unknown>;
  const actor = field(r.actor);
  const action = field(r.action);
  const target = field(r.target);
  const digest = field(r.digest);
  const rawSummary = r.summary;

  if (actor === null || action === null || target === null) {
    return decision(false, "actor, action and target must be non-empty strings");
  }
  if (!(PROTECTED_ACTIONS as readonly string[]).includes(action)) {
    return decision(false, `unknown action "${action}"`, actor, action, target);
  }
  if (digest === null) {
    return decision(false, "request must carry the digest of its exact plan", actor, action, target);
  }
  const summary = typeof rawSummary === "string" ? rawSummary : undefined;

  let out;
  try {
    out = decide({ actor, action, target, digest, summary });
  } catch (err: any) {
    return decision(false, `Key Authority failed (${err?.message ?? "unknown error"}); denied`, actor, action, target);
  }

  if (out.outcome === "allow") return decision(true, out.reason, actor, action, target);
  if (out.outcome === "ask") return decision(false, out.reason, actor, action, target, true, out.requestId);
  return decision(false, out.reason, actor, action, target);
}
