import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Where Key Authority keeps its rules and state.
 *
 * Both are anchored to the NEXUS code itself (the folder this file lives in,
 * three levels up), never to the folder NEXUS happens to be started from:
 *
 *   rules: <NEXUS>/config/key-authority.json
 *   state: <NEXUS>/.nexus
 *
 * The NEXUS_ROOT, NEXUS_RULES_PATH and NEXUS_STATE_DIR environment variables
 * can repoint them, so tests can run against temporary folders. The real
 * entry points (Genesis, both Founder CLIs) refuse to start when any of them
 * is set (see assertProductionPaths), so a launch can't quietly swap in a
 * fresh state folder with its own passphrase and rules.
 *
 * Resolved once, when this module first loads. Nothing at runtime can repoint them.
 */
export const CODE_ROOT = path.resolve(__dirname, "..", "..", "..");
export const PATH_OVERRIDES = Object.freeze(["NEXUS_ROOT", "NEXUS_RULES_PATH", "NEXUS_STATE_DIR"] as const);

export const PATHS = Object.freeze({
  root: path.resolve(process.env.NEXUS_ROOT || CODE_ROOT),
  rulesPath: path.resolve(process.env.NEXUS_RULES_PATH || path.join(CODE_ROOT, "config", "key-authority.json")),
  stateDir: path.resolve(process.env.NEXUS_STATE_DIR || path.join(CODE_ROOT, ".nexus")),
});

/**
 * For the real entry points: refuse to run when the rules, state or code
 * location has been redirected through the environment.
 */
export function assertProductionPaths(entry: string): void {
  const set = PATH_OVERRIDES.filter((k) => process.env[k] !== undefined && process.env[k] !== "");
  if (!set.length) return;
  console.error(`[${entry}] Refusing to start: ${set.join(", ")} ${set.length > 1 ? "are" : "is"} set.`);
  console.error(`[${entry}] NEXUS always uses its own config/key-authority.json and .nexus under ${CODE_ROOT}.`);
  console.error(`[${entry}] Those variables are for the test suite only. Unset them and run again.`);
  process.exit(2);
}

export const DIRS = Object.freeze({
  pending: path.join(PATHS.stateDir, "pending"),
  approvals: path.join(PATHS.stateDir, "approvals"),
  used: path.join(PATHS.stateDir, "used"),
  expired: path.join(PATHS.stateDir, "expired"),
  challenges: path.join(PATHS.stateDir, "challenges"),
});

export const LOCKDOWN_FILE = path.join(PATHS.stateDir, "lockdown.json");

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const ID_RE = /^[0-9a-f]{8}$/;

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write via a temp file and rename, so readers never see half a file. */
export function writeJSONAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

export function readJSON(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function listJSON(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/**
 * File for one approval: keyed by everything it covers (actor, action, target
 * and plan digest), so approving the same plan for two agents gives two
 * separate approvals instead of one overwriting the other.
 */
export function approvalFile(r: { actor: string; action: string; target: string; digest: string }): string {
  const key = crypto.createHash("sha256").update(JSON.stringify([r.actor, r.action, r.target, r.digest]), "utf-8").digest("hex");
  return path.join(DIRS.approvals, `${key}.json`);
}

/** File name for a digest: the hex part only. */
export function digestFile(dir: string, digest: string): string {
  return path.join(dir, digest.slice("sha256:".length) + ".json");
}

export function newId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export interface PendingRequest {
  id: string;
  actor: string;
  action: string;
  target: string;
  digest: string;
  summary: string;
  reasons: string[];
  requestedAt: string;
}

export interface Approval {
  id: string;
  actor: string;
  action: string;
  target: string;
  digest: string;
  approvedAt: string;
  expiresAt: number;
}

export interface LockdownRecord {
  since: string;
  incidents: { at: string; actor: string; action: string; target: string; reason: string }[];
}
