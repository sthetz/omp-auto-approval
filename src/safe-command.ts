import { relativePathWithin } from "./common.js";
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

function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
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
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
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

function isUserAllowlisted(command: string, config: AutoReviewConfig): boolean {
  return config.safeCommandAllowlist.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed.endsWith("*")) {
      return command.startsWith(trimmed.slice(0, -1));
    }
    return command === trimmed || command.startsWith(`${trimmed} `);
  });
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
  return isBuiltinSafeCommand(simple, cwd) || isUserAllowlisted(simple, config);
}
