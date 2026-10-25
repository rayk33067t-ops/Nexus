import fs from "fs";
import path from "path";

import {
  APPROVAL_TTL_MS,
  Approval,
  DIRS,
  ID_RE,
  LOCKDOWN_FILE,
  LockdownRecord,
  PendingRequest,
  digestFile,
  listJSON,
  readJSON,
  writeJSONAtomic,
} from "./store";

/**
 * Founder-only operations. Only the founder CLI (./cli.ts) imports this
 * module; a test enforces that nothing else in src/ does.
 */

export function listPending(): PendingRequest[] {
  return listJSON(DIRS.pending)
    .map((f) => readJSON(path.join(DIRS.pending, f)) as PendingRequest | null)
    .filter((p): p is PendingRequest => !!p && typeof p.id === "string");
}

function pendingFile(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Not a request id: ${id}`);
  return path.join(DIRS.pending, `${id}.json`);
}

export function getPending(id: string): PendingRequest {
  const p = readJSON(pendingFile(id)) as PendingRequest | null;
  if (!p) throw new Error(`No pending request with id ${id}.`);
  return p;
}

/** Approve one pending request: a single-use approval for its exact plan digest. */
export function approve(id: string, ttlMs: number = APPROVAL_TTL_MS): Approval {
  const p = getPending(id);
  const approval: Approval = {
    id: p.id,
    actor: p.actor,
    action: p.action,
    target: p.target,
    digest: p.digest,
    approvedAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlMs,
  };
  writeJSONAtomic(digestFile(DIRS.approvals, p.digest), approval);
  fs.rmSync(pendingFile(id), { force: true });
  return approval;
}

export function reject(id: string): PendingRequest {
  const p = getPending(id);
  fs.rmSync(pendingFile(id), { force: true });
  return p;
}

export function lockdownStatus(): LockdownRecord | null {
  return readJSON(LOCKDOWN_FILE) as LockdownRecord | null;
}

export function clearLockdown(): boolean {
  if (!fs.existsSync(LOCKDOWN_FILE)) return false;
  fs.rmSync(LOCKDOWN_FILE, { force: true });
  return true;
}
