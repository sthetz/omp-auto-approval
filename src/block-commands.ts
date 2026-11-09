// Shell syntax that starts a new command: separators, pipes, background jobs,
// subshells, and command substitution.
const COMMAND_BOUNDARY = /\$\(|[\n\r;&|()`{}]/;

function commandSegments(command: string): string[][] {
  // Quotes and backslashes are dropped rather than parsed, so a command hidden
  // in a quoted string (`bash -lc "git push --force"`) still splits into words.
  return command
    .split(COMMAND_BOUNDARY)
    .map((segment) => segment.replace(/[\\"']/g, "").split(/\s+/).filter(Boolean));
}

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function matchesWords(segment: string[], words: string[]): boolean {
  const [program, ...rest] = words;
  return segment.some((word, start) => {
    if (programName(word) !== program) {
      return false;
    }
    let next = start + 1;
    return rest.every((wanted) => {
      while (next < segment.length && segment[next] !== wanted) {
        next += 1;
      }
      next += 1;
      return next <= segment.length;
    });
  });
}

function parseRegexPattern(pattern: string): RegExp | null {
  const match = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (!match) {
    return null;
  }
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

/**
 * The first `blockCommands` pattern a bash command matches, or null.
 *
 * A pattern is either `/regex/flags`, tested against the whole command, or a
 * list of words: the first names a program and the rest must follow it, in
 * order, within the same command. `git push --force` matches
 * `git push origin main --force` and `/usr/bin/git push --force`, but not
 * `git push --force-with-lease`. Matching errs toward blocking: the words also
 * match when they appear as another command's arguments.
 */
export function matchBlockedCommand(command: string, patterns: readonly string[]): string | null {
  const segments = commandSegments(command);
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) {
      continue;
    }
    const regex = parseRegexPattern(pattern);
    if (regex) {
      if (regex.test(command)) {
        return pattern;
      }
      continue;
    }
    const words = pattern.split(/\s+/);
    if (segments.some((segment) => matchesWords(segment, words))) {
      return pattern;
    }
  }
  return null;
}
