import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonicalPath,
  itemAt,
  relativePathWithin,
  resolvePathForCwd,
  resolveReadRoots,
  type ReadRoots,
} from "./common.js";
import { boundedGlobMatches, isTreeClean } from "./path-expansion.js";
import { defaultRules, isNpmPackageGet, type CommandRules } from "./command-rules.js";
import { allowPrefixProblem, prefixAllowsProgram } from "./allow-prefix.js";
import { safeByProgramRule, type RuleContext } from "./program-rules.js";
import { isSensitivePath } from "./sensitive-paths.js";
import { npmDependencyFilters, npmDependencyTreeIsSafe } from "./npm-dependencies.js";
import { recognizeShell, type ShellCommand, type ShellRedirect, type ShellWord } from "./shell-syntax.js";
import type { CallgateConfig } from "./types.js";

// Allow rules are prefixes, so allowing a program would otherwise allow
// every option it has. Options that execute other programs or
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
    // prettier-ignore
    prefixes: [
      "--to-command", "--checkpoint-action", "--use-compress-program", "--info-script", "--new-volume-script", "--rsh-command",
      "--extract", "--get", "--create", "--append", "--update", "--concatenate", "--catenate", "--delete",
    ],
    shortLetters: "IFxcruA",
  },
};

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
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      return (
        unsafe.prefixes?.some((option) => name.startsWith(option) || (name.length > 2 && option.startsWith(name))) ??
        false
      );
    }
    // tar also takes old-style option letters without a dash as its first argument.
    const group = arg.startsWith("-") ? arg.slice(1) : program === "tar" && index === 0 ? arg : "";
    return [...(unsafe.shortLetters ?? "")].some((letter) => group.includes(letter));
  });
}

const MAX_SHORT_OPTION_GROUP = 512;

/**
 * The parts of an argument that a program might open as a file: the value of
 * `--name=value`; any tail of a short-option group, since a value can be
 * glued to an option (`-f/path`) and which letters take one depends on the
 * program; otherwise the argument itself. Of each, also every part after an
 * `=`, since a value can itself be `key=path` (`dd if=/path`,
 * `kubectl -o go-template-file=/path`, `--from-file=key=/path`).
 */
function pathCandidates(text: string): string[] | null {
  let candidates: string[];
  if (text.startsWith("--")) {
    const equals = text.indexOf("=");
    candidates = equals < 0 ? [] : [text.slice(equals + 1)];
  } else if (text.startsWith("-")) {
    if (text.length > MAX_SHORT_OPTION_GROUP) {
      return null;
    }
    // Every tail, so the parts after an `=` are among them already.
    return Array.from({ length: Math.max(0, text.length - 2) }, (_, index) => text.slice(index + 2));
  } else {
    candidates = [text];
  }
  const parts: string[] = [];
  for (const candidate of candidates) {
    parts.push(candidate);
    for (let equals = candidate.indexOf("="); equals >= 0; equals = candidate.indexOf("=", equals + 1)) {
      parts.push(candidate.slice(equals + 1));
    }
  }
  return parts;
}

function isInsideReadRoots(absolute: string, roots: ReadRoots): boolean {
  return [roots.cwd, ...roots.extra].some((root) => {
    const relative = relativePathWithin(absolute, root);
    return relative !== null && !isSensitivePath(relative);
  });
}

/**
 * Whether bash expands a leading `~` or `~/` in the word. It does so from
 * the shell's HOME, which an earlier call may have changed, so the plan
 * writes OMP's own home directory in its place (see pinTilde).
 */
function expandsHome(word: ShellWord, check: Check): boolean {
  return word.expands && check.source[word.start] === "~" && (word.text === "~" || word.text.startsWith("~/"));
}

function pinTilde(word: ShellWord, check: Check): void {
  check.pins.push({ start: word.start, end: word.start + 1, text: shellQuote(homedir()) });
}

/**
 * Whether a word that may name a file names nothing outside the workspace or
 * read roots and nothing credential-like. A literal candidate is only treated
 * as a path when it exists, so search patterns such as `/api/users` do not
 * count.
 */
function namesNoUnreadableFile(text: string, place: Place): boolean {
  const candidates = pathCandidates(text);
  return (
    candidates !== null &&
    candidates.every((candidate) => {
      if (!candidate) {
        return true;
      }
      const absolute = resolvePathForCwd(candidate, place.directory);
      return existsSync(absolute)
        ? isInsideReadRoots(absolute, place.roots)
        : canonicalPath(absolute, place.directory) !== null;
    })
  );
}

/**
 * An argument of a command an allow rule matches that names nothing outside the
 * workspace or read roots and nothing credential-like. Arguments the shell
 * expands (unquoted globs, braces, `~user`, `name=~/…`) are not fast-pathed,
 * since their final form is unknown; a leading `~` or `~/` is pinned.
 */
function isAllowedArgumentSafe(word: ShellWord, check: Check): boolean {
  if (!word.expands) {
    return namesNoUnreadableFile(word.text, check.place);
  }
  if (
    !expandsHome(word, check) ||
    /[*?[{]/.test(word.text) ||
    !isInsideReadRoots(`${homedir()}${word.text.slice(1)}`, check.place.roots)
  ) {
    return false;
  }
  pinTilde(word, check);
  return true;
}

function matchesAllowEntry(command: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed || allowPrefixProblem(trimmed)) {
    return false;
  }
  if (trimmed.endsWith("*")) {
    return command.startsWith(trimmed.slice(0, -1));
  }
  return command === trimmed || command.startsWith(`${trimmed} `);
}

function isAllowedByRule(words: ShellWord[], check: Check): boolean {
  // Entries match the command as written, quotes included, without its
  // redirections.
  const written = normalizeCommand(words.map((word) => check.source.slice(word.start, word.end)).join(" "));
  // The parser gives every command a first word.
  const first = itemAt(words, 0);
  const args = words.slice(1);
  const program = programName(first.text);
  const entry = check.rules.rules.find(
    (rule) =>
      rule.outcome === "allow" &&
      rule.prefix !== null &&
      matchesAllowEntry(written, rule.prefix) &&
      prefixAllowsProgram(rule.prefix, program),
  );
  if (
    entry === undefined ||
    first.expands ||
    hasUnsafeOption(
      program,
      args.map((word) => word.text),
    )
  ) {
    return false;
  }
  if (!args.every((word) => isAllowedArgumentSafe(word, check))) {
    return false;
  }
  check.used.push({ id: entry.id, source: entry.source });
  return true;
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
  return (
    redirect.kind === "read" && isInsideReadRoots(resolvePathForCwd(redirect.target, place.directory), place.roots)
  );
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
  const root = canonicalPath(workspace, workspace);
  if (root === null) {
    return null;
  }
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) {
      continue;
    }
    const resolvedDirectory = canonicalPath(directory, workspace);
    if (resolvedDirectory === null || relativePathWithin(resolvedDirectory, root) !== null) {
      continue;
    }
    const candidate = resolvePathForCwd(program, directory);
    try {
      if (!statSync(candidate).isFile()) {
        continue;
      }
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const resolvedCandidate = canonicalPath(candidate, workspace);
    if (resolvedCandidate !== null && relativePathWithin(resolvedCandidate, root) === null) {
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
  if (program?.text !== "cd" || !target || rest.length || command.redirects.length || target.expands) {
    return null;
  }
  return directoryWithin(target.text, place);
}

/** The existing workspace directory `text` names, from `place`, or null. */
function directoryWithin(text: string, place: Place): string | null {
  if (!text || text.startsWith("-")) {
    return null;
  }
  const directory = resolvePathForCwd(text, place.directory);
  // Bash's logical `cd` collapses `..`; a raw filesystem open need not.
  // Do not strip a cd whose two interpretations select different directories.
  const physical = canonicalPath(directory, place.directory);
  const logical = resolve(directory);
  if (physical === null || canonicalPath(logical, place.directory) !== physical) {
    return null;
  }
  try {
    if (!statSync(directory).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return relativePathWithin(directory, place.workspace) === null ? null : logical;
}

/** A command being planned, and the rewrites its plan makes so far. */
interface Check {
  source: string;
  config: CallgateConfig;
  place: Place;
  searchPath: string;
  rules: CommandRules;
  // Text to put in place of `source.slice(start, end)`.
  pins: { start: number; end: number; text: string }[];
  // The rules that let each command through, in order.
  used: { id: string; source: string }[];
}

/**
 * The nearest npm project, without following discovery into an unreviewed
 * parent or guessing implicit workspace membership. npm itself is pinned to
 * this prefix below, so later config cannot redirect package.json reads.
 */
function npmProject(place: Place): string | null {
  const directory = canonicalPath(place.directory, place.directory);
  if (directory === null || directoryWithin(directory, place) === null) {
    return null;
  }
  let project: string | null = null;
  let current = directory;
  // Bound both discovery and the JSON we inspect for workspace declarations.
  for (let depth = 0; depth < 128; depth += 1) {
    const inside = relativePathWithin(current, place.workspace) !== null;
    const manifest = join(current, "package.json");
    try {
      const file = lstatSync(manifest);
      if (!inside || !isInsideReadRoots(manifest, place.roots) || statSync(manifest).size > 1024 * 1024) {
        return null;
      }
      if (!file.isFile() && !file.isSymbolicLink()) {
        return null;
      }
      const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8").replace(/^\uFEFF/, ""));
      if (project !== null && pkg !== null && typeof pkg === "object" && "workspaces" in pkg && pkg.workspaces) {
        return null;
      }
      project ??= current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return null;
      }
      // A dangling manifest link is not an absent manifest.
      try {
        lstatSync(manifest);
        return null;
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") {
          return null;
        }
      }
    }
    if (project === null) {
      try {
        if (statSync(join(current, "node_modules")).isDirectory()) {
          if (!inside) {
            return null;
          }
          project = current;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return null;
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return project ?? directory;
    }
    current = parent;
  }
  return null;
}

function pinNpmInformation(args: ShellWord[], check: Check, place: Place): boolean {
  if (args.some((word) => word.expands)) {
    return false;
  }
  const first = args[0];
  if (args.length === 1 && (first?.text === "--version" || first?.text === "-v")) {
    return true;
  }
  const paths = args.length === 1 && (first?.text === "prefix" || first?.text === "root");
  const get = isNpmPackageGet(args);
  const filters = npmDependencyFilters(args);
  if ((!paths && !get && filters === null) || !first || process.platform === "win32") {
    return false;
  }
  const project = npmProject(place);
  if (project === null) {
    return false;
  }
  if (
    filters !== null &&
    (!filters.every((word) => namesNoUnreadableFile(word.text, place)) ||
      !npmDependencyTreeIsSafe(project, place.workspace))
  ) {
    return false;
  }
  // CLI settings override npmrc/environment defaults. /dev/null is not a
  // directory: cache/log setup and cleanup cannot write through it. npm's
  // installed runtime/config remain trusted, as for the version fast path.
  const options = [
    `--prefix=${project}`,
    "--global=false",
    "--location=project",
    "--workspaces=false",
    "--offline",
    "--no-update-notifier",
    "--cache=/dev/null",
    "--logs-dir=/dev/null",
    "--logs-max=0",
    "--no-timing",
  ];
  if (filters !== null) {
    // npmrc must not switch ls to virtual-tree reads behind the caller's back.
    options.push("--package-lock-only=false");
  }
  check.pins.push({ start: first.start, end: first.start, text: `${options.map(shellQuote).join(" ")} ` });
  return true;
}

/** What a program table may ask about the place a command runs in (see RuleContext). */
function ruleContext(check: Check, place = check.place): RuleContext {
  const readable = (absolute: string) => isInsideReadRoots(absolute, place.roots);
  return {
    directory: place.directory,
    operandPaths(word) {
      const text = word.text;
      if (text === "-") {
        return [];
      }
      if (!word.expands) {
        const absolute = resolvePathForCwd(text, place.directory);
        return readable(absolute) ? [absolute] : null;
      }
      const home = expandsHome(word, check);
      if (word.assignment || (check.source[word.start] === "~" && !home)) {
        return null;
      }
      if (home && !/[*?[{]/.test(text)) {
        const absolute = `${homedir()}${text.slice(1)}`;
        if (!readable(absolute)) {
          return null;
        }
        pinTilde(word, check);
        return [absolute];
      }
      const matches = boundedGlobMatches(text, place.directory, home ? homedir() : undefined);
      // No match at all is reviewed: under nullglob bash would drop the word.
      if (!matches?.length) {
        return null;
      }
      // A match is passed as a separate word; one starting with `-` would be
      // read as an option.
      if (matches.some((match) => match.word.startsWith("-") || !readable(match.absolute))) {
        return null;
      }
      if (home) {
        pinTilde(word, check);
      }
      return matches.map((match) => match.absolute);
    },
    readablePath: (text) => readable(resolvePathForCwd(text, place.directory)),
    matchesNothing: (word) => boundedGlobMatches(word.text, place.directory)?.length === 0,
    treeIsClean: (path, filter) => isTreeClean(path, filter),
    namesNoUnreadableFile: (text) => namesNoUnreadableFile(text, place),
    workspacePath(text) {
      const relative = relativePathWithin(resolvePathForCwd(text, place.directory), place.workspace);
      return relative !== null && !isSensitivePath(relative);
    },
    workspaceDirectory: (text) => directoryWithin(text, place),
    within: (directory) => ruleContext(check, { ...place, directory }),
    command: (words) => isSafeCommand(words, check),
    npmInformation: (args) => pinNpmInformation(args, check, place),
  };
}

/**
 * Whether one simple command is safe on its own, by its program's entry in
 * the command rules or by an allow rule; its program is then
 * pinned (see planSafeCommand).
 */
function isSafeCommand(words: ShellWord[], check: Check): boolean {
  const program = itemAt(words, 0);
  if (program.expands) {
    return false;
  }
  // A failed attempt leaves no rewrites behind.
  const attempt = (safe: () => boolean): boolean => {
    const pins = check.pins.length;
    const used = check.used.length;
    if (safe()) {
      return true;
    }
    check.pins.length = pins;
    check.used.length = used;
    return false;
  };
  const byRule = () => {
    // Recorded after any command it runs (timeout), which records its own.
    const entry = safeByProgramRule(words, ruleContext(check), check.rules);
    if (entry) {
      check.used.push({ id: entry.id, source: entry.source });
    }
    return entry !== null;
  };
  const safe = (!program.text.includes("/") && attempt(byRule)) || attempt(() => isAllowedByRule(words, check));
  return safe && pinProgram(program, check);
}

/**
 * Replace a program named without a path by its absolute path on OMP's
 * startup PATH. One named by a path is kept: bash looks up neither aliases,
 * functions, nor PATH for it.
 */
function pinProgram(word: ShellWord, check: Check): boolean {
  if (word.text.includes("/")) {
    return true;
  }
  const resolved = resolveStartupProgram(word.text, check.place.workspace, check.searchPath);
  if (!resolved) {
    return false;
  }
  check.pins.push({ start: word.start, end: word.end, text: shellQuote(resolved) });
  return true;
}

export interface SafeCommandPlan {
  // The command to run in place of the original: every program named by its
  // absolute path, any leading `cd <dir> &&` removed.
  command: string;
  // The rules that let it through: program entries or allow rules, one per
  // simple command (and per command `timeout` runs).
  rules: { id: string; source: string }[];
  // The directory a leading `cd` moved it to; absent when there was none.
  cwd?: string;
}

/**
 * How to run a bash command that skips review, or null when it must be
 * reviewed.
 *
 * The command must be in the subset recognizeShell reads exactly, and every
 * simple command in it must be safe on its own: by its program's entry in the
 * command rules (config/default-rules.jsonc), or an allow rule
 * whose arguments stay inside the read roots, with only safe redirections
 * (see isSafeRedirect). Rules that failed to load review everything. `&&`,
 * `||`, `;`, newlines, and pipes between them add nothing a command could not
 * do alone.
 *
 * OMP runs every bash call in one persistent shell per session, so an earlier
 * call may have defined an alias or function with a program's name, put a
 * workspace directory on PATH, or set CDPATH. Each program is therefore
 * replaced by its absolute path from OMP's startup PATH; one already named by
 * a path is kept as written, since bash looks up neither aliases, functions,
 * nor PATH for it. Leading `cd <dir> &&` (or `;`) commands are not run in the shell at
 * all: the plan runs the rest in that directory through the call's `cwd`,
 * which OMP applies itself.
 */
export function planSafeCommand(
  command: string,
  config: CallgateConfig,
  options: { workspace: string; cwd?: string; searchPath?: string; rules?: CommandRules },
): SafeCommandPlan | null {
  const rules = options.rules ?? defaultRules();
  const script = rules.problem ? null : recognizeShell(command);
  if (!script) {
    return null;
  }
  const place: Place = {
    workspace: options.workspace,
    directory: options.cwd ?? options.workspace,
    roots: resolveReadRoots(options.workspace, config.readRoots),
  };
  let first = 0;
  // After `cd <dir>;` the rest runs even if cd fails; the directory is known
  // to exist, and OMP fails the call rather than run it elsewhere.
  while (
    first < script.pipelines.length - 1 &&
    script.connectors[first] !== "||" &&
    itemAt(script.pipelines, first).length === 1
  ) {
    const directory = cdTarget(itemAt(itemAt(script.pipelines, first), 0), place);
    if (directory === null) {
      break;
    }
    place.directory = directory;
    first += 1;
  }
  const commands = script.pipelines.slice(first).flat();
  const check: Check = {
    source: command,
    config,
    place,
    searchPath: options.searchPath ?? STARTUP_PATH,
    rules,
    pins: [],
    used: [],
  };
  for (const shellCommand of commands) {
    if (!shellCommand.redirects.every((redirect) => isSafeRedirect(redirect, place))) {
      return null;
    }
    if (!isSafeCommand(shellCommand.words, check)) {
      return null;
    }
  }
  let pinned = command;
  for (const { start, end, text } of [...check.pins].sort((a, b) => b.start - a.start)) {
    pinned = `${pinned.slice(0, start)}${text}${pinned.slice(end)}`;
  }
  return first === 0
    ? { command: pinned, rules: check.used }
    : { command: pinned.slice(itemAt(commands, 0).start), cwd: place.directory, rules: check.used };
}
