import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, sep } from "node:path";

/** An empty record with no prototype, so that a key such as `__proto__` is just a key. */
export function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * `items[index]` where the caller's loop or check keeps `index` in range.
 * Throws if it isn't, so a bug there blocks the call instead of passing
 * `undefined` on.
 */
export function itemAt<T>(items: readonly T[], index: number): T {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new Error(`internal error: index ${index} is outside a list of ${items.length}`);
  }
  // In range, so the element is there (and may itself be undefined, if T allows).
  return items[index] as T;
}

/**
 * Capture group `n` of `match`, for a group the pattern always fills when it
 * matches. Throws if it didn't, like itemAt().
 */
export function group(match: RegExpMatchArray, n: number): string {
  const value = match[n];
  if (value === undefined) {
    const input = match.input ?? "";
    throw new Error(`internal error: capture group ${n} is empty in a match of ${JSON.stringify(input.slice(0, 40))}`);
  }
  return value;
}

/** A JSON-style object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function truncateInline(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/** Make a path absolute without collapsing `link/..` before following the link. */
export function resolvePathForCwd(pathValue: string, cwd: string): string {
  return isAbsolute(pathValue)
    ? pathValue
    : `${isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`}${sep}${pathValue}`;
}

export function isPathWithin(pathValue: string, root: string): boolean {
  return relativePathWithin(pathValue, root) !== null;
}

/**
 * Canonical path of `pathValue` relative to `root` (symlinks resolved), or
 * null when it escapes `root` or resolution fails. The root itself is "".
 */
export function relativePathWithin(pathValue: string, root: string): string | null {
  const resolvedPath = resolveExistingPathForBoundary(pathValue, root);
  const resolvedRoot = resolveExistingPathForBoundary(root, root);
  if (resolvedPath === null || resolvedRoot === null) {
    return null;
  }
  if (resolvedPath === resolvedRoot) {
    return "";
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(prefix) ? resolvedPath.slice(prefix.length) : null;
}

/** Filesystem destination from `cwd`, or null when resolution cannot be established. */
export function canonicalPath(pathValue: string, cwd: string): string | null {
  return resolveExistingPathForBoundary(pathValue, cwd);
}

function resolveExistingPathForBoundary(pathValue: string, cwd: string): string | null {
  const absolute = resolvePathForCwd(pathValue, cwd);
  const root = parse(absolute).root;
  const separator = sep === "/" ? /\/+/ : /[\\/]+/;
  const pending = absolute.slice(root.length).split(separator).filter(Boolean).reverse();
  if (absolute.endsWith(sep)) {
    pending.unshift(".");
  }
  let current = root;
  let links = 0;
  let steps = 0;
  while (pending.length) {
    if (++steps > 4096) {
      return null;
    }
    const component = itemAt(pending, pending.length - 1);
    pending.pop();
    if (component === ".") {
      continue;
    }
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = current.endsWith(sep) ? `${current}${component}` : `${current}${sep}${component}`;
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        if (++links > 40) {
          return null;
        }
        const target = readlinkSync(candidate);
        const targetRoot = parse(target).root;
        if (isAbsolute(target)) {
          current = targetRoot;
        }
        if (target.endsWith(sep)) {
          pending.push(".");
        }
        pending.push(...target.slice(targetRoot.length).split(separator).filter(Boolean).reverse());
        continue;
      }
      if (pending.length && !stats.isDirectory()) {
        return null;
      }
    } catch (error) {
      // Missing destinations (and their parents) are valid for writes. Other
      // failures, including loops, permissions and non-directories, are unknown.
      if (!isRecord(error) || error.code !== "ENOENT") {
        return null;
      }
    }
    current = candidate;
  }
  return current;
}

/** Directories reads may target without review: the workspace plus `readRoots`. */
export interface ReadRoots {
  cwd: string;
  extra: string[];
}

/** Absolute `readRoots` entries, with `~/` expanded. Relative entries are ignored. */
export function resolveReadRoots(cwd: string, readRoots: string[]): ReadRoots {
  const extra = readRoots
    .map((root) => root.trim())
    .map((root) => (root === "~" || root.startsWith("~/") ? `${homedir()}${root.slice(1)}` : root))
    .filter((root) => isAbsolute(root));
  return { cwd, extra };
}
