import crypto from "crypto";
import fs from "fs";
import path from "path";

import { PATHS, ensureDir, readJSON, writeJSONAtomic } from "./authority/store";
import { logEvent } from "./warden/state";

/**
 * Build journal: what a build has created, so a failed or interrupted build
 * can be undone exactly, and nothing else.
 *
 *  - Before a build touches the disk, a journal is saved for it. After each
 *    directory or file the build creates, the journal records the item's
 *    path and its device and inode numbers.
 *  - If the build fails, cleanup removes only items that are still the very
 *    ones it created: same path, kind, device and inode, and for a file, the
 *    exact content the build wrote (checked by SHA-256). Inode numbers alone
 *    are not proof, because a filesystem may give a new file the number of
 *    one just deleted. A directory is removed only if it is empty, so files
 *    the build did not create are never deleted.
 *  - If the process was interrupted (crash, killed, phone restarted), the
 *    journal is still there. The next attempt at the same project cleans up
 *    from it first, and records that the earlier attempt was interrupted.
 *  - If anything can't be safely removed, the project is left as it is and
 *    the next attempt is refused with an explanation. Nothing is overwritten.
 *  - Every outcome is appended to history.jsonl and to the Warden's event
 *    log. A later success never removes the record of an earlier failure.
 *
 * Limit: an item created in the instant between its creation and the
 * journal save (a crash in between) is unknown to the journal. Recovery then
 * keeps it, reports the project as needing attention, and deletes nothing
 * it can't prove it made.
 */

export const BUILDS_DIR = path.join(PATHS.stateDir, "builds");
export const HISTORY_FILE = path.join(BUILDS_DIR, "history.jsonl");

export type EntryKind = "root" | "dir" | "file";
export interface JournalEntry {
  kind: EntryKind;
  rel: string;
  dev: number;
  ino: number;
  /** Files only: SHA-256 of the content the build writes, and whether the write finished. */
  sha256?: string;
  written?: boolean;
}

export interface Journal {
  v: 1;
  attemptId: string;
  project: string;
  projectRoot: string;
  digest: string | null;
  startedAt: string;
  status: "in-progress" | "needs-attention";
  created: JournalEntry[];
}

export interface CleanupResult {
  removed: string[];
  kept: { rel: string; why: string }[];
}

export type BuildOutcome = "completed" | "failed" | "interrupted" | "recovery-incomplete";

export interface HistoryRecord {
  at: string;
  attemptId: string;
  project: string;
  projectRoot: string;
  outcome: BuildOutcome;
  filesWritten: number;
  cleanup?: CleanupResult;
  error?: string;
}

export function journalFile(projectRoot: string): string {
  const id = crypto.createHash("sha256").update(projectRoot, "utf-8").digest("hex").slice(0, 32);
  return path.join(BUILDS_DIR, `${id}.json`);
}

export function readJournal(projectRoot: string): Journal | null {
  const j = readJSON(journalFile(projectRoot)) as Journal | null;
  if (!j || j.v !== 1 || j.projectRoot !== projectRoot || !Array.isArray(j.created)) return null;
  return j;
}

export function saveJournal(j: Journal): void {
  writeJSONAtomic(journalFile(j.projectRoot), j);
}

export function dropJournal(projectRoot: string): void {
  fs.rmSync(journalFile(projectRoot), { force: true });
}

export function startJournal(project: string, projectRoot: string, digest: string | null): Journal {
  const j: Journal = {
    v: 1,
    attemptId: crypto.randomBytes(6).toString("hex"),
    project,
    projectRoot,
    digest,
    startedAt: new Date().toISOString(),
    status: "in-progress",
    created: [],
  };
  saveJournal(j);
  return j;
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Record an item the build has just created (for a file: before writing its content). */
export function recordCreated(j: Journal, kind: EntryKind, rel: string, content?: string): void {
  const abs = rel ? path.join(j.projectRoot, rel) : j.projectRoot;
  const st = fs.lstatSync(abs);
  const e: JournalEntry = { kind, rel, dev: st.dev, ino: st.ino };
  if (kind === "file") { e.sha256 = sha256(content ?? ""); e.written = false; }
  j.created.push(e);
  saveJournal(j);
}

/** Record that a file's content was fully written. */
export function markWritten(j: Journal, rel: string): void {
  const e = j.created.find((x) => x.kind === "file" && x.rel === rel);
  if (e) { e.written = true; saveJournal(j); }
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Undo a build: newest first, only items that are provably the build's own. */
export function cleanup(j: Journal): CleanupResult {
  const removed: string[] = [];
  const kept: { rel: string; why: string }[] = [];
  for (const e of [...j.created].reverse()) {
    const label = e.rel || "(project folder)";
    const abs = e.rel ? path.join(j.projectRoot, e.rel) : j.projectRoot;
    if (!inside(j.projectRoot, abs) || (e.kind === "root") !== (e.rel === "")) {
      kept.push({ rel: label, why: "journal entry is outside the project; ignored" });
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // already gone
    }
    if (st.dev !== e.dev || st.ino !== e.ino) {
      kept.push({ rel: label, why: "replaced by something this build did not create" });
      continue;
    }
    try {
      if (e.kind === "file") {
        if (!st.isFile()) { kept.push({ rel: label, why: "no longer a regular file" }); continue; }
        // Ours only if it still holds exactly what this build wrote (or nothing,
        // if it stopped before writing). Anything else may be someone's work.
        const ours = sha256(fs.readFileSync(abs)) === e.sha256 || (!e.written && st.size === 0);
        if (!ours) { kept.push({ rel: label, why: "its content is not what this build wrote" }); continue; }
        fs.unlinkSync(abs);
      } else {
        if (!st.isDirectory() || st.isSymbolicLink()) { kept.push({ rel: label, why: "no longer a real directory" }); continue; }
        fs.rmdirSync(abs); // fails unless empty: other people's files stay
      }
      removed.push(label);
    } catch (err: any) {
      kept.push({ rel: label, why: err?.code === "ENOTEMPTY" || err?.code === "EEXIST" ? "contains files this build did not create" : `could not remove (${err?.code ?? "error"})` });
    }
  }
  return { removed, kept };
}

export function appendHistory(rec: HistoryRecord): void {
  ensureDir(BUILDS_DIR);
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(rec) + "\n", { mode: 0o600 });
  logEvent({
    type: "build",
    outcome: rec.outcome,
    project: rec.project,
    attemptId: rec.attemptId,
    filesWritten: rec.filesWritten,
    removed: rec.cleanup?.removed.length ?? 0,
    kept: rec.cleanup?.kept.length ?? 0,
  });
}

export function readHistory(project?: string): HistoryRecord[] {
  let text = "";
  try { text = fs.readFileSync(HISTORY_FILE, "utf-8"); } catch { return []; }
  const out: HistoryRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as HistoryRecord;
      if (!project || r.project === project) out.push(r);
    } catch { /* skip damaged line */ }
  }
  return out;
}

export function filesIn(j: Journal): number {
  return j.created.filter((e) => e.kind === "file").length;
}
