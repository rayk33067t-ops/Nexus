import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Where Key Authority keeps its rules and state. Resolved once, when this
 * module first loads, from the environment the founder launched NEXUS with.
 * Nothing at runtime can repoint them.
 *
 *   NEXUS_RULES_PATH  default: <cwd>/config/key-authority.json
 *   NEXUS_STATE_DIR   default: <cwd>/.nexus
 */
export const PATHS = Object.freeze({
  rulesPath: path.resolve(process.env.NEXUS_RULES_PATH || path.join(process.cwd(), "config", "key-authority.json")),
  stateDir: path.resolve(process.env.NEXUS_STATE_DIR || path.join(process.cwd(), ".nexus")),
});

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
