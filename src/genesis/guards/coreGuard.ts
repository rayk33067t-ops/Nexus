/**
 * coreGuard — deny-by-default gate.
 *
 * There is no Key Authority yet, so this guard cannot grant anything on its
 * own. It allows a request only when the caller supplies an explicit policy
 * and that policy returns exactly `true`. Every other case is a denial:
 * no policy, a non-string input, a policy that throws, or a policy that
 * returns anything other than the boolean `true`.
 *
 * Decisions are frozen so a caller cannot flip `allowed` after the fact.
 */

export interface GuardPolicy {
  /** Short name recorded in the decision, for audit trails. */
  name: string;
  /** Return exactly `true` to allow. Anything else denies. */
  allow: (input: string) => boolean;
}

export interface GuardDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly policy: string | null;
  readonly input: string;
}

function decide(
  allowed: boolean,
  reason: string,
  policy: string | null,
  input: string
): GuardDecision {
  return Object.freeze({ allowed, reason, policy, input });
}

export function coreGuard(input: unknown, policy?: GuardPolicy): GuardDecision {
  if (typeof input !== "string") {
    return decide(false, "input must be a string", null, "");
  }

  if (
    !policy ||
    typeof policy !== "object" ||
    typeof policy.allow !== "function"
  ) {
    return decide(false, "no policy supplied; denied by default", null, input);
  }

  const name = typeof policy.name === "string" ? policy.name : "unnamed";

  let verdict: unknown;
  try {
    verdict = policy.allow(input);
  } catch {
    return decide(false, "policy threw; denied", name, input);
  }

  if (verdict === true) {
    return decide(true, "allowed by policy", name, input);
  }
  return decide(false, "policy did not allow", name, input);
}
