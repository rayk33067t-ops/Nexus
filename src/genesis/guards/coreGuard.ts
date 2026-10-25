/**
 * coreGuard — the default-deny gate in front of protected operations.
 *
 * coreGuard is not the authority and its answer is not a capability:
 *  - It decides nothing itself. Approval can only come from Key Authority.
 *    Genesis may propose an operation and Savannah may challenge it, but no
 *    caller can supply a policy, an authority, or an `allowed` value.
 *  - It takes a structured request (who, what action, which target), copies
 *    the primitive fields it needs, and never keeps or returns the caller's
 *    object.
 *  - It returns a frozen decision only: allowed or denied, plus the reason.
 *    It does not write files, open paths, or append to the Chronicle.
 *  - An allow is not permission to act later. The protected operation must
 *    still do its own checks (root confinement, symlinks, the open itself)
 *    at the moment of use, on its own private snapshot.
 *
 * Key Authority does not exist yet, so every protected action is denied.
 * Unknown actions are denied too.
 */

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
  /** What it applies to, e.g. a project name or a path relative to a root. */
  target: string;
}

export interface GuardDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
}

/**
 * Placeholder for Key Authority. Intentionally null and not exported: when
 * Key Authority is built, it replaces this constant in source, under review,
 * rather than being injected at runtime.
 */
const KEY_AUTHORITY: null = null;

const MAX_FIELD = 1024;

function field(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_FIELD) return null;
  if (value.includes("\0")) return null;
  return value;
}

function deny(reason: string, actor = "", action = "", target = ""): GuardDecision {
  return Object.freeze({ allowed: false, reason, actor, action, target });
}

export function coreGuard(request: unknown): GuardDecision {
  if (!request || typeof request !== "object") {
    return deny("request must be an object with actor, action and target");
  }

  // Copy the fields once; nothing below touches the caller's object again.
  const r = request as Record<string, unknown>;
  const actor = field(r.actor);
  const action = field(r.action);
  const target = field(r.target);

  if (actor === null || action === null || target === null) {
    return deny("actor, action and target must be non-empty strings");
  }

  if (!(PROTECTED_ACTIONS as readonly string[]).includes(action)) {
    return deny(`unknown action "${action}"`, actor, action, target);
  }

  if (KEY_AUTHORITY === null) {
    return deny("Key Authority is not implemented; protected actions are denied", actor, action, target);
  }

  // Unreachable until Key Authority exists. Kept as a deny so that adding
  // the authority is the only way this function can ever return allowed.
  return deny("Key Authority did not approve", actor, action, target);
}
