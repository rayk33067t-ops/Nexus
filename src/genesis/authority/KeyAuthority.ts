import fs from "fs";
import path from "path";

import {
  APPROVAL_TTL_MS,
  Approval,
  DIGEST_RE,
  DIRS,
  LOCKDOWN_FILE,
  LockdownRecord,
  PATHS,
  PendingRequest,
  digestFile,
  ensureDir,
  listJSON,
  newId,
  readJSON,
  writeJSONAtomic,
} from "./store";
import { getAgent, logEvent, recordSignal } from "../warden/state";
import { authenticate } from "./credentials";

/**
 * Key Authority — the only thing that can say yes to a protected action.
 *
 * Who is asking is never taken from the request. Every request is signed
 * with the agent's own key (see ./credentials), and the identity is the one
 * on the credential record that matches the signing key. Unsigned, forged,
 * revoked, expired, replayed or altered requests are denied before any rule
 * is looked at, and recorded without being pinned on an agent unless the
 * signature proves which key was used.
 *
 * Decision order for an authenticated request {agent, action, target, digest}:
 *  1. Rules come from the founder's rules file, read fresh on every request.
 *     A missing or invalid file means no rules, and no rules means deny.
 *  2. Any matching "deny" rule denies. Otherwise any matching "ask" asks.
 *     Otherwise any matching "allow" allows. No matching rule denies.
 *  3. An "allow" becomes "ask" while NEXUS is in lockdown, or when Savannah
 *     has challenged that exact plan digest.
 *  4. An "ask" is allowed only if the founder has approved that exact
 *     actor, action, target and digest, the approval has not expired, and it
 *     has not been used. Using it consumes it. Otherwise the request is
 *     recorded as pending for the founder to review.
 *
 * This module is the agents' side: it can decide, record pending requests,
 * accept Savannah's signed challenges and take hostile reports. Approving
 * and rejecting live in ./founder and need the Founder passphrase. Lockdown
 * is cleared only through the Warden's Founder module, which needs it too.
 *
 * Limit: Genesis and the founder run as the same Termux user, so this
 * protects against Genesis's own logic acting outside the rules. It cannot
 * stop hostile code already running as that user from editing these files.
 */

export const ACTIONS = Object.freeze(["fs.write", "key.use", "chronicle.append"] as const);
export type Action = (typeof ACTIONS)[number];
export type Effect = "allow" | "ask" | "deny";

export interface Rule {
  readonly id: string;
  readonly actor: string;   // exact name or "*"
  readonly action: string;  // one of ACTIONS or "*"
  readonly target: string;  // pattern: "*" matches within a "/" segment, "**" matches anything
  readonly effect: Effect;
}

export interface AuthorityRequest {
  actor: string;
  action: string;
  target: string;
  digest: string;
  summary?: string;
}

export interface AuthorityOutcome {
  readonly outcome: Effect;
  readonly reason: string;
  readonly requestId: string | null;
  /** The authenticated agent, or null when the request wasn't authenticated. */
  readonly actor: string | null;
}

export interface RulesResult { ok: boolean; rules: readonly Rule[]; reason: string }

const bad = (reason: string): RulesResult => ({ ok: false, rules: [], reason });

const MAX_RULES = 500;
const MAX_SUMMARY = 64 * 1024;

function outcome(o: Effect, reason: string, requestId: string | null = null, actor: string | null = null): AuthorityOutcome {
  return Object.freeze({ outcome: o, reason, requestId, actor });
}

const SIGNED_FIELDS = ["v", "publicKey", "nonce", "issuedAt", "signature", "action", "target", "digest", "summary", "actor", "agent"];

/** Copy only the fields a signed request may carry, once. */
function copySigned(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  return out;
}

const short = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);

/** Authenticate and record a refusal without secrets. Returns the agent or null. */
function whoSigned(r: Record<string, unknown>, purpose: string): { agent: string } | { reason: string } {
  const res = authenticate(r);
  if (res.ok === true) return { agent: (res as { agent: string }).agent };
  const a = res as { reason: string; fingerprint: string | null; credentialOf: string | null };
  logEvent({
    type: "auth-denied",
    purpose,
    reason: a.reason,
    credential: a.fingerprint ? a.fingerprint.slice(0, 16) : null,
    credentialOf: a.credentialOf,
    claimedActor: short(r.actor ?? r.agent, 64),
    action: short(r.action, 64),
    target: short(r.target, 256),
  });
  return { reason: a.reason };
}

// ---------- rules ----------

export function parseRules(raw: unknown): RulesResult {
  const doc = raw as { version?: unknown; rules?: unknown };
  if (!doc || typeof doc !== "object" || doc.version !== 1 || !Array.isArray(doc.rules)) {
    return bad('rules file must be {"version": 1, "rules": [...]}');
  }
  if (doc.rules.length > MAX_RULES) return bad(`more than ${MAX_RULES} rules`);

  const ids = new Set<string>();
  const rules: Rule[] = [];
  for (const [i, r] of doc.rules.entries()) {
    const x = r as Record<string, unknown>;
    const where = `rule ${i + 1}`;
    if (!x || typeof x !== "object") return bad(`${where} is not an object`);
    for (const k of ["id", "actor", "action", "target", "effect"]) {
      if (typeof x[k] !== "string" || (x[k] as string).length === 0 || (x[k] as string).length > 256) {
        return bad(`${where}: "${k}" must be a non-empty string`);
      }
    }
    const rule = Object.freeze({
      id: x.id as string,
      actor: x.actor as string,
      action: x.action as string,
      target: x.target as string,
      effect: x.effect as Effect,
    });
    if (ids.has(rule.id)) return bad(`${where}: duplicate id "${rule.id}"`);
    if (!["allow", "ask", "deny"].includes(rule.effect)) {
      return bad(`${where}: effect must be allow, ask or deny`);
    }
    if (rule.action !== "*" && !(ACTIONS as readonly string[]).includes(rule.action)) {
      return bad(`${where}: unknown action "${rule.action}"`);
    }
    ids.add(rule.id);
    rules.push(rule);
  }
  return { ok: true, rules: Object.freeze(rules), reason: "" };
}

export function loadRules(file: string = PATHS.rulesPath): RulesResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return bad(`no rules file at ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("rules file is not valid JSON");
  }
  return parseRules(raw);
}

/** "*" matches any run of characters except "/"; "**" matches anything. */
export function matchPattern(pattern: string, value: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$").test(value);
}

export function evaluateRules(rules: readonly Rule[], req: { actor: string; action: string; target: string }) {
  const matched = rules.filter(
    (r) =>
      (r.actor === "*" || r.actor === req.actor) &&
      (r.action === "*" || r.action === req.action) &&
      matchPattern(r.target, req.target)
  );
  const pick = (e: Effect) => matched.filter((r) => r.effect === e).map((r) => r.id);
  const deny = pick("deny"), ask = pick("ask"), allow = pick("allow");
  if (deny.length) return { effect: "deny" as Effect, ruleIds: deny };
  if (ask.length) return { effect: "ask" as Effect, ruleIds: ask };
  if (allow.length) return { effect: "allow" as Effect, ruleIds: allow };
  return { effect: null, ruleIds: [] as string[] };
}

// ---------- state ----------

export function isLockedDown(): boolean {
  return fs.existsSync(LOCKDOWN_FILE);
}

export function isChallenged(digest: string): boolean {
  return fs.existsSync(digestFile(DIRS.challenges, digest));
}

function sameRequest(a: { actor: string; action: string; target: string; digest: string }, b: AuthorityRequest): boolean {
  return a.actor === b.actor && a.action === b.action && a.target === b.target && a.digest === b.digest;
}

/** Use a matching founder approval once. Returns true only if it was valid and is now consumed. */
function consumeApproval(req: AuthorityRequest): boolean {
  const file = digestFile(DIRS.approvals, req.digest);
  const a = readJSON(file) as Approval | null;
  if (!a) return false;
  if (!sameRequest(a, req)) return false;

  const stamp = Date.now();
  if (typeof a.expiresAt !== "number" || a.expiresAt <= stamp) {
    ensureDir(DIRS.expired);
    try { fs.renameSync(file, path.join(DIRS.expired, `${path.basename(file, ".json")}-${stamp}.json`)); } catch { /* already gone */ }
    return false;
  }
  // rename is atomic: if two callers race, only one succeeds
  ensureDir(DIRS.used);
  try {
    fs.renameSync(file, path.join(DIRS.used, `${path.basename(file, ".json")}-${stamp}.json`));
  } catch {
    return false;
  }
  return true;
}

function recordPending(req: AuthorityRequest, reasons: string[]): string {
  for (const f of listJSON(DIRS.pending)) {
    const p = readJSON(path.join(DIRS.pending, f)) as PendingRequest | null;
    if (p && sameRequest(p, req)) return p.id;
  }
  const id = newId();
  const pending: PendingRequest = {
    id,
    actor: req.actor,
    action: req.action,
    target: req.target,
    digest: req.digest,
    summary: req.summary ?? "",
    reasons,
    requestedAt: new Date().toISOString(),
  };
  writeJSONAtomic(path.join(DIRS.pending, `${id}.json`), pending);
  return id;
}

// ---------- the decision ----------

/**
 * Decide a signed request. The caller's object is copied once and not read
 * again. The identity used everywhere below is the authenticated one.
 */
export function decide(input: unknown): AuthorityOutcome {
  const r = copySigned(input);
  if (!r) return outcome("deny", "request must be a signed object");
  const who = whoSigned(r, "decide");
  if ("reason" in who) return outcome("deny", `not authenticated: ${who.reason}`);

  const req: AuthorityRequest = {
    actor: who.agent,
    action: r.action as string,
    target: r.target as string,
    digest: r.digest as string,
    summary: r.summary as string | undefined,
  };
  if (!DIGEST_RE.test(req.digest)) return outcome("deny", "request has no valid plan digest", null, req.actor);
  if (req.summary !== undefined && req.summary.length > MAX_SUMMARY) {
    return outcome("deny", "summary must be a string under 64 KB", null, req.actor);
  }
  // The Warden's verdict on this agent comes before any rule.
  const agent = getAgent(req.actor);
  if (agent.status === "quarantined") {
    return outcome("deny", `${req.actor} is quarantined by the Warden (${agent.reasons.join("; ") || "no reason recorded"})`, null, req.actor);
  }

  if (!(ACTIONS as readonly string[]).includes(req.action)) {
    recordSignal(req.actor, "denied", `unknown action "${req.action}"`);
    return outcome("deny", `unknown action "${req.action}"`, null, req.actor);
  }

  const loaded = loadRules();
  if (!loaded.ok) return outcome("deny", `no usable rules (${loaded.reason}); denied`, null, req.actor);

  const ev = evaluateRules(loaded.rules, req);
  if (ev.effect === "deny") {
    recordSignal(req.actor, "denied", `${req.action} on ${req.target} denied by rule ${ev.ruleIds.join(", ")}`);
    return outcome("deny", `denied by rule ${ev.ruleIds.join(", ")}`, null, req.actor);
  }
  if (ev.effect === null) return outcome("deny", "no rule matches; denied by default", null, req.actor);

  const reasons: string[] = [];
  let effect: Effect = ev.effect;
  if (effect === "ask") reasons.push(`rule ${ev.ruleIds.join(", ")} requires founder approval`);
  if (effect === "allow" && agent.status === "probation") { effect = "ask"; reasons.push(`${req.actor} is on probation`); }
  if (effect === "allow" && isLockedDown()) { effect = "ask"; reasons.push("NEXUS is in lockdown"); }
  if (effect === "allow" && isChallenged(req.digest)) { effect = "ask"; reasons.push("Savannah challenged this plan"); }

  if (effect === "allow") return outcome("allow", `allowed by rule ${ev.ruleIds.join(", ")}`, null, req.actor);

  if (consumeApproval(req)) return outcome("allow", "approved by founder (approval now used)", null, req.actor);
  const id = recordPending(req, reasons);
  return outcome("ask", `waiting for founder approval: ${reasons.join("; ")}`, id, req.actor);
}

// ---------- signals that only make things stricter ----------

/**
 * Savannah challenges a plan. The request must be signed with Savannah's
 * credential, with action "plan.challenge" and the challenged plan's digest.
 * A challenge can only turn allow into ask; it can never approve.
 */
export function challenge(input: unknown, reason: string): boolean {
  const r = copySigned(input);
  if (!r) return false;
  const who = whoSigned(r, "challenge");
  if ("reason" in who) return false;
  if (who.agent !== "savannah" || r.action !== "plan.challenge") {
    logEvent({ type: "challenge-refused", agent: who.agent, reason: "only Savannah can challenge, with action plan.challenge" });
    return false;
  }
  const digest = r.digest as string;
  if (!DIGEST_RE.test(digest) || typeof reason !== "string" || reason.length === 0) return false;
  writeJSONAtomic(digestFile(DIRS.challenges, digest), {
    actor: who.agent, digest, reason: reason.slice(0, 2000), at: new Date().toISOString(),
  });
  return true;
}

/**
 * Report a hostile plan. NEXUS always goes into lockdown. The Warden
 * quarantines an agent only when the report is signed with that agent's
 * valid credential; otherwise the incident is recorded as unauthenticated
 * and no agent is blamed.
 */
export function reportHostile(input: unknown, reason: string): void {
  const r = copySigned(input);
  const who = r ? whoSigned(r, "hostile-report") : { reason: "no signed request" };
  const agent = "agent" in who ? who.agent : null;
  const prev = (readJSON(LOCKDOWN_FILE) as LockdownRecord | null) ?? null;
  const now = new Date().toISOString();
  const incident = {
    at: now,
    actor: agent ?? "(unauthenticated)",
    action: short(r?.action, 256) ?? "",
    target: short(r?.target, 1024) ?? "",
    reason: String(reason ?? "").slice(0, 2000),
  };
  const record: LockdownRecord = {
    since: prev?.since ?? now,
    incidents: [...(prev?.incidents ?? []), incident].slice(-100),
  };
  writeJSONAtomic(LOCKDOWN_FILE, record);
  if (agent) recordSignal(agent, "hostile", `${incident.action} on ${incident.target}: ${incident.reason}`);
  else logEvent({ type: "hostile-unattributed", action: incident.action, target: incident.target, reason: incident.reason.slice(0, 500) });
}

export { APPROVAL_TTL_MS };
