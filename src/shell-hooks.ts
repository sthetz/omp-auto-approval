import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePathForCwd } from "./common.js";

/**
 * Bash commands that can leave the session's persistent shell running code
 * on its own before or after later commands: a DEBUG, ERR or RETURN trap, a
 * hook variable such as PS4 or BASH_ENV, or anything that runs text this
 * check cannot read (`eval`, `exec`, a file it cannot read, a command named
 * by a variable). Pinning a fast-pathed program to its absolute path does not
 * help against these: a DEBUG trap runs before the pinned program, and before
 * anything put in front of it. So once a command like this has run, the bash
 * fast path stays off for the rest of the session (see SessionApprovalStore).
 *
 * This reads text, so it can be evaded (`$'\x74rap'`, code assembled in
 * pieces); it raises the bar, and the command that sets a hook still goes
 * through review first.
 */

// Commands that change how the current shell runs later commands, or run
// text unread.
const HOOK_COMMANDS = new Set(["trap", "source", ".", "eval", "exec", "enable"]);
// Words that may stand before a command name.
const PREFIX_WORDS = new Set(["!", "then", "do", "else", "elif", "if", "while", "until", "time", "builtin", "command", "{"]);
// Variables and options that make the shell run code by itself.
const HOOK_TEXT = /\b(BASH_ENV|PS4|PROMPT_COMMAND|promptvars|extdebug|functrace|errtrace)\b/;
// An alias or variable whose value starts with a hook command (`alias t=trap`, `t=eval`).
const HOOK_VALUE = /^[A-Za-z_][A-Za-z0-9_]*=(trap|source|eval|exec|enable)(\s|$)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const MAX_SOURCED_FILE_BYTES = 256 * 1024;
const MAX_SOURCE_DEPTH = 3;

function unquote(word: string): string {
  return word.replace(/['"\\]/g, "");
}

/**
 * The command lines in `text`, split at operators, grouping characters and
 * the start of command substitutions, and each split into words, roughly as
 * bash would: quotes and `${…}` keep their contents together, a backslash
 * escapes the next character, and a `#` starting a word comments out the
 * rest of the line. Heredoc bodies are skipped: they are a command's input,
 * and run in this shell only through `source /dev/stdin` or `eval`, which
 * count on their own.
 */
function commandLines(text: string): string[][] {
  const lines: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | "\"" | null = null;
  // Open command substitutions: the quoting to return to when each closes,
  // and how many plain parentheses are open inside it.
  const substitutions: { quote: "\"" | null; backtick: boolean; depth: number }[] = [];
  // Heredocs opened on the current line, whose bodies start after it.
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  const endWord = () => {
    if (started) {
      words.push(word);
    }
    word = "";
    started = false;
  };
  const endLine = () => {
    endWord();
    lines.push(words);
    words = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] ?? "";
    if (quote === "'") {
      word += char;
      quote = char === "'" ? null : quote;
      continue;
    }
    if (char === "\\") {
      word += char + next;
      started = true;
      index += 1;
      continue;
    }
    if (char === "$" && next === "{") {
      const end = text.indexOf("}", index);
      word += end < 0 ? text.slice(index) : text.slice(index, end + 1);
      started = true;
      index = end < 0 ? text.length : end;
      continue;
    }
    // Command substitutions run commands, inside double quotes too.
    if (char === "`" && quote === null && substitutions.at(-1)?.backtick) {
      endLine();
      quote = substitutions.pop()!.quote;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(")) {
      endLine();
      substitutions.push({ quote, backtick: char === "`", depth: 0 });
      quote = null;
      index += char === "$" ? 1 : 0;
      continue;
    }
    if (quote === "\"") {
      word += char;
      quote = char === "\"" ? null : quote;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      word += char;
      started = true;
      continue;
    }
    if (char === "<" && next === "<" && text[index + 2] !== "<") {
      const heredoc = /^<<(-?)[ \t]*(['"]?)([^\s'";&|<>()]+)\2/.exec(text.slice(index));
      if (heredoc) {
        heredocs.push({ delimiter: heredoc[3], stripTabs: heredoc[1] === "-" });
        endWord();
        index += heredoc[0].length - 1;
        continue;
      }
    }
    if (char === "\n" && heredocs.length) {
      endLine();
      // Skip each body, up to the line that is its delimiter.
      let position = index + 1;
      for (const { delimiter, stripTabs } of heredocs.splice(0)) {
        while (position <= text.length) {
          const end = text.indexOf("\n", position);
          const line = text.slice(position, end < 0 ? text.length : end);
          position = end < 0 ? text.length + 1 : end + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
            break;
          }
        }
      }
      index = position - 2;
      continue;
    }
    if (char === "#" && !started) {
      while (index + 1 < text.length && text[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }
    const open = substitutions.at(-1);
    if (char === "(" && open && !open.backtick) {
      open.depth += 1;
    } else if (char === ")" && open && !open.backtick) {
      if (open.depth === 0) {
        endLine();
        quote = substitutions.pop()!.quote;
        continue;
      }
      open.depth -= 1;
    }
    if (char === " " || char === "\t") {
      endWord();
    } else if ("\n;&|(){}".includes(char)) {
      endLine();
    } else {
      word += char;
      started = true;
    }
  }
  endLine();
  return lines;
}

function sourcedFile(word: string, directory: string): string | null {
  if (!word || /[$`*?[{]/.test(word)) {
    return null;
  }
  const path = word === "~" || word.startsWith("~/") ? join(homedir(), word.slice(1)) : resolvePathForCwd(word, directory);
  return path;
}

/**
 * Why `command` may leave a hook in the shell, or null. `directory` is where
 * it runs, for reading files it sources.
 */
export function shellHook(command: string, directory: string, depth = 0): string | null {
  const text = command.replace(/\\\n/g, "");
  let place = directory;
  // Variables this command sets to literal text, so `X="git log"; $X` can be
  // read; a variable from anywhere else could name any command.
  const literals = new Map<string, string>();
  for (const [index, words] of commandLines(text).entries()) {
    const variable = words.map((word) => HOOK_TEXT.exec(word)).find(Boolean);
    if (variable) {
      return `\`${variable[1]}\``;
    }
    const plain = words.map(unquote);
    const value = plain.find((word) => HOOK_VALUE.test(`${word} `));
    if (value) {
      return `\`${value}\``;
    }
    let position = 0;
    while (position < plain.length && (PREFIX_WORDS.has(plain[position]) || ASSIGNMENT.test(plain[position]))) {
      position += 1;
    }
    const name = plain[position];
    // A line of only assignments, or `export`/`declare`/… of them, sets shell
    // variables; assignments before a command only set its environment.
    const setters = name === undefined ? words : ["export", "declare", "typeset", "local", "readonly"].includes(name) ? words.slice(position + 1) : [];
    for (const word of setters) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
      if (assignment) {
        if (/[$`]/.test(assignment[2])) {
          literals.delete(assignment[1]);
        } else {
          literals.set(assignment[1], unquote(assignment[2]));
        }
      }
    }
    if (!name) {
      continue;
    }
    if (/[$`]/.test(words[position])) {
      const variable = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/.exec(words[position]);
      const value = variable ? literals.get(variable[1]) : undefined;
      // Unquoted, the value splits into words and the first is the program.
      const program = value === undefined ? undefined : words[position].startsWith("\"") ? value : value.trim().split(/\s+/)[0];
      if (program === undefined) {
        return `a command named by a variable (\`${words[position].slice(0, 40)}\`)`;
      }
      if (HOOK_COMMANDS.has(program)) {
        return `\`${program}\` (through \`${words[position].slice(0, 40)}\`)`;
      }
      continue;
    }
    if (name === "cd") {
      // Only a leading `cd <dir>` is followed; after any other, where a
      // sourced file is read from is unknown.
      const target = plain[position + 1];
      place = index === 0 && target && !/[$`*?[{~]/.test(target) ? resolvePathForCwd(target, place) : "";
      continue;
    }
    if (!HOOK_COMMANDS.has(name)) {
      continue;
    }
    if (name !== "source" && name !== ".") {
      return `\`${name}\``;
    }
    // A sourced file runs in this shell: read it like a command.
    const path = place ? sourcedFile(words[position + 1] ?? "", place) : null;
    if (!path || depth >= MAX_SOURCE_DEPTH) {
      return `\`${name}\` of a file that could not be read`;
    }
    let body: string;
    try {
      // Only regular files: reading a FIFO or a device (`/dev/stdin`,
      // `/dev/zero`) could block OMP itself.
      const stats = statSync(path);
      if (!stats.isFile()) {
        return `\`${name}\` of a file that could not be read`;
      }
      if (stats.size > MAX_SOURCED_FILE_BYTES) {
        return `\`${name}\` of a file too large to read`;
      }
      body = readFileSync(path, "utf8");
    } catch {
      return `\`${name}\` of a file that could not be read`;
    }
    const inner = shellHook(body, place, depth + 1);
    if (inner) {
      return `${inner} in ${words[position + 1]}`;
    }
  }
  return null;
}
