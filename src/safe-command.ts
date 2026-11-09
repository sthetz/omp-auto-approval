import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { relativePathWithin, resolvePathForCwd, resolveReadRoots, type ReadRoots } from "./common.js";
import { isSensitivePath } from "./sensitive-paths.js";
import type { AutoReviewConfig } from "./types.js";

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse"]);
const SAFE_GIT_BRANCH_FLAGS = new Set(["--show-current", "--list", "--all", "--merged", "--no-merged", "-a", "-r", "-v", "-vv"]);
// Positional arguments are branch-name patterns only in list mode; otherwise
// `git branch <name>` creates a branch.
const GIT_BRANCH_LIST_MODE_FLAGS = new Set(["--list", "--merged", "--no-merged"]);
// Long options that make otherwise read-only git commands write files, run
// external programs, or compare arbitrary files outside the repository. Git
// accepts unambiguous abbreviations, so prefixes match too.
const UNSAFE_GIT_LONG_OPTIONS = ["--output", "--ext-diff", "--no-index"];

// safeCommandAllowlist entries are prefixes, so allowlisting a program would
// otherwise allow every option it has. Options that execute other programs or
// write files never take the fast path, whichever entry matched.
interface UnsafeOptions {
  exact?: string[];
  // Long options, also matched as `--name=value`.
  prefixes?: string[];
  // Letters that are unsafe anywhere in a short-option group (`-xIf`).
  shortLetters?: string;
}
const UNSAFE_PROGRAM_OPTIONS: Record<string, UnsafeOptions> = {
  find: { exact: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"] },
  fd: { exact: ["-x", "-X"], prefixes: ["--exec"] },
  fdfind: { exact: ["-x", "-X"], prefixes: ["--exec"] },
  rg: { prefixes: ["--pre"] },
  sort: { prefixes: ["--compress-program", "--output"], shortLetters: "o" },
  tar: {
    prefixes: ["--to-command", "--checkpoint-action", "--use-compress-program", "--info-script", "--new-volume-script", "--rsh-command"],
    shortLetters: "IF",
  },
};

// Programs whose arguments are a script or another command line. No
// safeCommandAllowlist entry for them is honoured.
const SCRIPT_PROGRAMS = new Set(["xargs", "parallel", "sed", "awk", "gawk", "mawk", "nawk"]);

// Shells, interpreters, and wrappers that run another command. Allowlisting
// the bare program would allow any code; an entry must name a specific
// invocation, such as `python -m pytest` or `npm test`.
const CODE_RUNNERS = new Set([
  "sh", "bash", "zsh", "dash", "fish", "ksh",
  "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "lua", "npx",
  "env", "sudo", "doas", "su", "nice", "nohup", "timeout", "time", "watch", "command", "builtin",
  "exec", "eval", "stdbuf", "chroot", "setsid", "flock", "strace",
]);

// Command separators, background jobs, pipes, redirections, and expansions.
// Newlines and a single `&` both start a new command in bash.
const UNSAFE_SHELL_CHARACTERS = /[\n\r&|;<>`$]/;

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function unwrapBashLc(command: string): string | null {
  const normalized = normalizeCommand(command);
  const match = normalized.match(/^bash\s+-lc\s+(['"])([\s\S]*)\1$/);
  return match ? match[2] : null;
}

function isUnsafeGitOption(arg: string): boolean {
  if (!arg.startsWith("--")) {
    return false;
  }
  const name = arg.split("=", 1)[0];
  return UNSAFE_GIT_LONG_OPTIONS.some((option) => (
    name.startsWith(option) || (name.length > 2 && option.startsWith(name))
  ));
}

/**
 * A git operand (revision, `rev:path`, or path) that stays inside the
 * workspace and away from credential-like files. Git compares files outside
 * the work tree even without `--no-index` (`git diff /etc/passwd /dev/null`),
 * so any operand that resolves outside the workspace is reviewed.
 */
function isWorkspaceGitOperand(operand: string, cwd: string): boolean {
  const colon = operand.indexOf(":");
  if (colon >= 0) {
    // `HEAD:path` or `:path` reads a blob; `path` is relative to the repo root.
    const blobPath = operand.slice(colon + 1);
    return !blobPath.startsWith("/") && !blobPath.split(/[\\/]/).includes("..") && !isSensitivePath(blobPath);
  }
  if (operand.startsWith("/") || operand.startsWith("~")) {
    return false;
  }
  const relative = relativePathWithin(operand, cwd);
  return relative !== null && !isSensitivePath(relative);
}

interface Token {
  text: string;
  // Contains an unquoted glob or brace character, or starts with an unquoted
  // `~`: the shell rewrites it before the program sees it.
  expands: boolean;
}

function tokenizeWords(command: string): Token[] | null {
  const tokens: Token[] = [];
  let current = "";
  let expands = false;
  let started = false;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  const finish = () => {
    if (started) {
      tokens.push({ text: current, expands });
    }
    current = "";
    expands = false;
    started = false;
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      finish();
      continue;
    }
    if (/[*?[{]/.test(char) || (char === "~" && current === "")) {
      expands = true;
    }
    current += char;
    started = true;
  }

  if (escaped || quote) {
    return null;
  }
  finish();
  return tokens;
}

function tokenizeSimpleCommand(command: string): string[] | null {
  return tokenizeWords(command)?.map((token) => token.text) ?? null;
}

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function hasUnsafeOption(program: string, args: string[]): boolean {
  const unsafe = UNSAFE_PROGRAM_OPTIONS[program];
  if (!unsafe) {
    return false;
  }
  return args.some((arg, index) => {
    if (unsafe.exact?.includes(arg)) {
      return true;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=", 1)[0];
      return unsafe.prefixes?.some((option) => name.startsWith(option)) ?? false;
    }
    // tar also takes old-style option letters without a dash as its first argument.
    const group = arg.startsWith("-") ? arg.slice(1) : program === "tar" && index === 0 ? arg : "";
    return [...(unsafe.shortLetters ?? "")].some((letter) => group.includes(letter));
  });
}

/**
 * An argument of an allowlisted command that names nothing outside the
 * workspace or read roots and nothing credential-like. Arguments the shell
 * expands (unquoted globs, braces, `~user`) are not fast-pathed, since their
 * final form is unknown; `~/` is expanded here. A literal argument is only
 * treated as a path when it exists, so search patterns such as `/api/users`
 * do not count.
 */
function isAllowlistedArgumentSafe(token: Token, roots: ReadRoots): boolean {
  let value = token.text;
  if (value.startsWith("-")) {
    const equals = value.indexOf("=");
    if (equals < 0) {
      return true;
    }
    value = value.slice(equals + 1);
  }
  if (!value) {
    return true;
  }
  const homeRelative = token.expands && (value === "~" || value.startsWith("~/")) && !/[*?[{]/.test(value);
  if (token.expands && !homeRelative) {
    return false;
  }
  const absolute = resolvePathForCwd(homeRelative ? join(homedir(), value.slice(1)) : value, roots.cwd);
  if (!homeRelative && !existsSync(absolute)) {
    return true;
  }
  return [roots.cwd, ...roots.extra].some((root) => {
    const relative = relativePathWithin(absolute, root);
    return relative !== null && !isSensitivePath(relative);
  });
}

/**
 * Why a safeCommandAllowlist entry is ignored, or null when it is honoured.
 */
export function allowlistEntryProblem(entry: string): string | null {
  const words = entry.trim().replace(/\*$/, "").trim().split(/\s+/).filter(Boolean);
  const program = words[0] ? programName(words[0]) : "";
  if (SCRIPT_PROGRAMS.has(program)) {
    return `${program} runs commands or writes files from its arguments`;
  }
  if (CODE_RUNNERS.has(program) && words.length < 2) {
    return `allowing bare ${program} would allow any code; list a specific invocation such as "python -m pytest" or "npm test"`;
  }
  return null;
}

function isBuiltinSafeCommand(command: string, cwd: string): boolean {
  const tokens = tokenizeSimpleCommand(command);
  if (!tokens?.length) {
    return false;
  }

  const [program, subcommand, ...rest] = tokens;
  if (program === "pwd" && tokens.length === 1) {
    return true;
  }
  if (program !== "git" || !subcommand) {
    return false;
  }
  if (rest.some(isUnsafeGitOption)) {
    return false;
  }
  const endOfOptions = rest.indexOf("--");
  const operands = rest.filter((arg, index) => (endOfOptions >= 0 && index > endOfOptions) || (arg !== "--" && !arg.startsWith("-")));
  if (!operands.every((operand) => isWorkspaceGitOperand(operand, cwd))) {
    return false;
  }
  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return true;
  }
  if (subcommand !== "branch") {
    return false;
  }
  const flags = rest.filter((arg) => arg.startsWith("-"));
  const hasPositional = flags.length < rest.length;
  return flags.every((flag) => SAFE_GIT_BRANCH_FLAGS.has(flag))
    && (!hasPositional || flags.some((flag) => GIT_BRANCH_LIST_MODE_FLAGS.has(flag)));
}

function matchesAllowlistEntry(command: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed || allowlistEntryProblem(trimmed)) {
    return false;
  }
  if (trimmed.endsWith("*")) {
    return command.startsWith(trimmed.slice(0, -1));
  }
  return command === trimmed || command.startsWith(`${trimmed} `);
}

function isUserAllowlisted(command: string, config: AutoReviewConfig, cwd: string): boolean {
  if (!config.safeCommandAllowlist.some((entry) => matchesAllowlistEntry(command, entry))) {
    return false;
  }
  const tokens = tokenizeWords(command);
  if (!tokens?.length) {
    return false;
  }
  const [first, ...args] = tokens;
  const program = programName(first.text);
  if (first.expands || SCRIPT_PROGRAMS.has(program) || hasUnsafeOption(program, args.map((token) => token.text))) {
    return false;
  }
  const roots = resolveReadRoots(cwd, config.readRoots);
  return args.every((token) => isAllowlistedArgumentSafe(token, roots));
}

export function isSafeReadOnlyCommand(command: string, config: AutoReviewConfig, cwd: string): boolean {
  // Check the raw command: the bash -lc payload is a substring of it.
  if (UNSAFE_SHELL_CHARACTERS.test(command)) {
    return false;
  }
  const simple = normalizeCommand(unwrapBashLc(command) ?? command);
  if (!simple) {
    return false;
  }
  return isBuiltinSafeCommand(simple, cwd) || isUserAllowlisted(simple, config, cwd);
}
