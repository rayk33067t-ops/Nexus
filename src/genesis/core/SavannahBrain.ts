import path from "path";

import { challenge, reportHostile } from "../authority/KeyAuthority";
import { digestOf } from "../authority/canonical";
import { KNOWN_AGENTS } from "../warden/state";

/**
 * Savannah's brain — the security counterpart to Genesis.
 *
 * Genesis proposes plans. Savannah reads each plan before Key Authority
 * decides on it and reaches one of three verdicts:
 *
 *   pass       nothing found; Key Authority decides as normal
 *   challenge  something needs a human look; she calls challenge(), which
 *              turns an "allow" for that exact plan digest into "ask", so
 *              the founder must approve it
 *   hostile    the plan attacks NEXUS itself; she calls reportHostile(),
 *              which puts NEXUS in lockdown and has the Warden quarantine
 *              the agent that sent it
 *
 * Savannah can only ever make NEXUS stricter. She never approves anything:
 * this module does not import the founder-only approval API, never asks
 * Key Authority for a decision, and has no code path that removes a
 * challenge or clears a lockdown.
 *
 * She reasons only from the plan itself — deterministic checks, no AI
 * provider — so the same plan always gets the same verdict.
 */

export type Verdict = "pass" | "challenge" | "hostile";
export type Severity = "notice" | "challenge" | "hostile";
export type SavannahMode = "WATCH" | "ALERT" | "LOCKDOWN";

export interface PlanFile {
  path: string;
  content: string;
}

/** A plan as Genesis submits it to Key Authority, plus what it would write. */
export interface Plan {
  actor: string;
  action: string;
  target: string;
  digest: string;
  summary?: string;
  /** Present for fs.write plans so Savannah can read what would be written. */
  root?: string;
  project?: string;
  files?: PlanFile[];
}

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly detail: string;
  readonly file?: string;
}

export interface Review {
  readonly verdict: Verdict;
  readonly digest: string;
  readonly findings: readonly Finding[];
  readonly reason: string;
}

export interface SavannahState {
  mode: SavannahMode;
  reviewed: number;
  challenged: number;
  hostile: number;
  lastDigest: string | null;
}

export function createSavannahState(): SavannahState {
  return { mode: "WATCH", reviewed: 0, challenged: 0, hostile: 0, lastDigest: null };
}

// ---------- limits ----------

export const LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
});

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// ---------- what Savannah looks for ----------

/** Paths that belong to NEXUS's own security. Writing to them is an attack. */
const PROTECTED_PATHS: readonly RegExp[] = [
  /(^|\/)\.nexus(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)config\/key-authority[^/]*$/i,
  /(^|\/)src\/genesis\/(authority|warden|guards)(\/|$)/i,
  /(^|\/)founder\.secret$/i,
];

/** Content that reaches for NEXUS's security state. */
const HOSTILE_CONTENT: readonly { code: string; re: RegExp; detail: string }[] = [
  { code: "TOUCHES_FOUNDER_SECRET", re: /founder\.secret/i, detail: "refers to the founder secret" },
  { code: "TOUCHES_AUTHORITY_STATE", re: /NEXUS_(STATE_DIR|RULES_PATH)|\.nexus\/(approvals|pending|used|challenges|lockdown)/i, detail: "refers to Key Authority's state or rules location" },
  { code: "IMPORTS_FOUNDER_API", re: /authority\/founder['"]/, detail: "imports the founder-only approval API" },
];

/** Content a human should look at before it runs. */
const RISKY_CONTENT: readonly { code: string; re: RegExp; detail: string }[] = [
  { code: "PRIVATE_KEY", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, detail: "contains a private key" },
  { code: "API_KEY", re: /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})\b/, detail: "contains what looks like an API key" },
  { code: "SHELL_EXEC", re: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync?\s*\(/, detail: "runs shell commands" },
  { code: "DYNAMIC_CODE", re: /\beval\s*\(|\bnew\s+Function\s*\(/, detail: "builds and runs code at runtime" },
  { code: "PIPE_TO_SHELL", re: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/, detail: "downloads and runs a script" },
  { code: "RECURSIVE_DELETE", re: /\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+|\brmSync\s*\([^)]*recursive\s*:\s*true/i, detail: "deletes files recursively" },
  { code: "ENV_EXFIL", re: /process\.env[\s\S]{0,200}\b(fetch|axios|https?\.request)\s*\(|\b(fetch|axios|https?\.request)\s*\([\s\S]{0,200}process\.env/, detail: "sends environment variables over the network" },
];

// ---------- review ----------

function finding(code: string, severity: Severity, detail: string, file?: string): Finding {
  return Object.freeze(file === undefined ? { code, severity, detail } : { code, severity, detail, file });
}

function isUnsafePath(p: string): boolean {
  if (p.length === 0 || p.includes("\0")) return true;
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return true;
  return p.split(/[\\/]/).includes("..");
}

function reviewFiles(plan: Plan, out: Finding[]): void {
  const files = plan.files ?? [];
  if (files.length > LIMITS.maxFiles) {
    out.push(finding("TOO_MANY_FILES", "challenge", `${files.length} files (limit ${LIMITS.maxFiles})`));
  }

  let total = 0;
  for (const f of files) {
    const p = typeof f?.path === "string" ? f.path : "";
    const content = typeof f?.content === "string" ? f.content : "";
    const bytes = Buffer.byteLength(content, "utf-8");
    total += bytes;

    if (isUnsafePath(p)) {
      out.push(finding("PATH_ESCAPE", "hostile", "path leaves the project folder", p));
      continue;
    }
    if (PROTECTED_PATHS.some((re) => re.test(p))) {
      out.push(finding("PROTECTED_PATH", "hostile", "writes into NEXUS's own security files", p));
    }
    if (bytes > LIMITS.maxFileBytes) {
      out.push(finding("FILE_TOO_LARGE", "challenge", `${bytes} bytes (limit ${LIMITS.maxFileBytes})`, p));
    }
    for (const c of HOSTILE_CONTENT) if (c.re.test(content)) out.push(finding(c.code, "hostile", c.detail, p));
    for (const c of RISKY_CONTENT) if (c.re.test(content)) out.push(finding(c.code, "challenge", c.detail, p));
  }

  if (total > LIMITS.maxTotalBytes) {
    out.push(finding("PLAN_TOO_LARGE", "challenge", `${total} bytes in total (limit ${LIMITS.maxTotalBytes})`));
  }
}

/**
 * Read a plan and decide. Pure: no files are written and nothing is
 * reported. Use runSavannah() to act on the result.
 */
export function reviewPlan(plan: Plan): Review {
  const findings: Finding[] = [];
  const digest = typeof plan?.digest === "string" ? plan.digest : "";

  if (!DIGEST_RE.test(digest)) {
    findings.push(finding("BAD_DIGEST", "challenge", "plan has no valid sha256 digest"));
  }

  const actor = String(plan?.actor ?? "");
  if (actor === "savannah" && plan?.action !== "chronicle.append") {
    findings.push(finding("SAVANNAH_ACTING", "challenge", "Savannah reviews plans; she does not carry them out"));
  } else if (!(KNOWN_AGENTS as readonly string[]).includes(actor)) {
    findings.push(finding("UNKNOWN_AGENT", "challenge", `"${actor}" is not a known NEXUS agent`));
  }

  if (plan?.action === "fs.write") {
    if (!/^project:[^/\\]+$/.test(String(plan.target ?? ""))) {
      findings.push(finding("UNEXPECTED_TARGET", "challenge", `fs.write to "${plan.target}" instead of a project`));
    }
    if (!Array.isArray(plan.files)) {
      findings.push(finding("UNREADABLE_PLAN", "challenge", "fs.write plan did not include its files, so it cannot be checked"));
    } else {
      reviewFiles(plan, findings);
      // The digest must describe exactly these files, or the plan is lying
      // about what Key Authority would be approving.
      if (DIGEST_RE.test(digest) && typeof plan.root === "string" && typeof plan.project === "string") {
        let expected = "";
        try {
          expected = digestOf({ root: plan.root, project: plan.project, files: plan.files.map((f) => ({ path: f.path, content: f.content })) });
        } catch {
          expected = "";
        }
        if (expected !== digest) {
          findings.push(finding("DIGEST_MISMATCH", "hostile", "digest does not match the files in the plan"));
        }
      }
    }
  }

  const verdict: Verdict = findings.some((f) => f.severity === "hostile")
    ? "hostile"
    : findings.some((f) => f.severity === "challenge")
      ? "challenge"
      : "pass";

  const reason = findings.length === 0
    ? "no concerns"
    : findings.map((f) => (f.file ? `${f.code} in ${f.file}: ${f.detail}` : `${f.code}: ${f.detail}`)).join("; ");

  return Object.freeze({ verdict, digest, findings: Object.freeze(findings), reason });
}

// ---------- acting on a review ----------

/**
 * Review a plan and act on the verdict, the same way runGenesis drives
 * Genesis. Call it before coreGuard / Key Authority decides on the plan.
 * A challenge is filed against the plan's digest; a hostile plan is reported,
 * which locks NEXUS down and quarantines the actor.
 */
export function runSavannah(plan: Plan, state: SavannahState) {
  const review = reviewPlan(plan);
  state.reviewed += 1;
  state.lastDigest = review.digest || null;

  let acted = false;
  if (review.verdict === "hostile") {
    reportHostile({
      actor: String(plan?.actor ?? ""),
      action: String(plan?.action ?? ""),
      target: String(plan?.target ?? ""),
      reason: `Savannah: ${review.reason}`,
    });
    // Also challenge the digest, so this exact plan stays blocked even after
    // the lockdown is lifted.
    if (DIGEST_RE.test(review.digest)) challenge({ actor: "savannah", digest: review.digest, reason: review.reason });
    state.hostile += 1;
    state.mode = "LOCKDOWN";
    acted = true;
  } else if (review.verdict === "challenge" && DIGEST_RE.test(review.digest)) {
    acted = challenge({ actor: "savannah", digest: review.digest, reason: review.reason });
    state.challenged += 1;
    if (state.mode === "WATCH") state.mode = "ALERT";
  }

  return {
    system: "SAVANNAH",
    state,
    review,
    acted,
  };
}
