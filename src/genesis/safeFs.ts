import fs from "fs";
import path from "path";

/**
 * Folder-anchored file operations, so a path swapped mid-operation can't
 * redirect a write or a delete.
 *
 * Node has no openat()/unlinkat(). On Linux and Android, /proc/self/fd/<n>
 * is a link to the exact folder descriptor <n> was opened on, even if that
 * folder's path is renamed or replaced afterwards. Walking down one folder at
 * a time with O_NOFOLLOW, and then creating, opening or removing names through
 * /proc/self/fd/<folder>/<name>, gives the same guarantee as openat(): the
 * operation happens inside the folder that was checked, and no link is ever
 * followed on the way.
 *
 * Where /proc isn't available, callers fall back to path checks, which leave
 * a small window between check and use. That limit is documented where it
 * applies.
 */

const C = fs.constants;
const NOFOLLOW = C.O_NOFOLLOW ?? 0;
const DIRECTORY = (C as any).O_DIRECTORY ?? 0;
export const DIR_FLAGS = C.O_RDONLY | DIRECTORY | NOFOLLOW;

let procOk: boolean | null = null;

/** Whether folder-anchored operations through /proc/self/fd work here. */
export function anchoredAvailable(): boolean {
  if (procOk !== null) return procOk;
  procOk = false;
  if (!DIRECTORY || !NOFOLLOW) return procOk;
  let fd = -1;
  try {
    fd = fs.openSync(path.resolve("."), DIR_FLAGS);
    procOk = fs.statSync(at(fd, ".")).isDirectory();
  } catch {
    procOk = false;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
  return procOk;
}

/** A path that names `name` inside the folder open as `dirFd`. */
export function at(dirFd: number, name: string): string {
  return `/proc/self/fd/${dirFd}/${name}`;
}

export class LinkInPath extends Error {
  code = "UNSAFE_PATH";
}

/**
 * Open the child folder `name` of `dirFd`, refusing links and non-folders.
 * With `create`, makes it first if it doesn't exist and reports that.
 */
export function openChildDir(dirFd: number, name: string, create: boolean): { fd: number; created: boolean } {
  let created = false;
  if (create) {
    try {
      fs.mkdirSync(at(dirFd, name), { mode: 0o755 });
      created = true;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  try {
    return { fd: fs.openSync(at(dirFd, name), DIR_FLAGS), created };
  } catch (err: any) {
    if (err?.code === "ELOOP" || err?.code === "ENOTDIR") {
      throw new LinkInPath(`"${name}" is a link or not a folder`);
    }
    throw err;
  }
}
