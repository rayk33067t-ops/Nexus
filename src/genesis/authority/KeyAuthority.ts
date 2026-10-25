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

/**
 * Key Authority — the only thing that can say yes to a protected action.
 *
 * Decision order for a request {actor, action, target, digest}:
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
 * This module is the Genesis-side API: it can decide, record pending
 * requests, accept Savannah's challenges and report hostile plans. Granting
 * approvals and clearing lockdown live in ./founder, which only the founder
 * CLI imports.
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
}

export interface RulesResult { ok: boolean; rules: readonly Rule[]; reason: string }

const bad = (reason: string): RulesResult => ({ ok: false, rules: [], reason });

const MAX_RULES = 500;
const MAX_SUMMARY = 64 * 1024;

function outcome(o: Effect, reason: string, requestId: string | null = null): AuthorityOutcome {
  return Object.freeze({ outcome: o, reason, requestId });
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

export function decide(input: AuthorityRequest): AuthorityOutcome {
  // Copy once; the caller's object is not read again.
  const req: AuthorityRequest = {
    actor: input?.actor,
    action: input?.action,
    target: input?.target,
    digest: input?.digest,
    summary: input?.summary,
  };
  for (const k of ["actor", "action", "target"] as const) {
    if (typeof req[k] !== "string" || req[k].length === 0) return outcome("deny", `${k} must be a non-empty string`);
  }
  if (typeof req.digest !== "string" || !DIGEST_RE.test(req.digest)) {
    return outcome("deny", "request has no valid plan digest");
  }
  if (req.summary !== undefined && (typeof req.summary !== "string" || req.summary.length > MAX_SUMMARY)) {
    return outcome("deny", "summary must be a string under 64 KB");
  }
  if (!(ACTIONS as readonly string[]).includes(req.action)) {
    return outcome("deny", `unknown action "${req.action}"`);
  }

  const loaded = loadRules();
  if (!loaded.ok) return outcome("deny", `no usable rules (${loaded.reason}); denied`);

  const ev = evaluateRules(loaded.rules, req);
  if (ev.effect === "deny") return outcome("deny", `denied by rule ${ev.ruleIds.join(", ")}`);
  if (ev.effect === null) return outcome("deny", "no rule matches; denied by default");

  const reasons: string[] = [];
  let effect: Effect = ev.effect;
  if (effect === "ask") reasons.push(`rule ${ev.ruleIds.join(", ")} requires founder approval`);
  if (effect === "allow" && isLockedDown()) { effect = "ask"; reasons.push("NEXUS is in lockdown"); }
  if (effect === "allow" && isChallenged(req.digest)) { effect = "ask"; reasons.push("Savannah challenged this plan"); }

  if (effect === "allow") return outcome("allow", `allowed by rule ${ev.ruleIds.join(", ")}`);

  if (consumeApproval(req)) return outcome("allow", "approved by founder (approval now used)");
  const id = recordPending(req, reasons);
  return outcome("ask", `waiting for founder approval: ${reasons.join("; ")}`, id);
}

// ---------- signals that only make things stricter ----------

/** Savannah challenges a plan. A challenge can only turn allow into ask; it can never approve. */
export function challenge(input: { actor: string; digest: string; reason: string }): boolean {
  const actor = input?.actor, digest = input?.digest, reason = input?.reason;
  if (actor !== "savannah") return false;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return false;
  if (typeof reason !== "string" || reason.length === 0) return false;
  writeJSONAtomic(digestFile(DIRS.challenges, digest), {
    actor, digest, reason: reason.slice(0, 2000), at: new Date().toISOString(),
  });
  return true;
}

/** Record a hostile request and put NEXUS into lockdown until the founder clears it. */
export function reportHostile(input: { actor: string; action: string; target: string; reason: string }): void {
  const prev = (readJSON(LOCKDOWN_FILE) as LockdownRecord | null) ?? null;
  const now = new Date().toISOString();
  const incident = {
    at: now,
    actor: String(input?.actor ?? "").slice(0, 256),
    action: String(input?.action ?? "").slice(0, 256),
    target: String(input?.target ?? "").slice(0, 1024),
    reason: String(input?.reason ?? "").slice(0, 2000),
  };
  const record: LockdownRecord = {
    since: prev?.since ?? now,
    incidents: [...(prev?.incidents ?? []), incident].slice(-100),
  };
  writeJSONAtomic(LOCKDOWN_FILE, record);
}

export { APPROVAL_TTL_MS };
