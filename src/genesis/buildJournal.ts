import crypto from "crypto";
import fs from "fs";
import path from "path";

import { PATHS, ensureDir, readJSON, writeJSONAtomic } from "./authority/store";
import { logEvent } from "./warden/state";
import { DIR_FLAGS, LinkInPath, anchoredAvailable, at, openChildDir } from "./safeFs";

/**
 * Build journal: what a build has created, so a failed or interrupted build
 * can be undone exactly, and nothing else.
 *
 *  - Before a build touches the disk, a journal is saved for it. After each
 *    directory or file the build creates, the journal records the item's
 *    path and its device and inode numbers.
 *  - If the build fails, cleanup removes only items that are still the very
 *    ones it created. Content matching is one check among several, not a
 *    substitute for safe identity: the recorded path must be a plain path
 *    inside the project, no folder on the way may be a link, the item must be
 *    the same kind, device and inode, and a file must hold exactly the content
 *    the build wrote (checked through the same open descriptor). Inode numbers
 *    alone are not proof, because a filesystem may give a new file the number
 *    of one just deleted. A folder is removed only if it is empty.
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

/**
 * Record an item the build has just created (for a file: before writing its
 * content). Pass the item's own fstat when the build holds it open, so the
 * identity recorded is the item's, not whatever its path points to.
 */
export function recordCreated(j: Journal, kind: EntryKind, rel: string, content?: string, own?: { dev: number; ino: number }): void {
  const st = own ?? fs.lstatSync(rel ? path.join(j.projectRoot, rel) : j.projectRoot);
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

const BAD_SEGMENT = (seg: string) => seg === "" || seg === "." || seg === ".." || seg.includes("\\") || seg.includes("\0");

/** A recorded path must be a plain relative path: no "..", no absolute paths, no odd segments. */
function validRel(rel: string): boolean {
  if (typeof rel !== "string") return false;
  if (rel === "") return true; // the project folder itself
  if (rel.startsWith("/") || path.isAbsolute(rel)) return false;
  return !rel.split("/").some(BAD_SEGMENT);
}

/**
 * The project folder must still be the real folder the build made: not a
 * symlink, and resolving to exactly its recorded path.
 */
function projectRootIntact(j: Journal): string | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(j.projectRoot); } catch { return null; } // gone: nothing to do
  if (st.isSymbolicLink() || !st.isDirectory()) return "the project folder is no longer a real folder";
  try {
    if (fs.realpathSync(j.projectRoot) !== j.projectRoot) return "the project folder now resolves somewhere else";
  } catch { return "the project folder can't be resolved"; }
  return null;
}

/** Where an entry is, reached without following any link; or why it can't be. */
type Located =
  | { kind: "here"; p: string; close: number[] }   // p names the entry; close these fds afterwards
  | { kind: "gone" }
  | { kind: "problem"; why: string };

/**
 * Reach an entry's folder one level at a time from the project folder.
 * Anchored mode opens each folder with O_NOFOLLOW and names the entry through
 * /proc/self/fd, so nothing on the way can be a link, even if swapped later.
 * Fallback mode checks each folder by path (lstat), which leaves a small
 * window between the check and the removal.
 */
function locate(j: Journal, rootFd: number, rel: string): Located {
  const segs = rel.split("/");
  const name = segs.pop() as string;
  if (rootFd >= 0) {
    const close: number[] = [];
    let cur = rootFd;
    for (const seg of segs) {
      try {
        cur = openChildDir(cur, seg, false).fd;
        close.push(cur);
      } catch (err: any) {
        close.forEach((fd) => fs.closeSync(fd));
        if (err?.code === "ENOENT") return { kind: "gone" };
        if (err instanceof LinkInPath) return { kind: "problem", why: `a folder on its path (${seg}) was replaced by a link` };
        return { kind: "problem", why: `a folder on its path (${seg}) could not be opened (${err?.code ?? "error"})` };
      }
    }
    return { kind: "here", p: at(cur, name), close };
  }
  let cur = j.projectRoot;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { return { kind: "gone" }; }
    if (st.isSymbolicLink()) return { kind: "problem", why: `a folder on its path (${path.relative(j.projectRoot, cur)}) was replaced by a link` };
    if (!st.isDirectory()) return { kind: "problem", why: `a folder on its path (${path.relative(j.projectRoot, cur)}) is no longer a folder` };
  }
  return { kind: "here", p: path.join(cur, name), close: [] };
}

/**
 * Is this file exactly the one the build created, holding exactly what it
 * wrote? Checked through one opened descriptor (O_NOFOLLOW), so the identity
 * and the content come from the same file, not two lookups of a path.
 */
export function fileIsOurs(abs: string, e: JournalEntry): string | null {
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err: any) {
    return err?.code === "ELOOP" ? "it is now a link" : `it could not be opened (${err?.code ?? "error"})`;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return "no longer a regular file";
    if (st.dev !== e.dev || st.ino !== e.ino) return "replaced by something this build did not create";
    const content = fs.readFileSync(fd);
    const ours = sha256(content) === e.sha256 || (!e.written && content.length === 0);
    return ours ? null : "its content is not what this build wrote";
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Undo a build: newest first, and only items proven to be the build's own.
 * Content matching is one check among several, not a substitute for safe
 * identity. An item is removed only when all of these hold:
 *  - its recorded path is a plain relative path inside the project;
 *  - the project folder and every folder on the way are real folders, never
 *    links, reached one level at a time without following links;
 *  - it is not itself a link, and it is the same kind, device and inode;
 *  - for a file, it holds exactly the content this build wrote, checked
 *    through the same open descriptor as its identity;
 *  - for a folder, it is empty.
 *
 * Where /proc/self/fd works (Linux, Android/Termux), every check and the
 * removal itself happen inside folders held open, so a path swapped mid-way
 * can't redirect them. What remains: between checking a file and removing its
 * name, code running as the same user could swap that one name inside the
 * same project folder. Node has no unlinkat-by-descriptor to close that.
 * Elsewhere, folders are checked by path, with a slightly wider window.
 */
export function cleanup(j: Journal): CleanupResult {
  const removed: string[] = [];
  const kept: { rel: string; why: string }[] = [];
  const rootProblem = projectRootIntact(j);
  if (rootProblem) {
    for (const e of j.created) kept.push({ rel: e.rel || "(project folder)", why: rootProblem });
    return { removed, kept };
  }
  let rootFd = -1;
  if (anchoredAvailable()) {
    try { rootFd = fs.openSync(j.projectRoot, DIR_FLAGS); } catch { rootFd = -1; }
  }
  try {
    for (const e of [...j.created].reverse()) {
      const label = e.rel || "(project folder)";
      if (!validRel(e.rel) || (e.kind === "root") !== (e.rel === "")) {
        kept.push({ rel: label, why: "journal entry is not a plain path inside the project; ignored" });
        continue;
      }
      if (e.kind === "root") {
        let st: fs.Stats;
        try { st = fs.lstatSync(j.projectRoot); } catch { continue; }
        if (st.dev !== e.dev || st.ino !== e.ino) { kept.push({ rel: label, why: "replaced by something this build did not create" }); continue; }
        try { fs.rmdirSync(j.projectRoot); removed.push(label); }
        catch (err: any) { kept.push({ rel: label, why: err?.code === "ENOTEMPTY" || err?.code === "EEXIST" ? "contains files this build did not create" : `could not remove (${err?.code ?? "error"})` }); }
        continue;
      }
      const loc = locate(j, rootFd, e.rel);
      if (loc.kind === "gone") continue;
      if (loc.kind === "problem") { kept.push({ rel: label, why: loc.why }); continue; }
      try {
        let st: fs.Stats;
        try { st = fs.lstatSync(loc.p); } catch { continue; } // already gone
        if (st.isSymbolicLink()) { kept.push({ rel: label, why: "it is now a link" }); continue; }
        if (st.dev !== e.dev || st.ino !== e.ino) { kept.push({ rel: label, why: "replaced by something this build did not create" }); continue; }
        if (e.kind === "file") {
          const why = fileIsOurs(loc.p, e);
          if (why) { kept.push({ rel: label, why }); continue; }
          fs.unlinkSync(loc.p);
        } else {
          if (!st.isDirectory()) { kept.push({ rel: label, why: "no longer a real directory" }); continue; }
          fs.rmdirSync(loc.p); // fails unless empty: other people's files stay
        }
        removed.push(label);
      } catch (err: any) {
        kept.push({ rel: label, why: err?.code === "ENOTEMPTY" || err?.code === "EEXIST" ? "contains files this build did not create" : `could not remove (${err?.code ?? "error"})` });
      } finally {
        loc.close.forEach((fd) => fs.closeSync(fd));
      }
    }
  } finally {
    if (rootFd >= 0) fs.closeSync(rootFd);
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
