import { lstatSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPath, isRecord, itemAt, relativePathWithin } from "./common.js";
import { isSensitivePath } from "./sensitive-paths.js";
import type { ShellWord } from "./shell-syntax.js";

const LIST_FLAGS = new Set([
  "--json",
  "--all",
  "-a",
  "--long",
  "-l",
  "--parseable",
  "-p",
  "--link",
  "--unicode",
  "--no-unicode",
]);

/** The literal dependency filters of an exact supported ls/list/explain call. */
export function npmDependencyFilters(args: readonly ShellWord[]): ShellWord[] | null {
  const listing = args[0]?.text === "ls" || args[0]?.text === "list";
  if ((!listing && args[0]?.text !== "explain") || args.some((word) => word.expands)) {
    return null;
  }
  const filters: ShellWord[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const word = itemAt(args, index);
    const text = word.text;
    if (text === "--json" || (listing && LIST_FLAGS.has(text))) {
      continue;
    }
    if (listing && /^(--depth|--omit|--include)(=|$)/.test(text)) {
      const equal = text.indexOf("=");
      const option = equal < 0 ? text : text.slice(0, equal);
      const value = equal < 0 ? args[++index]?.text : text.slice(equal + 1);
      if (value === undefined || !(option === "--depth" ? /^\d+$/.test(value) : /^(dev|optional|peer)$/.test(value))) {
        return null;
      }
      continue;
    }
    if (!text || text.startsWith("-")) {
      return null;
    }
    filters.push(word);
  }
  return listing || filters.length > 0 ? filters : null;
}

/**
 * A superset of Arborist's actual-tree reads, including hidden-lock links and
 * ancestor node_modules used to resolve dependencies of local linked packages.
 * Package code and ordinary package files are never opened by this walk.
 */
export function npmDependencyTreeIsSafe(project: string, workspace: string): boolean {
  let entriesLeft = 20_000;
  let bytesLeft = 32 * 1024 * 1024;
  const seen = new Set<string>();
  const pending: { path: string; kind: "package" | "modules" | "scope" | "bin" }[] = [
    { path: project, kind: "package" },
  ];
  const reject = (): never => {
    throw new Error("npm dependency reads require review");
  };
  const safePath = (path: string): string => {
    const inside = relativePathWithin(path, workspace);
    const real = canonicalPath(path, workspace);
    if (inside === null || isSensitivePath(inside) || real === null) {
      return reject();
    }
    return real;
  };
  const stat = (path: string): Stats | null => {
    safePath(path);
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    // A dangling symlink, unreadable entry or special file is not an absent file.
    return statSync(path);
  };
  const metadata = (path: string, json: boolean): Record<string, unknown> | null => {
    const file = stat(path);
    if (file === null) {
      return null;
    }
    bytesLeft -= file.size;
    if (!file.isFile() || file.size > 16 * 1024 * 1024 || bytesLeft < 0) {
      return reject();
    }
    if (!json) {
      return null;
    }
    const data: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return isRecord(data) ? data : reject();
  };
  try {
    for (const name of ["npm-shrinkwrap.json", "package-lock.json", "yarn.lock"]) {
      metadata(join(project, name), false);
    }
    const hidden = metadata(join(project, "node_modules", ".package-lock.json"), true);
    if (hidden?.packages !== undefined) {
      if (!isRecord(hidden.packages)) {
        return false;
      }
      for (const [location, meta] of Object.entries(hidden.packages)) {
        if (--entriesLeft < 0 || !isRecord(meta)) {
          return false;
        }
        safePath(resolve(project, location));
        if (meta.link) {
          if (typeof meta.resolved !== "string") {
            return false;
          }
          const target = resolve(project, meta.resolved);
          safePath(target);
          pending.push({ path: target, kind: "package" });
        }
      }
    }
    for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
      if (--entriesLeft < 0) {
        return false;
      }
      const real = safePath(task.path);
      const key = `${task.kind}:${real}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const directory = stat(task.path);
      if (directory === null || !directory.isDirectory()) {
        continue;
      }
      if (task.kind === "package") {
        const pkg = metadata(join(real, "package.json"), true);
        // Arborist expands the root's declarations even with --workspaces=false.
        if (real === project && pkg?.workspaces) {
          return false;
        }
        if (!pkg?.bin && isRecord(pkg?.directories) && typeof pkg.directories.bin === "string") {
          // Match read-package-json-fast's clamped, package-relative bin path.
          pending.push({ path: join(real, join(".", join("/", pkg.directories.bin))), kind: "bin" });
        }
        pending.push({ path: join(real, "node_modules"), kind: "modules" });
        let boundary = project;
        while (relativePathWithin(real, boundary) === null) {
          boundary = dirname(boundary);
        }
        for (let parent = dirname(real); relativePathWithin(parent, boundary) !== null; parent = dirname(parent)) {
          pending.push({ path: join(parent, "node_modules"), kind: "modules" });
          if (parent === boundary) {
            break;
          }
        }
        continue;
      }
      const entries = readdirSync(real, { withFileTypes: true });
      entriesLeft -= entries.length;
      if (entriesLeft < 0) {
        return false;
      }
      for (const entry of entries) {
        const path = join(real, entry.name);
        if (task.kind === "bin") {
          // The metadata reader skips dot entries and never follows child links.
          if (!entry.name.startsWith(".") && entry.isDirectory()) {
            pending.push({ path, kind: "bin" });
          }
          continue;
        }
        // Actual loading skips hidden entries, but hidden-lock validation follows
        // symlinks even there. It can also follow directory links named .bin.
        if (entry.name.startsWith(".") && !entry.isSymbolicLink()) {
          continue;
        }
        const target = safePath(path);
        if (entry.isSymbolicLink()) {
          const linked = stat(path);
          if (linked?.isDirectory() && (basename(target) === "node_modules" || basename(target).startsWith("@"))) {
            pending.push({ path: target, kind: basename(target) === "node_modules" ? "modules" : "scope" });
          }
        }
        pending.push({ path, kind: task.kind === "modules" && entry.name.startsWith("@") ? "scope" : "package" });
      }
    }
    return true;
  } catch {
    return false;
  }
}
