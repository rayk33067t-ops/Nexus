import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Code integrity: a fingerprint of every file NEXUS runs from, compared with
 * the known-good fingerprint the founder pinned. Covers tracked files and
 * untracked ones (such as config/key-authority.json), but not generated
 * output, dependencies or Key Authority's own runtime state.
 */

const EXCLUDED = [/^output\//, /^node_modules\//, /^\.nexus\//, /^dist\//, /^build\//];

export interface Manifest {
  commit: string;
  files: Record<string, string>;
}

export interface IntegrityDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

export function manifest(root: string): Manifest {
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter((p) => p && !EXCLUDED.some((re) => re.test(p)));
  const files: Record<string, string> = {};
  for (const rel of [...new Set(listed)].sort()) {
    try {
      files[rel] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
    } catch {
      files[rel] = "missing";
    }
  }
  return { commit, files };
}

export function compareManifests(base: Manifest, cur: Manifest): IntegrityDiff {
  const changed: string[] = [], added: string[] = [], removed: string[] = [];
  for (const [p, h] of Object.entries(cur.files)) {
    if (!(p in base.files)) added.push(p);
    else if (base.files[p] !== h) changed.push(p);
  }
  for (const p of Object.keys(base.files)) if (!(p in cur.files)) removed.push(p);
  return { changed, added, removed };
}

export function describeDiff(d: IntegrityDiff): string {
  const parts: string[] = [];
  if (d.changed.length) parts.push(`changed: ${d.changed.slice(0, 5).join(", ")}${d.changed.length > 5 ? "…" : ""}`);
  if (d.added.length) parts.push(`added: ${d.added.slice(0, 5).join(", ")}${d.added.length > 5 ? "…" : ""}`);
  if (d.removed.length) parts.push(`removed: ${d.removed.slice(0, 5).join(", ")}${d.removed.length > 5 ? "…" : ""}`);
  return parts.join("; ");
}

export function isClean(d: IntegrityDiff): boolean {
  return !d.changed.length && !d.added.length && !d.removed.length;
}
