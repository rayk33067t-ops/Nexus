import crypto from "crypto";
import fs from "fs";
import path from "path";

import { canonicalJSON } from "../authority/canonical";

/**
 * Append-only, hash-chained event log. Each line carries the hash of the
 * line before it, and the hash of the newest line is kept separately as the
 * head. Editing, removing or reordering any line breaks the chain, and
 * truncating the file no longer matches the head.
 *
 * Limit: something running as the same user could rewrite the whole file
 * and the head together. `warden pin` records the head in the baseline, and
 * the founder can note the head printed by `warden log` somewhere off the
 * phone to catch that.
 */

const GENESIS_HASH = "0".repeat(64);

export interface LogEntry {
  seq: number;
  at: string;
  prev: string;
  event: Record<string, unknown>;
  hash: string;
}

function entryHash(prev: string, seq: number, at: string, event: unknown): string {
  return crypto.createHash("sha256").update(prev + canonicalJSON({ seq, at, event }), "utf-8").digest("hex");
}

function readHead(headFile: string): string | null {
  try { return fs.readFileSync(headFile, "utf-8").trim(); } catch { return null; }
}

export function appendLog(file: string, headFile: string, event: Record<string, unknown>): LogEntry {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prev = GENESIS_HASH, seq = 0;
  const v = verifyLog(file, headFile);
  // Never let a new append quietly "heal" a damaged log: record the damage first.
  if (!v.ok && !fs.existsSync(tamperFile(file))) {
    fs.writeFileSync(tamperFile(file), JSON.stringify({ at: new Date().toISOString(), reason: v.reason }) + "\n", { mode: 0o600 });
  }
  if (v.count > 0 && v.lastHash) { prev = v.lastHash; seq = v.count; }
  const at = new Date().toISOString();
  const entry: LogEntry = { seq, at, prev, event, hash: entryHash(prev, seq, at, event) };
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  fs.writeFileSync(headFile, entry.hash + "\n", { mode: 0o600 });
  return entry;
}

export function tamperFile(file: string): string {
  return file + ".tampered";
}

export interface LogCheck {
  ok: boolean;
  count: number;
  lastHash: string | null;
  reason: string;
}

export function verifyLog(file: string, headFile: string): LogCheck {
  let text = "";
  try { text = fs.readFileSync(file, "utf-8"); } catch { /* no log yet */ }
  const lines = text.split("\n").filter((l) => l.length > 0);
  const head = readHead(headFile);
  let marker: { reason?: string } | null = null;
  try { marker = JSON.parse(fs.readFileSync(tamperFile(file), "utf-8")); } catch { /* none */ }

  if (lines.length === 0) {
    if (marker) return { ok: false, count: 0, lastHash: null, reason: `log was damaged earlier: ${marker.reason ?? "unknown"}` };
    return head ? { ok: false, count: 0, lastHash: null, reason: "log is empty but a head exists (log deleted?)" }
                : { ok: true, count: 0, lastHash: null, reason: "empty" };
  }

  let prev = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let e: LogEntry;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, count: i, lastHash: prev, reason: `line ${i + 1} is not valid JSON` }; }
    if (e.seq !== i || e.prev !== prev || e.hash !== entryHash(e.prev, e.seq, e.at, e.event)) {
      return { ok: false, count: i, lastHash: prev, reason: `chain broken at entry ${i}` };
    }
    prev = e.hash;
  }
  if (head !== prev) return { ok: false, count: lines.length, lastHash: prev, reason: "log does not end at the recorded head (truncated or replaced?)" };
  if (marker) return { ok: false, count: lines.length, lastHash: prev, reason: `log was damaged earlier: ${marker.reason ?? "unknown"}` };
  return { ok: true, count: lines.length, lastHash: prev, reason: "intact" };
}

export function readLog(file: string): LogEntry[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
