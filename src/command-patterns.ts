import { group, itemAt } from "./common.js";
import { commandLines } from "./shell-hooks.js";
import { recognizeShell } from "./shell-syntax.js";

// Shell syntax that starts a new command: separators, pipes, background jobs,
// subshells, and command substitution.
const COMMAND_BOUNDARY = /\$\(|[\n\r;&|()`{}]/;

/** The words of every command in a bash command, read two ways (see commandSegments). */
export interface CommandSegments {
  // As bash reads them: quotes keep words together (`git -c 'x=a;b' push`),
  // and scripts the command hands to a shell are read too (`sh -c '…'`,
  // `eval '…'`, a heredoc fed to `bash`).
  structural: string[][];
  // Split at every operator character with quotes dropped, so text inside
  // quotes counts too (`ssh host "git push --force"`, but also a commit
  // message that mentions a command).
  text: string[][];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
const MAX_NESTED_SCRIPTS = 3;
const unquote = (word: string) => word.replace(/[\\"']/g, "");

/**
 * The script a command line hands to a shell to run, or null: the argument
 * of `-c` for a shell (`bash -lc '…'`) or `su`, or the words after `eval`.
 */
function nestedScript(line: string[]): string | null {
  const start = commandStart(line);
  // eval is also a wrapper, so commandStart steps over it.
  const evaluated = line.slice(0, start).findIndex((word) => programName(word) === "eval");
  if (evaluated >= 0) {
    return line.slice(evaluated + 1).join(" ");
  }
  const program = programName(line[start] ?? "");
  if (SHELLS.has(program) || program === "su") {
    const option = line.findIndex((word, index) => index > start && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    return option >= 0 ? (line[option + 1] ?? null) : null;
  }
  return null;
}

/**
 * The words of every command in `command`, as CommandSegments describes. A
 * backslash-newline is removed first, as bash does.
 */
export function commandSegments(command: string, depth = 0): CommandSegments {
  const text = command.replace(/\\\r?\n/g, "");
  const bodies: string[] = [];
  const lines = commandLines(text, bodies)
    .map((words) => words.map(unquote).filter(Boolean))
    .filter((line) => line.length > 0);
  const recognized =
    recognizeShell(text)
      ?.pipelines.flat()
      .map((simple) => simple.words.map((word) => word.text)) ?? [];
  const structural = [...resolveExpansions(lines), ...recognized];
  const naive = text
    .split(COMMAND_BOUNDARY)
    .map((segment) => unquote(segment).split(/\s+/).filter(Boolean))
    .filter((segment) => segment.length > 0);
  const textual = resolveExpansions(naive);
  if (depth < MAX_NESTED_SCRIPTS) {
    const scripts = lines.map(nestedScript).filter((script): script is string => script !== null);
    // A heredoc's body is a script when a shell reads it from stdin.
    if (lines.some((line) => SHELLS.has(programName(line[commandStart(line)] ?? "")) && nestedScript(line) === null)) {
      scripts.push(...bodies);
    }
    for (const script of scripts) {
      const nested = commandSegments(script, depth + 1);
      structural.push(...nested.structural);
      textual.push(...nested.text);
    }
  }
  return { structural, text: textual };
}

// Marks a word the shell expands to something unknown (see resolveExpansions).
const EXPANDED = "\u0000";

/**
 * Lines with variables the command sets to plain text written out
 * (`K=kubectl; $K delete` reads `kubectl delete`), as the shell would, and
 * every other word that is an expansion or a substitution marked, since it
 * could be any program. A line of only assignments, or of `export` and the
 * like, sets variables; a value with `$` or a substitution in it is unknown.
 */
function resolveExpansions(lines: string[][]): string[][] {
  const literals = new Map<string, string>();
  return lines.map((words) => {
    const first = words.findIndex((word) => !ASSIGNMENT.test(word));
    const setters =
      first < 0
        ? words
        : ["export", "declare", "typeset", "local", "readonly"].includes(itemAt(words, first))
          ? words.slice(first + 1)
          : [];
    for (const word of setters) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
      if (assignment) {
        const [name, value] = [group(assignment, 1), group(assignment, 2)];
        if (EXPANSION.test(value)) {
          literals.delete(name);
        } else {
          literals.set(name, value);
        }
      }
    }
    return words.flatMap((word) => {
      const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(word);
      const value = variable ? literals.get(group(variable, 1)) : undefined;
      if (value !== undefined) {
        return value.split(/\s+/).filter(Boolean);
      }
      return EXPANSION.test(word) && !ASSIGNMENT.test(word) ? [`${EXPANDED}${word}`] : [word];
    });
  });
}

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

// Words that run the command that follows them, and their options that take
// the next word as a value.
const WRAPPERS = new Map<string, string[]>([
  ["sudo", ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]],
  ["doas", ["-u", "-C"]],
  ["env", ["-u", "-C", "-S"]],
  ["command", []],
  ["builtin", []],
  ["exec", ["-a"]],
  ["eval", []],
  ["time", ["-f", "-o"]],
  ["nohup", []],
  ["nice", ["-n"]],
  ["xargs", ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]],
  ["stdbuf", ["-i", "-o", "-e"]],
  ["setsid", []],
  ["watch", ["-n", "-d"]],
  ["then", []],
  ["do", []],
  ["else", []],
  ["if", []],
  ["elif", []],
  ["while", []],
  ["until", []],
  ["!", []],
  ["{", []],
]);
// find runs the command after these.
const EXEC_OPTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
// A redirection: `2>/dev/null`, or `>` followed by its target.
const REDIRECTION = /^\d*(>>?|<|&>|>&)/;

/**
 * Where programs run in a line: the first word after assignments and
 * redirections, and, while that is a wrapper (`sudo`, `env`, `xargs`), the
 * word after it and its options. The last is the command that does the work.
 */
function commandPositions(line: string[]): number[] {
  const positions: number[] = [];
  let index = 0;
  while (index < line.length) {
    const word = itemAt(line, index);
    if (ASSIGNMENT.test(word)) {
      index += 1;
    } else if (REDIRECTION.test(word)) {
      index += /^\d*(>>?|<|&>|>&)$/.test(word) ? 2 : 1;
    } else {
      positions.push(index);
      const values = WRAPPERS.get(programName(word));
      if (!values) {
        break;
      }
      index += 1;
      while (index < line.length && itemAt(line, index).startsWith("-")) {
        index += values.includes(itemAt(line, index)) ? 2 : 1;
      }
    }
  }
  return positions;
}

/** Where the command that does the work starts: after assignments, redirections, wrappers and their options. */
function commandStart(line: string[]): number {
  return commandPositions(line).at(-1) ?? line.length;
}

/**
 * Whether the word at `index` is where a program runs (see
 * commandPositions), or follows `find -exec`. Elsewhere it is an argument
 * (`grep $pattern -i`, `which sudo`).
 */
function atCommandPosition(segment: string[], index: number): boolean {
  const previous = segment[index - 1];
  return commandPositions(segment).includes(index) || (previous !== undefined && EXEC_OPTIONS.has(previous));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

// A word that holds a parameter expansion or a command substitution.
const EXPANSION = /[$`]/;
const SHORT_FLAG = /^-[A-Za-z0-9]$/;
const SHORT_FLAG_GROUP = /^-[A-Za-z0-9]+$/;

type WordTest = (word: string) => boolean;

/** `-f` also matches a group of short flags that contains it (`-uf`), and `--as` matches `--as=admin`. */
function literalWord(wanted: string): WordTest {
  return (word) =>
    word === wanted ||
    (SHORT_FLAG.test(wanted) && SHORT_FLAG_GROUP.test(word) && word.includes(wanted.charAt(1))) ||
    (wanted.startsWith("--") && word.startsWith(`${wanted}=`));
}

function globWord(glob: string): WordTest {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 2);
      if (end < 0) {
        throw new Error(`unclosed "[" in ${JSON.stringify(glob)}`);
      }
      const set = glob.slice(index + 1, end).replace(/\\/g, "\\\\");
      source += set.startsWith("!") ? `[^${set.slice(1)}]` : `[${set}]`;
      index = end;
    } else {
      source += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  const regex = new RegExp(`^${source}$`, "s");
  return (word) => regex.test(word);
}

/** `a|b` split at each `|` outside `[…]`, so that `[|]` is a literal `|`. */
function splitAlternatives(word: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < word.length; index += 1) {
    const char = word.charAt(index);
    if (char === "[") {
      const end = word.indexOf("]", index + 2);
      if (end >= 0) {
        current += word.slice(index, end + 1);
        index = end;
        continue;
      }
    }
    if (char === "|") {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * One word of a pattern: `a|b` alternatives, each a literal or a glob with
 * `*`, `?` and `[…]`; `[|]` is a literal `|`.
 */
function wordTest(wanted: string): WordTest {
  const alternatives = splitAlternatives(wanted)
    .filter(Boolean)
    .map((alternative) => (/[*?[]/.test(alternative) ? globWord(alternative) : literalWord(alternative)));
  if (!alternatives.length) {
    throw new Error(`empty word in a pattern: ${JSON.stringify(wanted)}`);
  }
  return (word) => alternatives.some((test) => test(word));
}

/**
 * A compiled pattern: how a command matches it. "structural" when it matches
 * the command as bash reads it (and for a regex, any match); "text" when only
 * the quote-blind reading matches; null when it does not match.
 */
export type CommandPattern = (command: string, segments: CommandSegments) => "structural" | "text" | null;

/**
 * Compile a pattern: `/regex/flags`, tested against the whole command, or
 * words: the first names a program (by its last path component) and the
 * rest must follow it, in order, within the same command. Throws on an
 * invalid pattern.
 */
export function compileCommandPattern(raw: string): CommandPattern {
  const pattern = raw.trim();
  if (!pattern) {
    throw new Error("empty pattern");
  }
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (regex) {
    // Without g and y, test() keeps no state between commands.
    const compiled = new RegExp(group(regex, 1), group(regex, 2).replace(/[gy]/g, ""));
    return (command) => (compiled.test(command) ? "structural" : null);
  }
  const words = pattern.split(/\s+/);
  // A trimmed, non-empty pattern has a first word.
  const first = itemAt(words, 0);
  if (first.includes("/")) {
    throw new Error(
      `programs are matched by name, so "${first}" never matches; write "${first.slice(first.lastIndexOf("/") + 1)}"`,
    );
  }
  const program = wordTest(first);
  const rest = words.slice(1).map(wordTest);
  // A one-word pattern (`sudo`, `mkfs*`) matches only where a program runs,
  // not an argument (`which sudo`), and never in the quote-blind reading. A
  // longer pattern matches its program anywhere, since a wrapper it does not
  // know (`docker exec c`, `ssh host`) may run it, and its other words must
  // follow.
  const oneWord = rest.length === 0;
  const matches = (segments: string[][]) =>
    segments.some((segment) =>
      segment.some((word, start) => {
        const expanded = word.startsWith(EXPANDED);
        // A word the shell expands (`$k`, `${KUBECTL}`, `$(command -v kubectl)`)
        // where a program runs could be any program: agents often name one
        // through a variable. Not for a one-word pattern, or every command run
        // by a variable would match.
        const named = program(programName(expanded ? word.slice(1) : word));
        if (
          oneWord
            ? !named || !atCommandPosition(segment, start)
            : !named && !(expanded && atCommandPosition(segment, start))
        ) {
          return false;
        }
        let next = start + 1;
        return rest.every((wanted) => {
          while (next < segment.length && !wanted(itemAt(segment, next).replace(EXPANDED, ""))) {
            next += 1;
          }
          next += 1;
          return next <= segment.length;
        });
      }),
    );
  return (_command, segments) =>
    matches(segments.structural) ? "structural" : !oneWord && matches(segments.text) ? "text" : null;
}
