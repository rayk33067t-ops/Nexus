import fs from "fs";
import path from "path";
import { coreGuard } from "./guards/coreGuard";

/**
 * ScaffoldEngine — writes a generated project under one authorized root.
 *
 * Safety properties:
 *  - Every build is first copied into a private, frozen snapshot. The guard
 *    is asked about the snapshot, and only the snapshot is written; the
 *    caller's structure object is never read again after the copy.
 *  - Every build must pass coreGuard with action "fs.write". Key Authority
 *    does not exist yet, so createProject currently always refuses.
 *  - A guard allow is not trusted on its own: writeProjectConfined still
 *    performs every filesystem check below at the moment of use.
 *  - The whole structure is validated before anything touches the disk.
 *  - Project names are a single plain path segment; file paths are relative,
 *    use "/" separators, and may not contain "..", ".", empty segments,
 *    backslashes, or NUL bytes.
 *  - A project directory must not already exist, so nothing is overwritten.
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
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScaffoldError";
    this.code = code;
  }
}

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ScaffoldResult {
  project: string;
  path: string;
  filesCreated: number;
  files: string[];
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
export function ensureDirectories(projectRoot: string, dirSegments: string[]): string {
  let current = projectRoot;
  for (const seg of dirSegments) {
    current = path.join(current, seg);
    try {
      fs.mkdirSync(current, { mode: 0o755 });
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

/**
 * Write a snapshot under basePath with every confinement check applied.
 * This function does not authorize anything: callers must have a coreGuard
 * allow first. In this codebase only ScaffoldEngine calls it (and the tests).
 * Module exports are not a security boundary against code already running
 * in this process; the guard governs the Genesis path, not hostile code.
 */
export function writeProjectConfined(basePath: string, snap: ProjectSnapshot): ScaffoldResult {
  const name = snap.project;
  const plan = snap.files;

  fs.mkdirSync(basePath, { recursive: true });
  const root = fs.realpathSync(basePath);
  const projectRoot = path.join(root, name);

  try {
    fs.mkdirSync(projectRoot, { mode: 0o755 });
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      throw new ScaffoldError("PROJECT_EXISTS", `Project already exists: ${name}`);
    }
    throw err;
  }

  const written: string[] = [];
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);

  try {
    for (const file of plan) {
      const dir = ensureDirectories(projectRoot, file.segments.slice(0, -1));
      const target = path.join(dir, file.segments[file.segments.length - 1]);
      if (!isInside(projectRoot, target)) {
        throw new ScaffoldError("UNSAFE_PATH", `Resolved path leaves the project: ${file.rel}`);
      }

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
      written.push(file.rel);
    }
  } catch (err: any) {
    if (err instanceof ScaffoldError) {
      err.message += ` (${written.length} of ${plan.length} files were written before stopping)`;
    }
    throw err;
  }

  return { project: name, path: projectRoot, filesCreated: written.length, files: written };
}

export class ScaffoldEngine {
  readonly basePath: string;

  constructor(basePath: string = "output/projects") {
    this.basePath = basePath;
    Object.freeze(this);
  }

  /**
   * Genesis proposes a build; coreGuard decides. With no Key Authority yet,
   * this always throws GUARD_DENIED and writes nothing.
   */
  createProject(projectName: string, structure: unknown, actor: string = "genesis"): ScaffoldResult {
    const snap = snapshotProject(projectName, structure);
    const decision = coreGuard({ actor, action: "fs.write", target: `project:${snap.project}` });
    if (!decision.allowed) {
      throw new ScaffoldError("GUARD_DENIED", `Build of ${snap.project} was not authorized: ${decision.reason}.`);
    }
    return writeProjectConfined(this.basePath, snap);
  }
}
