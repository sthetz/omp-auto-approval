import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { relativePathWithin, resolvePathForCwd, resolveReadRoots, type ReadRoots } from "./common.js";
import { isSensitivePath } from "./sensitive-paths.js";
import { recognizeShell, type ShellCommand, type ShellRedirect, type ShellWord } from "./shell-syntax.js";
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
  // Long options, also matched as `--name=value` and, because GNU getopt
  // accepts any unambiguous abbreviation (`sort --outp=x`), as a prefix.
  prefixes?: string[];
  // Letters that are unsafe anywhere in a short-option group (`-xIf`).
  shortLetters?: string;
}
const UNSAFE_PROGRAM_OPTIONS: Record<string, UnsafeOptions> = {
  find: { exact: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"] },
  // fd groups short flags (`-Hx rm`).
  fd: { prefixes: ["--exec"], shortLetters: "xX" },
  fdfind: { prefixes: ["--exec"], shortLetters: "xX" },
  rg: { prefixes: ["--pre"] },
  sort: { prefixes: ["--compress-program", "--output"], shortLetters: "o" },
  // Running, extracting, or writing archives: x, c, r, u and A write files.
  tar: {
    prefixes: [
      "--to-command", "--checkpoint-action", "--use-compress-program", "--info-script", "--new-volume-script", "--rsh-command",
      "--extract", "--get", "--create", "--append", "--update", "--concatenate", "--catenate", "--delete",
    ],
    shortLetters: "IFxcruA",
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

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

// The PATH OMP started with. OMP runs bash calls in one persistent shell per
// session, so by the time a command runs, an earlier call may have put a
// workspace directory on PATH (`export PATH=$PWD/bin:$PATH`, a virtualenv
// `activate`), or defined an alias or function with the program's name.
const STARTUP_PATH = process.env.PATH ?? "";

/**
 * Where a command runs: `directory`, inside `workspace`. Relative paths are
 * resolved from `directory`; the boundaries are `workspace` and the read roots.
 */
interface Place {
  workspace: string;
  directory: string;
  roots: ReadRoots;
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
function isWorkspaceGitOperand(operand: string, place: Place): boolean {
  const colon = operand.indexOf(":");
  if (colon >= 0) {
    // `HEAD:path` or `:path` reads a blob; `path` is relative to the repo root.
    const blobPath = operand.slice(colon + 1);
    return !blobPath.startsWith("/") && !blobPath.split(/[\\/]/).includes("..") && !isSensitivePath(blobPath);
  }
  if (operand.startsWith("/") || operand.startsWith("~")) {
    return false;
  }
  const relative = relativePathWithin(resolvePathForCwd(operand, place.directory), place.workspace);
  return relative !== null && !isSensitivePath(relative);
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
      return unsafe.prefixes?.some((option) => name.startsWith(option) || (name.length > 2 && option.startsWith(name))) ?? false;
    }
    // tar also takes old-style option letters without a dash as its first argument.
    const group = arg.startsWith("-") ? arg.slice(1) : program === "tar" && index === 0 ? arg : "";
    return [...(unsafe.shortLetters ?? "")].some((letter) => group.includes(letter));
  });
}

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_SHORT_OPTION_GROUP = 512;

/**
 * The parts of an argument that a program might open as a file: the value of
 * `--name=value`; any tail of a short-option group, since a value can be
 * glued to an option (`-f/path`) and which letters take one depends on the
 * program; both the whole word and the value of `name=value` (`dd if=/path`);
 * otherwise the argument itself.
 */
function pathCandidates(text: string): string[] | null {
  if (text.startsWith("--")) {
    const equals = text.indexOf("=");
    return equals < 0 ? [] : [text.slice(equals + 1)];
  }
  if (text.startsWith("-")) {
    if (text.length > MAX_SHORT_OPTION_GROUP) {
      return null;
    }
    return Array.from({ length: Math.max(0, text.length - 2) }, (_, index) => text.slice(index + 2));
  }
  const assignment = text.match(ASSIGNMENT_PREFIX);
  return assignment ? [text, text.slice(assignment[0].length)] : [text];
}

function isInsideReadRoots(absolute: string, roots: ReadRoots): boolean {
  return [roots.cwd, ...roots.extra].some((root) => {
    const relative = relativePathWithin(absolute, root);
    return relative !== null && !isSensitivePath(relative);
  });
}

/**
 * An argument of an allowlisted command that names nothing outside the
 * workspace or read roots and nothing credential-like. Arguments the shell
 * expands (unquoted globs, braces, `~user`, `name=~/…`) are not fast-pathed,
 * since their final form is unknown; a leading `~` or `~/` is expanded here.
 * A literal candidate is only treated as a path when it exists, so search
 * patterns such as `/api/users` do not count.
 */
function isAllowlistedArgumentSafe(word: ShellWord, place: Place): boolean {
  const text = word.text;
  if (word.expands) {
    const homeRelative = (text === "~" || text.startsWith("~/")) && !/[*?[{]/.test(text);
    return homeRelative && isInsideReadRoots(join(homedir(), text.slice(1)), place.roots);
  }
  const candidates = pathCandidates(text);
  return candidates !== null && candidates.every((candidate) => {
    if (!candidate) {
      return true;
    }
    const absolute = resolvePathForCwd(candidate, place.directory);
    return !existsSync(absolute) || isInsideReadRoots(absolute, place.roots);
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

function isBuiltinSafeCommand(words: ShellWord[], place: Place): boolean {
  // `git diff -- secrets*` names whatever the glob matches.
  if (words.some((word) => word.expands)) {
    return false;
  }
  const tokens = words.map((word) => word.text);
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
  if (!operands.every((operand) => isWorkspaceGitOperand(operand, place))) {
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

function isUserAllowlisted(words: ShellWord[], source: string, config: AutoReviewConfig, place: Place): boolean {
  // Entries match the command as written, quotes included, without its
  // redirections.
  const written = normalizeCommand(words.map((word) => source.slice(word.start, word.end)).join(" "));
  if (!config.safeCommandAllowlist.some((entry) => matchesAllowlistEntry(written, entry))) {
    return false;
  }
  const [first, ...args] = words;
  const program = programName(first.text);
  if (first.expands || SCRIPT_PROGRAMS.has(program) || hasUnsafeOption(program, args.map((word) => word.text))) {
    return false;
  }
  return args.every((word) => isAllowlistedArgumentSafe(word, place));
}

/**
 * A redirection a read-only command may have: copying one standard fd to
 * another (`2>&1`), `/dev/null` (`2>/dev/null`, `</dev/null`), or reading a
 * file the fast path could read anyway. Writing a file is reviewed.
 */
function isSafeRedirect(redirect: ShellRedirect, place: Place): boolean {
  if (redirect.kind === "duplicate") {
    return redirect.fd <= 2 && ["0", "1", "2"].includes(redirect.target);
  }
  if (redirect.target === "/dev/null") {
    return true;
  }
  return redirect.kind === "read" && isInsideReadRoots(resolvePathForCwd(redirect.target, place.directory), place.roots);
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * Where `program` lives on OMP's startup PATH, skipping directories inside
 * the workspace and programs that resolve into it: the agent can write files
 * there without review.
 */
function resolveStartupProgram(program: string, workspace: string, searchPath: string): string | null {
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory) || relativePathWithin(directory, workspace) !== null) {
      continue;
    }
    const candidate = join(directory, program);
    try {
      if (!statSync(candidate).isFile()) {
        continue;
      }
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    if (relativePathWithin(candidate, workspace) === null) {
      return candidate;
    }
  }
  return null;
}

/**
 * The directory a `cd <dir>` command moves to, when it is a plain directory
 * inside the workspace, else null. `cd -`, options, and words the shell
 * expands are not followed.
 */
function cdTarget(command: ShellCommand, place: Place): string | null {
  const [program, target, ...rest] = command.words;
  if (program?.text !== "cd" || !target || rest.length || command.redirects.length) {
    return null;
  }
  if (target.expands || !target.text || target.text.startsWith("-")) {
    return null;
  }
  const directory = resolvePathForCwd(target.text, place.directory);
  try {
    if (!statSync(directory).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return relativePathWithin(directory, place.workspace) === null ? null : directory;
}

export interface SafeCommandPlan {
  // The command to run in place of the original: every program named by its
  // absolute path, any leading `cd <dir> &&` removed.
  command: string;
  // The directory a leading `cd` moved it to; absent when there was none.
  cwd?: string;
}

/**
 * How to run a bash command that skips review, or null when it must be
 * reviewed.
 *
 * The command must be in the subset recognizeShell reads exactly, and every
 * simple command in it must be safe on its own: a built-in read-only git
 * command, `pwd`, or a safeCommandAllowlist entry whose arguments stay inside
 * the read roots, with only safe redirections (see isSafeRedirect). `&&`,
 * `||`, `;`, newlines, and pipes between them add nothing a command could not
 * do alone.
 *
 * OMP runs every bash call in one persistent shell per session, so an earlier
 * call may have defined an alias or function with a program's name, put a
 * workspace directory on PATH, or set CDPATH. Each program is therefore
 * replaced by its absolute path from OMP's startup PATH; one already named by
 * a path is kept as written, since bash looks up neither aliases, functions,
 * nor PATH for it. Leading `cd <dir> &&` commands are not run in the shell at
 * all: the plan runs the rest in that directory through the call's `cwd`,
 * which OMP applies itself.
 */
export function planSafeCommand(
  command: string,
  config: AutoReviewConfig,
  options: { workspace: string; cwd?: string; searchPath?: string },
): SafeCommandPlan | null {
  const script = recognizeShell(command);
  if (!script) {
    return null;
  }
  const place: Place = {
    workspace: options.workspace,
    directory: options.cwd ?? options.workspace,
    roots: resolveReadRoots(options.workspace, config.readRoots),
  };
  let first = 0;
  while (first < script.pipelines.length - 1 && script.connectors[first] === "&&" && script.pipelines[first].length === 1) {
    const directory = cdTarget(script.pipelines[first][0], place);
    if (directory === null) {
      break;
    }
    place.directory = directory;
    first += 1;
  }
  const commands = script.pipelines.slice(first).flat();
  const pins: { start: number; end: number; path: string }[] = [];
  for (const shellCommand of commands) {
    const { words } = shellCommand;
    if (!shellCommand.redirects.every((redirect) => isSafeRedirect(redirect, place))) {
      return null;
    }
    if (!isBuiltinSafeCommand(words, place) && !isUserAllowlisted(words, command, config, place)) {
      return null;
    }
    if (!words[0].text.includes("/")) {
      const resolved = resolveStartupProgram(words[0].text, place.workspace, options.searchPath ?? STARTUP_PATH);
      if (!resolved) {
        return null;
      }
      pins.push({ start: words[0].start, end: words[0].end, path: resolved });
    }
  }
  let pinned = command;
  for (const { start, end, path } of pins.reverse()) {
    pinned = `${pinned.slice(0, start)}${shellQuote(path)}${pinned.slice(end)}`;
  }
  return first === 0 ? { command: pinned } : { command: pinned.slice(commands[0].start), cwd: place.directory };
}
