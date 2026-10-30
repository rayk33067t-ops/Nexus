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
  approvalFile,
  listJSON,
  readJSON,
  writeJSONAtomic,
} from "./store";
import { requireFounder } from "../warden/passphrase";
import { lockdownActive, logEvent } from "../warden/state";

/**
 * Founder-only Key Authority operations. Only the founder CLI (./cli.ts)
 * imports this module; a test enforces that.
 *
 * Approving and rejecting check the Founder passphrase themselves, so a
 * direct call without it fails exactly like the CLI does, and changes
 * nothing. Reading pending requests and lockdown status needs no passphrase.
 *
 * Lockdown is not cleared here. The only way to end it is the Warden's
 * clearLockdown (warden/founder), which needs the passphrase and refuses
 * while any agent is quarantined.
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
export function approve(id: string, passphrase: string, ttlMs: number = APPROVAL_TTL_MS): Approval {
  const p = getPending(id);
  requireFounder(passphrase, "request.approve");
  const approval: Approval = {
    id: p.id,
    actor: p.actor,
    action: p.action,
    target: p.target,
    digest: p.digest,
    approvedAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlMs,
  };
  writeJSONAtomic(approvalFile(p), approval);
  fs.rmSync(pendingFile(id), { force: true });
  logEvent({ type: "request-approved", id: p.id, actor: p.actor, action: p.action, target: p.target });
  return approval;
}

export function reject(id: string, passphrase: string): PendingRequest {
  const p = getPending(id);
  requireFounder(passphrase, "request.reject");
  fs.rmSync(pendingFile(id), { force: true });
  logEvent({ type: "request-rejected", id: p.id, actor: p.actor, action: p.action, target: p.target });
  return p;
}

export function lockdownStatus(): LockdownRecord | null {
  const rec = readJSON(LOCKDOWN_FILE) as LockdownRecord | null;
  if (rec) return rec;
  const s = lockdownActive();
  return s.locked ? { since: "(unknown: the lockdown file is missing)", incidents: [{ at: "", actor: "", action: "", target: "", reason: s.why }] } : null;
}
