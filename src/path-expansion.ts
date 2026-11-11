import { readdirSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isSensitivePath } from "./sensitive-paths.js";

/**
 * What a shell glob or a recursive read could reach, worked out without
 * trusting the shell's options. OMP's shell is persistent, so an earlier call
 * may have set `dotglob`, `nocaseglob`, `nullglob` or `GLOBIGNORE`; every
 * answer here holds whatever they are.
 */

// Entries a glob or walk may read before it gives up and the command is reviewed.
const MAX_GLOB_ENTRIES = 5000;
const MAX_WALK_ENTRIES = 20000;

export interface GlobMatch {
  // The path the match names, absolute.
  absolute: string;
  // The word bash passes to the program.
  word: string;
}

function segmentPattern(segment: string): RegExp | null {
  if (!/[*?[]/.test(segment)) {
    return null;
  }
  // A bracket expression could be any character class; matching everything
  // is the safe reading.
  if (segment.includes("[")) {
    return /^.*$/s;
  }
  const body = [...segment]
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")))
    .join("");
  // Case-insensitive and matching leading dots, in case of nocaseglob and dotglob.
  return new RegExp(`^${body}$`, "is");
}

/**
 * Every match bash could expand `pattern` to, a superset whatever the glob
 * options, or null when that cannot be bounded: brace expansion, `**`
 * (globstar), or too many directory entries. `.` and `..` count as possible
 * matches, since globskipdots can be turned off. `base` is where a relative
 * pattern starts; `home` replaces a leading `~`.
 */
export function globMatches(pattern: string, base: string, home?: string): GlobMatch[] | null {
  if (pattern.includes("{") || pattern.includes("**")) {
    return null;
  }
  let root: string;
  let written: string;
  let rest: string;
  if (home !== undefined) {
    root = home;
    written = "~";
    rest = pattern.slice(1);
  } else if (isAbsolute(pattern)) {
    root = "/";
    written = "";
    rest = pattern;
  } else {
    root = base;
    written = "";
    rest = pattern;
  }
  let matches: GlobMatch[] = [{ absolute: root, word: written }];
  let budget = MAX_GLOB_ENTRIES;
  const segments = rest.split("/");
  segments.forEach((segment, index) => {
    const separator = index === 0 ? "" : "/";
    const regex = segmentPattern(segment);
    const next: GlobMatch[] = [];
    for (const match of matches) {
      if (!regex) {
        next.push({ absolute: join(match.absolute, segment), word: `${match.word}${separator}${segment}` });
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(match.absolute);
      } catch {
        continue;
      }
      budget -= names.length;
      if (budget < 0) {
        throw new TooMany();
      }
      for (const name of [".", "..", ...names]) {
        if (regex.test(name)) {
          next.push({ absolute: join(match.absolute, name), word: `${match.word}${separator}${name}` });
        }
      }
    }
    matches = next;
  });
  return matches;
}

class TooMany extends Error {}

/** globMatches, with null in place of an overflow. */
export function boundedGlobMatches(pattern: string, base: string, home?: string): GlobMatch[] | null {
  try {
    return globMatches(pattern, base, home);
  } catch (error) {
    if (error instanceof TooMany) {
      return null;
    }
    throw error;
  }
}

/** Which files a recursive grep reads, as far as it can be told for sure. */
export interface FileFilter {
  // --include patterns; a file whose name matches none is skipped only when
  // the first file filter given was an --include.
  include: string[];
  includeFirst: boolean;
  // --exclude-dir patterns simple enough to know a directory surely matches.
  excludeDirectories: string[];
}

// A file name glob as grep or ugrep may read it (fnmatch or gitignore style),
// matched generously: anything unusual matches every name.
function includeMatches(pattern: string, name: string, path: string): boolean {
  if (/[[\\!]/.test(pattern)) {
    return true;
  }
  const regex = new RegExp(
    `^${[...pattern].map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))).join("")}$`,
    "is",
  );
  return (
    regex.test(name) ||
    regex.test(path) ||
    path.split("/").some((_, index, parts) => regex.test(parts.slice(index).join("/")))
  );
}

// Whether a directory surely matches an --exclude-dir pattern: only plain
// names with `*` and `?`, matched exactly against the base name.
function surelyExcluded(pattern: string, name: string): boolean {
  const trimmed = pattern.replace(/\/+$/, "");
  if (!trimmed || /[[\\!/{}]/.test(trimmed)) {
    return false;
  }
  const regex = new RegExp(
    `^${[...trimmed].map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))).join("")}$`,
    "s",
  );
  return regex.test(name);
}

/**
 * Whether a recursive read of `root` (grep -r, diff -r) surely reads nothing
 * credential-like. Symbolic links met on the way are not followed, as with
 * `grep -r`; the root itself is checked by the caller. False when the tree is
 * too large to walk.
 */
export function isTreeClean(
  root: string,
  filter: FileFilter = { include: [], includeFirst: false, excludeDirectories: [] },
): boolean {
  let budget = MAX_WALK_ENTRIES;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    budget -= entries.length;
    if (budget < 0) {
      return false;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const inside = relative(root, path);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (filter.excludeDirectories.some((pattern) => surelyExcluded(pattern, entry.name))) {
          continue;
        }
        if (isSensitivePath(inside)) {
          return false;
        }
        pending.push(path);
        continue;
      }
      const read =
        !filter.includeFirst || filter.include.some((pattern) => includeMatches(pattern, entry.name, inside));
      if (read && isSensitivePath(inside)) {
        return false;
      }
    }
  }
  return true;
}
