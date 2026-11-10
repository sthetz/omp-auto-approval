import { commandLines } from "./shell-hooks.js";
import { recognizeShell } from "./shell-syntax.js";

// Shell syntax that starts a new command: separators, pipes, background jobs,
// subshells, and command substitution.
const COMMAND_BOUNDARY = /\$\(|[\n\r;&|()`{}]/;

/**
 * The words of every command in `command`, read three ways, so that matching
 * errs toward finding a command:
 * - split at every operator character with quotes and backslashes dropped,
 *   so a command hidden in a quoted string (`bash -lc "git push --force"`)
 *   still splits into words;
 * - split as the shell would, quotes kept together (`git -c 'x=a;b' push`);
 * - the recognizer's simple commands, when it reads the command exactly.
 * A backslash-newline is removed first, as bash does.
 */
export function commandSegments(command: string): string[][] {
  const text = command.replace(/\\\r?\n/g, "");
  const unquote = (word: string) => word.replace(/[\\"']/g, "");
  const naive = text.split(COMMAND_BOUNDARY).map((segment) => unquote(segment).split(/\s+/).filter(Boolean));
  const quoted = commandLines(text).map((words) => words.map(unquote).filter(Boolean));
  const recognized = recognizeShell(text)?.pipelines.flat().map((simple) => simple.words.map((word) => word.text)) ?? [];
  return [...naive, ...quoted, ...recognized].filter((segment) => segment.length > 0);
}

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

const SHORT_FLAG = /^-[A-Za-z0-9]$/;
const SHORT_FLAG_GROUP = /^-[A-Za-z0-9]+$/;

type WordTest = (word: string) => boolean;

/** `-f` also matches a group of short flags that contains it (`-uf`), and `--as` matches `--as=admin`. */
function literalWord(wanted: string): WordTest {
  return (word) => word === wanted
    || (SHORT_FLAG.test(wanted) && SHORT_FLAG_GROUP.test(word) && word.includes(wanted[1]))
    || (wanted.startsWith("--") && word.startsWith(`${wanted}=`));
}

function globWord(glob: string): WordTest {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
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
    const char = word[index];
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
  const alternatives = splitAlternatives(wanted).filter(Boolean).map((alternative) => (
    /[*?[]/.test(alternative) ? globWord(alternative) : literalWord(alternative)
  ));
  if (!alternatives.length) {
    throw new Error(`empty word in a pattern: ${JSON.stringify(wanted)}`);
  }
  return (word) => alternatives.some((test) => test(word));
}

/** A compiled pattern: true when a command matches it. */
export type CommandPattern = (command: string, segments: string[][]) => boolean;

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
    const compiled = new RegExp(regex[1], regex[2].replace(/[gy]/g, ""));
    return (command) => compiled.test(command);
  }
  const words = pattern.split(/\s+/);
  if (words[0].includes("/")) {
    throw new Error(`programs are matched by name, so "${words[0]}" never matches; write "${words[0].slice(words[0].lastIndexOf("/") + 1)}"`);
  }
  const [program, ...rest] = words.map(wordTest);
  return (_command, segments) => segments.some((segment) => segment.some((word, start) => {
    if (!program(programName(word))) {
      return false;
    }
    let next = start + 1;
    return rest.every((wanted) => {
      while (next < segment.length && !wanted(segment[next])) {
        next += 1;
      }
      next += 1;
      return next <= segment.length;
    });
  }));
}
