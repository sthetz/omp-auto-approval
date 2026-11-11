import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/** An empty record with no prototype, so that a key such as `__proto__` is just a key. */
export function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
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

export function resolvePathForCwd(pathValue: string, cwd: string): string {
  return normalize(isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue));
}

export function isPathWithin(pathValue: string, root: string): boolean {
  return relativePathWithin(pathValue, root) !== null;
}

/**
 * Canonical path of `pathValue` relative to `root` (symlinks resolved), or
 * null when it escapes `root`. The root itself is "".
 */
export function relativePathWithin(pathValue: string, root: string): string | null {
  const resolvedPath = resolveExistingPathForBoundary(pathValue, root);
  const resolvedRoot = resolveExistingPathForBoundary(root, root);
  if (resolvedPath === resolvedRoot) {
    return "";
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(prefix) ? resolvedPath.slice(prefix.length) : null;
}

/** `pathValue` from `cwd`, with symbolic links in its existing part resolved. */
export function canonicalPath(pathValue: string, cwd: string): string {
  return resolveExistingPathForBoundary(pathValue, cwd);
}

function resolveExistingPathForBoundary(pathValue: string, cwd: string): string {
  const resolvedPath = resolvePathForCwd(pathValue, cwd);
  if (existsSync(resolvedPath)) {
    return normalize(realpathSync(resolvedPath));
  }

  let current = resolvedPath;
  const tail: string[] = [];
  while (true) {
    if (existsSync(current)) {
      return normalize(resolve(realpathSync(current), ...tail.reverse()));
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolvedPath;
    }
    tail.push(current.slice(parent.length).replace(/^[/\\]/, ""));
    current = parent;
  }
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
    .map((root) => (root === "~" || root.startsWith("~/") ? join(homedir(), root.slice(1)) : root))
    .filter((root) => isAbsolute(root));
  return { cwd, extra };
}
