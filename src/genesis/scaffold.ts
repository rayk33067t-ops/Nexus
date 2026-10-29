import fs from "fs";
import path from "path";
import { coreGuard } from "./guards/coreGuard";
import { digestOf } from "./authority/canonical";
import { reportHostile } from "./authority/KeyAuthority";
import { AgentSigner } from "./authority/credentials";
import {
  CleanupResult,
  Journal,
  appendHistory,
  cleanup,
  dropJournal,
  filesIn,
  markWritten,
  readJournal,
  recordCreated,
  saveJournal,
  startJournal,
} from "./buildJournal";

/**
 * ScaffoldEngine — writes a generated project under one authorized root.
 *
 * Safety properties:
 *  - Every build is first copied into a private, frozen snapshot. The guard
 *    is asked about the snapshot, and only the snapshot is written; the
 *    caller's structure object is never read again after the copy.
 *  - Every build must pass coreGuard with action "fs.write" and the digest
 *    of its snapshot (plus the resolved output root), so a founder approval
 *    covers exactly that plan in exactly that place. The request is signed
 *    with the engine's agent credential; Key Authority works out who is
 *    asking from that signature, not from a name.
 *  - A plan with a traversal, absolute or otherwise unsafe path is reported
 *    to Key Authority as hostile, which puts NEXUS into lockdown.
 *  - A guard allow is not trusted on its own: writeProjectConfined still
 *    performs every filesystem check below at the moment of use.
 *  - The whole structure is validated before anything touches the disk.
 *  - Project names are a single plain path segment; file paths are relative,
 *    use "/" separators, and may not contain "..", ".", empty segments,
 *    backslashes, or NUL bytes.
 *  - A project directory must not already exist, so nothing is overwritten.
 *  - Every build keeps a journal of what it creates (see ./buildJournal). A
 *    build that fails is undone, removing only its own files; a build that
 *    was interrupted is undone before the next attempt. Unrelated files are
 *    never removed, and every outcome is recorded.
 *  - Directories are created one segment at a time; an existing segment that
 *    is a symlink or not a directory stops the build.
 *  - Files are opened with O_CREAT | O_EXCL | O_NOFOLLOW, so an existing file
 *    or a symlink planted at the target is refused instead of followed.
 *  - Where /proc is available (Linux, Android/Termux), the opened descriptor's
 *    real path is checked against the project root before any content is
 *    written.
 *
 * Known limit: Node has no openat(), so an attacker with write access inside
 * the output root could still swap a directory for a symlink between the
 * directory check and the open. The /proc check then refuses to write
 * content, but the empty file it created outside the root remains. Keep the
 * output root writable only by NEXUS.
 */

export const LIMITS = Object.freeze({
  maxFiles: 1000,
  maxFileBytes: 5 * 1024 * 1024,
  maxPathLength: 1024,
  maxSegmentLength: 255,
});

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ScaffoldError extends Error {
  code: string;
  /** Set on APPROVAL_REQUIRED: the id the founder approves. */
  requestId: string | null;
  constructor(code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "ScaffoldError";
    this.code = code;
    this.requestId = requestId;
  }
}

const HOSTILE_CODES = new Set(["INVALID_PATH", "INVALID_PROJECT_NAME", "UNSAFE_PATH"]);

export interface ScaffoldFile {
  path: string;
  content: string;
}

interface PlannedFile {
  readonly rel: string;
  readonly segments: readonly string[];
  readonly content: string;
}

/** A validated, deep-frozen copy of a build request. */
export interface ProjectSnapshot {
  readonly project: string;
  readonly files: readonly PlannedFile[];
}

export function validateProjectName(name: unknown): string {
  if (typeof name !== "string" || !PROJECT_NAME.test(name) || /^\.+$/.test(name)) {
    throw new ScaffoldError(
      "INVALID_PROJECT_NAME",
      "Project name must be 1-128 characters of letters, digits, '.', '_' or '-', starting with a letter or digit."
    );
  }
  return name;
}

export function validateRelativePath(rel: unknown): string[] {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new ScaffoldError("INVALID_PATH", "File path must be a non-empty string.");
  }
  if (rel.length > LIMITS.maxPathLength) {
    throw new ScaffoldError("INVALID_PATH", `File path is longer than ${LIMITS.maxPathLength} characters: ${rel.slice(0, 60)}…`);
  }
  if (rel.includes("\0")) {
    throw new ScaffoldError("INVALID_PATH", "File path contains a NUL byte.");
  }
  if (rel.includes("\\")) {
    throw new ScaffoldError("INVALID_PATH", `File path must use "/" separators: ${rel}`);
  }
  if (rel.startsWith("/") || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new ScaffoldError("INVALID_PATH", `File path must be relative: ${rel}`);
  }
  const segments = rel.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ScaffoldError("INVALID_PATH", `File path has an empty, "." or ".." segment: ${rel}`);
    }
    if (seg.length > LIMITS.maxSegmentLength) {
      throw new ScaffoldError("INVALID_PATH", `File path segment is too long: ${rel}`);
    }
  }
  return segments;
}

function planStructure(structure: unknown): PlannedFile[] {
  const files = (structure as { files?: unknown })?.files;
  if (!Array.isArray(files)) {
    throw new ScaffoldError("INVALID_STRUCTURE", "Invalid structure: missing files array.");
  }
  if (files.length > LIMITS.maxFiles) {
    throw new ScaffoldError("INVALID_STRUCTURE", `Too many files: ${files.length} (limit ${LIMITS.maxFiles}).`);
  }

  const planned: PlannedFile[] = [];
  const filePaths = new Set<string>();
  const dirPaths = new Set<string>();

  for (const entry of files) {
    if (!entry || typeof entry !== "object") {
      throw new ScaffoldError("INVALID_STRUCTURE", "Each file entry must be an object with path and content.");
    }
    const { path: rel, content } = entry as { path?: unknown; content?: unknown };
    const segments = validateRelativePath(rel);
    if (typeof content !== "string") {
      throw new ScaffoldError("INVALID_CONTENT", `Content for ${rel} must be a string.`);
    }
    if (Buffer.byteLength(content, "utf-8") > LIMITS.maxFileBytes) {
      throw new ScaffoldError("INVALID_CONTENT", `Content for ${rel} exceeds ${LIMITS.maxFileBytes} bytes.`);
    }

    const key = segments.join("/");
    if (filePaths.has(key)) {
      throw new ScaffoldError("DUPLICATE_PATH", `Duplicate file path: ${key}`);
    }
    if (dirPaths.has(key)) {
      throw new ScaffoldError("PATH_CONFLICT", `${key} is used as both a file and a directory.`);
    }
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      if (filePaths.has(dir)) {
        throw new ScaffoldError("PATH_CONFLICT", `${dir} is used as both a file and a directory.`);
      }
      dirPaths.add(dir);
    }
    filePaths.add(key);
    planned.push(Object.freeze({ rel: key, segments: Object.freeze(segments.slice()), content }));
  }
  return planned;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Create each directory segment, refusing symlinks and non-directories. Exported for tests. */
export function ensureDirectories(projectRoot: string, dirSegments: string[], onCreate?: (rel: string) => void): string {
  let current = projectRoot;
  for (const seg of dirSegments) {
    current = path.join(current, seg);
    try {
      fs.mkdirSync(current, { mode: 0o755 });
      onCreate?.(path.relative(projectRoot, current).split(path.sep).join("/"));
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new ScaffoldError("UNSAFE_PATH", `Refusing to build through ${current}: not a real directory.`);
      }
    }
  }
  return current;
}

function descriptorPath(fd: number): string | null {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null; // /proc unavailable on this platform
  }
}

/** Validate a build request and copy it into a private, frozen snapshot. */
export function snapshotProject(projectName: unknown, structure: unknown): ProjectSnapshot {
  const project = validateProjectName(projectName);
  const files = planStructure(structure);
  return Object.freeze({ project, files: Object.freeze(files) });
}

export interface WriteOptions {
  /** Digest of the approved plan, kept in the build journal. */
  digest?: string;
  /** Test hook: called before each file is written. Throwing makes that file fail. */
  beforeFile?: (index: number, rel: string) => void;
}

export interface ScaffoldResult {
  project: string;
  path: string;
  filesCreated: number;
  files: string[];
  /** Set when an earlier interrupted attempt was cleaned up first. */
  recoveredFrom?: string;
}

function describeCleanup(c: CleanupResult): string {
  const kept = c.kept.length ? `; kept ${c.kept.length}: ${c.kept.slice(0, 3).map((k) => `${k.rel} (${k.why})`).join(", ")}` : "";
  return `removed ${c.removed.length} item(s) this build created${kept}`;
}

/**
 * Before a new attempt, undo an earlier attempt that never finished. Returns
 * the earlier attempt's id, or throws PROJECT_EXISTS when its leftovers can't
 * all be safely removed.
 */
function recoverInterrupted(projectRoot: string, name: string): string | undefined {
  const old = readJournal(projectRoot);
  if (!old) return undefined;
  const result = cleanup(old);
  if (result.kept.length) {
    old.status = "needs-attention";
    saveJournal(old);
    appendHistory({ at: new Date().toISOString(), attemptId: old.attemptId, project: name, projectRoot, outcome: "recovery-incomplete", filesWritten: filesIn(old), cleanup: result });
    throw new ScaffoldError(
      "PROJECT_EXISTS",
      `An earlier build of ${name} did not finish, and its folder now holds things that build did not create, so nothing was removed or overwritten: ${describeCleanup(result)}.`
    );
  }
  appendHistory({ at: new Date().toISOString(), attemptId: old.attemptId, project: name, projectRoot, outcome: "interrupted", filesWritten: filesIn(old), cleanup: result, error: "the build stopped before finishing (process interrupted)" });
  dropJournal(projectRoot);
  return old.attemptId;
}

/**
 * Write a snapshot under basePath with every confinement check applied.
 * This function does not authorize anything: callers must have a coreGuard
 * allow first. In this codebase only ScaffoldEngine calls it (and the tests).
 * Module exports are not a security boundary against code already running
 * in this process; the guard governs the Genesis path, not hostile code.
 */
export function writeProjectConfined(basePath: string, snap: ProjectSnapshot, opts: WriteOptions = {}): ScaffoldResult {
  const name = snap.project;
  const plan = snap.files;

  fs.mkdirSync(basePath, { recursive: true });
  const root = fs.realpathSync(basePath);
  const projectRoot = path.join(root, name);

  const recoveredFrom = recoverInterrupted(projectRoot, name);

  // A project folder this build didn't make is never touched.
  if (fs.existsSync(projectRoot) || isSymlink(projectRoot)) {
    throw new ScaffoldError("PROJECT_EXISTS", `Project already exists: ${name}`);
  }

  const journal: Journal = startJournal(name, projectRoot, opts.digest ?? null);
  const written: string[] = [];
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);

  try {
    try {
      fs.mkdirSync(projectRoot, { mode: 0o755 });
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        throw new ScaffoldError("PROJECT_EXISTS", `Project already exists: ${name}`);
      }
      throw err;
    }
    recordCreated(journal, "root", "");

    for (const [index, file] of plan.entries()) {
      const dir = ensureDirectories(projectRoot, file.segments.slice(0, -1) as string[], (rel) => recordCreated(journal, "dir", rel));
      const target = path.join(dir, file.segments[file.segments.length - 1]);
      if (!isInside(projectRoot, target)) {
        throw new ScaffoldError("UNSAFE_PATH", `Resolved path leaves the project: ${file.rel}`);
      }
      opts.beforeFile?.(index, file.rel);

      let fd: number;
      try {
        fd = fs.openSync(target, flags, 0o644);
      } catch (err: any) {
        if (err?.code === "EEXIST" || err?.code === "ELOOP") {
          throw new ScaffoldError("UNSAFE_PATH", `Refusing to write ${file.rel}: target already exists or is a symlink.`);
        }
        throw err;
      }

      try {
        recordCreated(journal, "file", file.rel, file.content);
        if (!fs.fstatSync(fd).isFile()) {
          throw new ScaffoldError("UNSAFE_PATH", `Refusing to write ${file.rel}: not a regular file.`);
        }
        const real = descriptorPath(fd);
        if (real !== null && !isInside(projectRoot, real)) {
          throw new ScaffoldError("UNSAFE_PATH", `Refusing to write ${file.rel}: opened file is outside the project (${real}).`);
        }
        fs.writeSync(fd, file.content, null, "utf-8");
      } finally {
        fs.closeSync(fd);
      }
      markWritten(journal, file.rel);
      written.push(file.rel);
    }
  } catch (err: any) {
    // Undo this attempt: only what the journal proves this build created.
    const created = journal.created.length > 0;
    const result = created ? cleanup(journal) : { removed: [], kept: [] };
    if (result.kept.length) {
      journal.status = "needs-attention";
      saveJournal(journal);
    } else {
      dropJournal(projectRoot);
    }
    appendHistory({
      at: new Date().toISOString(), attemptId: journal.attemptId, project: name, projectRoot,
      outcome: "failed", filesWritten: written.length, cleanup: result,
      error: String(err?.code ?? err?.name ?? "error") + ": " + String(err?.message ?? err).slice(0, 300),
    });
    if (err instanceof Error) {
      err.message += ` (${written.length} of ${plan.length} files were written before stopping; ${created ? describeCleanup(result) : "nothing had been created"})`;
    }
    throw err;
  }

  dropJournal(projectRoot);
  appendHistory({ at: new Date().toISOString(), attemptId: journal.attemptId, project: name, projectRoot, outcome: "completed", filesWritten: written.length });
  return { project: name, path: projectRoot, filesCreated: written.length, files: written, ...(recoveredFrom ? { recoveredFrom } : {}) };
}

function isSymlink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Human-readable description of a snapshot, shown to the founder. */
export function describeSnapshot(snap: ProjectSnapshot): string {
  const lines = snap.files.map((f) => `- ${f.rel} (${Buffer.byteLength(f.content, "utf-8")} bytes)`);
  return `Create project "${snap.project}" with ${snap.files.length} file(s):\n${lines.join("\n")}`;
}

export class ScaffoldEngine {
  readonly basePath: string;
  readonly #signer: AgentSigner | null;

  /**
   * The signer is the agent's credential (authority/credentials:
   * loadAgentSigner). Without one the engine can't ask for anything, so every
   * build is refused.
   */
  constructor(basePath: string = "output/projects", signer: AgentSigner | null = null) {
    this.basePath = basePath;
    this.#signer = signer;
    Object.freeze(this);
  }

  /**
   * The agent proposes a build; coreGuard asks Key Authority, which checks
   * the signature. Throws GUARD_DENIED when refused, or APPROVAL_REQUIRED
   * (with requestId) when the founder must approve this exact plan first.
   */
  createProject(projectName: string, structure: unknown): ScaffoldResult {
    let snap: ProjectSnapshot;
    try {
      snap = snapshotProject(projectName, structure);
    } catch (err) {
      this.reportIfHostile(err, `project:${String(projectName).slice(0, 128)}`);
      throw err;
    }
    const signer = this.#signer;
    if (!signer) {
      throw new ScaffoldError("GUARD_DENIED", `Build of ${snap.project} was not authorized: this engine has no agent credential.`);
    }

    const root = path.resolve(this.basePath);
    const target = `project:${snap.project}`;
    const digest = digestOf({ root, project: snap.project, files: snap.files.map((f) => ({ path: f.rel, content: f.content })) });
    const decision = coreGuard(signer.sign({
      action: "fs.write",
      target,
      digest,
      summary: `${describeSnapshot(snap)}\nInto: ${root}`,
    }));

    if (decision.pending) {
      throw new ScaffoldError(
        "APPROVAL_REQUIRED",
        `Build of ${snap.project} needs founder approval (request ${decision.requestId}): ${decision.reason}.`,
        decision.requestId
      );
    }
    if (!decision.allowed) {
      throw new ScaffoldError("GUARD_DENIED", `Build of ${snap.project} was not authorized: ${decision.reason}.`);
    }

    try {
      return writeProjectConfined(this.basePath, snap, { digest });
    } catch (err) {
      this.reportIfHostile(err, target);
      throw err;
    }
  }

  /** A hostile plan is reported signed, so it can be pinned on this agent. */
  private reportIfHostile(err: unknown, target: string): void {
    if (!(err instanceof ScaffoldError) || !HOSTILE_CODES.has(err.code)) return;
    const reason = `${err.code}: ${err.message}`;
    let signed: unknown = null;
    try {
      signed = this.#signer?.sign({ action: "fs.write", target, digest: digestOf({ rejected: target, code: err.code }) }) ?? null;
    } catch { /* report unsigned */ }
    reportHostile(signed, reason);
  }
}
