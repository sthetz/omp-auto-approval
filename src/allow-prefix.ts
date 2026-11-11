import { itemAt } from "./common.js";

/**
 * What an allow rule's `prefix` may name. A prefix allows every option of
 * the program it names, so these programs are never allowed that way.
 */

// Programs whose arguments are a script or another command line.
export const SCRIPT_PROGRAMS = new Set(["xargs", "parallel", "sed", "awk", "gawk", "mawk", "nawk"]);

// Shells, interpreters, and wrappers that run another command. Allowing the
// bare program would allow any code; a prefix must name a specific
// invocation, such as `python -m pytest` or `npm test`.
// prettier-ignore
const CODE_RUNNERS = new Set([
  "sh", "bash", "zsh", "dash", "fish", "ksh",
  "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "lua", "npx",
  "env", "sudo", "doas", "su", "nice", "nohup", "timeout", "time", "watch", "command", "builtin",
  "exec", "eval", "stdbuf", "chroot", "setsid", "flock", "strace",
]);

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/**
 * The words of a prefix that are whole: a trailing `*` glued to a word
 * (`pyth*`, `python -*`) leaves that word unfinished, so it can stand for
 * any word that starts that way.
 */
function wholeWords(prefix: string): string[] {
  const trimmed = prefix.trim();
  const words = trimmed.replace(/\*$/, "").trim().split(/\s+/).filter(Boolean);
  return trimmed.endsWith("*") && !/\s\*$/.test(trimmed) ? words.slice(0, -1) : words;
}

/**
 * Why an allow rule's prefix is refused, or null when it is accepted.
 */
export function allowPrefixProblem(entry: string): string | null {
  const words = entry.trim().replace(/\*$/, "").trim().split(/\s+/).filter(Boolean);
  const program = words[0] ? programName(words[0]) : "";
  if (SCRIPT_PROGRAMS.has(program)) {
    return `${program} runs commands or writes files from its arguments`;
  }
  if (CODE_RUNNERS.has(program) && wholeWords(entry).length < 2) {
    return `allowing bare ${program} would allow any code; list a specific invocation such as "python -m pytest" or "npm test"`;
  }
  return null;
}

/**
 * Whether a prefix may let through a command run by `program`. The check
 * at load time reads only the prefix, and a prefix such as `ba*` or `e*`
 * matches `bash -c …` or `env rm …`: a shell, interpreter or wrapper must be
 * named in full, followed by at least one more whole word.
 */
export function prefixAllowsProgram(prefix: string, program: string): boolean {
  if (SCRIPT_PROGRAMS.has(program)) {
    return false;
  }
  if (!CODE_RUNNERS.has(program)) {
    return true;
  }
  const words = wholeWords(prefix);
  return words.length >= 2 && programName(itemAt(words, 0)) === program;
}
