import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { configPath, extensionRoot } from "./extension-config.js";
import { parseJsonc } from "./jsonc.js";

/**
 * Command rules: which programs, options and operands the bash fast path
 * accepts without review. The built-in rules are data, in
 * config/default-rules.jsonc, so they can be read and reviewed on their own;
 * this module reads and validates such a file and compiles it for
 * src/program-rules.ts, which applies it.
 *
 * Validation is strict: an unknown key, kind, or check name is an error, and
 * a file with any error is not used at all. Callers then review every bash
 * command (see planSafeCommand), since dropping part of a file could
 * silently loosen what the rest of it means.
 */

export type ValueKind =
  // Any text, never opened as a file.
  | "string"
  // A count or size: digits, an optional sign and unit suffix.
  | "number"
  // A file the program reads, checked against the read roots.
  | "read-file"
  // A value only when glued to the option (`--color=auto`, `-Iseconds`).
  | "optional"
  // Two following words (`jq --arg name value`).
  | "pair"
  // A directory inside the workspace that the rest of the command runs
  // from (`git -C dir`).
  | "workspace-directory";

export type OptionKind = ValueKind | "flag";

/** Named checks of a command's operands, with the parameters each takes. */
export const OPERAND_CHECKS = {
  // Files the program reads.
  "read-files": ["min", "max"],
  // Words that are not files, never expanded by the shell, optionally matching a pattern.
  "literals": ["min", "max", "pattern"],
  // No operands at all.
  "none": [],
  // Any operands; for programs that open no files and take literal words.
  "any": [],
  // printf's format, which must not start with `-`, then its arguments.
  "printf-format": [],
  // grep's pattern (unless -e or -f gave it), then files and directories it searches.
  "grep-operands": [],
  // diff's two files or directories, or any with --from-file / --to-file.
  "diff-operands": [],
  // A sed script without file, program or branching commands, then files it reads.
  "sed-script": [],
  // A jq filter that reads neither the environment nor modules, then files it reads.
  "jq-filter": [],
  // A duration, then a command that must be safe on its own (timeout).
  "duration-then-command": [],
  // Git revisions and paths, all inside the workspace.
  "git-operands": [],
  // git-operands, and branches are only listed.
  "git-branch-list": [],
  // git-operands, and tags are only listed.
  "git-tag-list": [],
  // git-operands, and remotes are only listed or their URL printed.
  "git-remote": [],
  // git-operands, and stashes are only listed or shown.
  "git-stash-list": [],
} as const;

export type OperandCheckName = keyof typeof OPERAND_CHECKS;

/** How a program's arguments are split into options and operands. */
export const ARGUMENT_PARSERS = [
  // By the entry's option table, as GNU getopt_long reads them (the default).
  "options",
  // find: starting points, then an expression of known tests.
  "find-expression",
  // Every argument an operand, none expanded by the shell (echo).
  "literal-words",
] as const;

export type ArgumentParser = (typeof ARGUMENT_PARSERS)[number];

export interface OperandRule {
  check: OperandCheckName;
  min: number;
  max: number;
  pattern: RegExp | null;
}

/** One program or subcommand entry, compiled. */
export interface ProgramEntry {
  // `program:<name>`, or `program:<name> <subcommand>`.
  id: string;
  // The file it came from: "default", a user rules file, or both when a
  // user entry extends the default one.
  source: string;
  arguments: ArgumentParser;
  // `"options": "any"`: every word starting with `-` is an option, except
  // those in `except`, and every other word an operand.
  anyOptions: boolean;
  // Options never accepted: long names also by abbreviation or extension,
  // short letters anywhere in a group. Inherited by subcommands.
  except: string[];
  // Short options without a value, and with one, by letter.
  flags: string;
  values: Record<string, ValueKind>;
  // Long options without a value, and with one, by name.
  long: string[];
  longValues: Record<string, ValueKind>;
  // Short letters reported by their long name.
  aliases: Record<string, string>;
  // Accepts `-20` as an option (head, tail, grep context).
  numeric: boolean;
  // Option parsing stops at the first operand (getopt's leading `+`).
  stopAtOperand: boolean;
  // Never opens a file named by its arguments.
  opensNoFiles: boolean;
  // Null for a program with subcommands.
  operands: OperandRule | null;
  // By subcommand name; null when the program has none.
  subcommands: Map<string, ProgramEntry> | null;
}

export interface CommandRules {
  programs: Map<string, ProgramEntry>;
  // The user rules files, the main one first, as their paths are written;
  // empty when there is none.
  files: string[];
  // Why the rules could not be used; when set, `programs` is empty and every
  // bash command is reviewed.
  problem: string | null;
}

class RulesError extends Error {}

const PROGRAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const SUBCOMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHORT_OPTION = /^-[A-Za-z0-9]$/;
const LONG_OPTION = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const VALUE_KINDS = new Set<string>(["flag", "string", "number", "read-file", "optional", "pair", "workspace-directory"]);
// Global options of a program with subcommands are whole words, so only
// kinds that are a flag or take the next word fit.
const GLOBAL_KINDS = new Set<string>(["flag", "string", "number", "read-file", "workspace-directory"]);

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RulesError(`${where ? `${where}: ` : ""}expected an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(object: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new RulesError(`${where ? `${where}: ` : ""}unknown key "${key}"`);
    }
  }
}

function boolean(value: unknown, where: string): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new RulesError(`${where}: expected true or false`);
  }
  return value;
}

function names(key: string, pattern: RegExp, where: string): string[] {
  const list = key.split(/\s+/).filter(Boolean);
  if (!list.length) {
    throw new RulesError(`${where}: empty name`);
  }
  for (const name of list) {
    if (!pattern.test(name)) {
      throw new RulesError(`${where}: invalid name "${name}"`);
    }
  }
  return list;
}

function count(value: unknown, fallback: number, where: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RulesError(`${where}: expected a whole number of at least 0`);
  }
  return value;
}

function compileOperands(value: unknown, where: string): OperandRule {
  let name: string;
  let parameters: Record<string, unknown> = {};
  if (typeof value === "string") {
    name = value;
  } else {
    const object = record(value, where);
    const keys = Object.keys(object);
    if (keys.length !== 1) {
      throw new RulesError(`${where}: expected a check name, or an object with one check name as its key`);
    }
    name = keys[0];
    parameters = record(object[name], `${where}.${name}`);
  }
  if (!Object.hasOwn(OPERAND_CHECKS, name)) {
    throw new RulesError(`${where}: unknown check "${name}"`);
  }
  const check = name as OperandCheckName;
  onlyKeys(parameters, [...OPERAND_CHECKS[check]], `${where}.${name}`);
  const min = count(parameters.min, 0, `${where}.${name}.min`);
  const max = count(parameters.max, Infinity, `${where}.${name}.max`);
  if (min > max) {
    throw new RulesError(`${where}.${name}: min is more than max`);
  }
  let pattern: RegExp | null = null;
  if (parameters.pattern !== undefined) {
    if (typeof parameters.pattern !== "string") {
      throw new RulesError(`${where}.${name}.pattern: expected a regular expression in a string`);
    }
    try {
      pattern = new RegExp(parameters.pattern);
    } catch (error) {
      throw new RulesError(`${where}.${name}.pattern: ${(error as Error).message}`);
    }
  }
  return { check, min, max, pattern };
}

function compileEntry(
  value: unknown,
  id: string,
  where: string,
  context: { subcommand: boolean; inheritedExcept: string[]; source: string; sources: ReadonlyMap<string, string> },
): ProgramEntry {
  const object = record(value, where);
  onlyKeys(object, ["options", "except", "operands", "arguments", "subcommands", "stopAtOperand", "opensNoFiles"], where);
  const hasSubcommands = object.subcommands !== undefined;
  if (hasSubcommands && context.subcommand) {
    throw new RulesError(`${where}: subcommands cannot have subcommands`);
  }
  const entry: ProgramEntry = {
    id,
    source: context.sources.get(id) ?? context.source,
    arguments: "options",
    anyOptions: false,
    except: [...context.inheritedExcept],
    flags: "",
    values: Object.create(null),
    long: [],
    longValues: Object.create(null),
    aliases: Object.create(null),
    numeric: false,
    stopAtOperand: boolean(object.stopAtOperand, `${where}.stopAtOperand`),
    opensNoFiles: boolean(object.opensNoFiles, `${where}.opensNoFiles`),
    operands: null,
    subcommands: null,
  };

  if (object.arguments !== undefined) {
    if (typeof object.arguments !== "string" || !(ARGUMENT_PARSERS as readonly string[]).includes(object.arguments)) {
      throw new RulesError(`${where}.arguments: expected one of ${ARGUMENT_PARSERS.join(", ")}`);
    }
    entry.arguments = object.arguments as ArgumentParser;
    if (entry.arguments !== "options" && (object.options !== undefined || entry.stopAtOperand)) {
      throw new RulesError(`${where}: "arguments": "${entry.arguments}" reads options itself; remove "options" and "stopAtOperand"`);
    }
  }

  if (object.options === "any") {
    if (!context.subcommand) {
      throw new RulesError(`${where}.options: "any" is only supported for subcommands`);
    }
    entry.anyOptions = true;
  } else if (object.options !== undefined) {
    compileOptions(record(object.options, `${where}.options`), entry, `${where}.options`, hasSubcommands);
  }

  if (object.except !== undefined) {
    if (!entry.anyOptions && !hasSubcommands) {
      throw new RulesError(`${where}.except: only for "options": "any", or a program with subcommands`);
    }
    if (!Array.isArray(object.except)) {
      throw new RulesError(`${where}.except: expected a list of options`);
    }
    for (const option of object.except) {
      if (typeof option !== "string" || !(SHORT_OPTION.test(option) || LONG_OPTION.test(option))) {
        throw new RulesError(`${where}.except: expected options like "-x" or "--name", got ${JSON.stringify(option)}`);
      }
      entry.except.push(option);
    }
  }

  if (hasSubcommands) {
    if (object.operands !== undefined || object.arguments !== undefined || entry.stopAtOperand) {
      throw new RulesError(`${where}: a program with subcommands takes no "operands", "arguments" or "stopAtOperand"`);
    }
    const subcommands = record(object.subcommands, `${where}.subcommands`);
    entry.subcommands = new Map();
    for (const [key, sub] of Object.entries(subcommands)) {
      const subWhere = `${where}.subcommands[${JSON.stringify(key)}]`;
      for (const name of names(key, SUBCOMMAND_NAME, subWhere)) {
        if (entry.subcommands.has(name)) {
          throw new RulesError(`${subWhere}: subcommand "${name}" is listed twice`);
        }
        entry.subcommands.set(name, compileEntry(sub, `${id} ${name}`, subWhere, {
          subcommand: true,
          inheritedExcept: entry.except,
          source: entry.source,
          sources: context.sources,
        }));
      }
    }
  } else {
    if (object.operands === undefined) {
      throw new RulesError(`${where}: missing "operands"`);
    }
    entry.operands = compileOperands(object.operands, `${where}.operands`);
    // The inner command's own options must reach its check: getopt would
    // otherwise take `timeout 5 sort -o out` as an outer -o.
    if (entry.operands.check === "duration-then-command" && (!entry.stopAtOperand || entry.anyOptions || entry.arguments !== "options")) {
      throw new RulesError(`${where}: "duration-then-command" needs "stopAtOperand": true and an option table`);
    }
  }
  return entry;
}

function compileOptions(options: Record<string, unknown>, entry: ProgramEntry, where: string, global: boolean): void {
  const seen = new Set<string>();
  for (const [key, kind] of Object.entries(options)) {
    const optionWhere = `${where}[${JSON.stringify(key)}]`;
    if (typeof kind !== "string" || !VALUE_KINDS.has(kind)) {
      throw new RulesError(`${optionWhere}: unknown kind ${JSON.stringify(kind)}`);
    }
    if (global ? !GLOBAL_KINDS.has(kind) : kind === "workspace-directory") {
      throw new RulesError(`${optionWhere}: "${kind}" is not supported ${global ? "before a subcommand" : "here"}`);
    }
    if (key === "-NUM") {
      if (kind !== "number" || global) {
        throw new RulesError(`${optionWhere}: "-NUM" is a number option of a program without subcommands`);
      }
      entry.numeric = true;
      continue;
    }
    const list = names(key, /^(-[A-Za-z0-9]|--[A-Za-z0-9][A-Za-z0-9-]*)$/, optionWhere);
    const longs = list.filter((name) => name.startsWith("--")).map((name) => name.slice(2));
    const shorts = list.filter((name) => !name.startsWith("--")).map((name) => name.slice(1));
    if (kind === "pair" && shorts.length) {
      throw new RulesError(`${optionWhere}: "pair" options must be long`);
    }
    for (const name of list) {
      if (seen.has(name)) {
        throw new RulesError(`${optionWhere}: "${name}" is listed twice`);
      }
      seen.add(name);
    }
    const reported = longs[0] ?? shorts[0];
    for (const letter of shorts) {
      if (kind === "flag") {
        entry.flags += letter;
      } else {
        entry.values[letter] = kind as ValueKind;
      }
      if (reported !== letter) {
        entry.aliases[letter] = reported;
      }
    }
    for (const name of longs) {
      if (kind === "flag") {
        entry.long.push(name);
      } else {
        entry.longValues[name] = kind as ValueKind;
      }
    }
  }
}

/** Compile the contents of a rules file; throws with the place of the first problem. */
export function compileRules(raw: unknown, sources: ReadonlyMap<string, string> = new Map()): Map<string, ProgramEntry> {
  const top = record(raw, "");
  onlyKeys(top, ["$schema", "programs"], "");
  const programs = new Map<string, ProgramEntry>();
  for (const [key, entry] of Object.entries(record(top.programs ?? {}, "programs"))) {
    const where = `programs[${JSON.stringify(key)}]`;
    const [name, ...extra] = names(key, PROGRAM_NAME, where);
    if (extra.length) {
      throw new RulesError(`${where}: one program per entry`);
    }
    programs.set(name, compileEntry(entry, `program:${name}`, where, { subcommand: false, inheritedExcept: [], source: "default", sources }));
  }
  return programs;
}

/** Read and compile a rules file; never throws. */
export function loadRulesFile(path: string, label = path): CommandRules {
  try {
    return { programs: compileRules(parseJsonc(readFileSync(path, "utf8"))), files: [], problem: null };
  } catch (error) {
    return { programs: new Map(), files: [], problem: `${label}: ${(error as Error).message}` };
  }
}

export function defaultRulesPath(): string {
  return join(extensionRoot(), "config", "default-rules.jsonc");
}

/** The user's rules file: PI_AUTO_APPROVAL_RULES_PATH, else rules.jsonc next to config.jsonc. */
export function userRulesPath(): string {
  return process.env.PI_AUTO_APPROVAL_RULES_PATH?.trim() || join(dirname(configPath()), "rules.jsonc");
}

let defaults: { rules: CommandRules; document: Record<string, unknown> | null } | undefined;

function loadDefaults(): { rules: CommandRules; document: Record<string, unknown> | null } {
  if (!defaults) {
    try {
      const document = record(parseJsonc(readFileSync(defaultRulesPath(), "utf8")), "");
      defaults = { rules: { programs: compileRules(document), files: [], problem: null }, document };
    } catch (error) {
      defaults = { rules: { programs: new Map(), files: [], problem: `config/default-rules.jsonc: ${(error as Error).message}` }, document: null };
    }
  }
  return defaults;
}

/** The built-in rules, read once. */
export function defaultRules(): CommandRules {
  return loadDefaults().rules;
}

// User rules files hold at most this many levels of `include`.
const MAX_INCLUDE_DEPTH = 8;
const RULE_ID = /^program:([A-Za-z0-9_][A-Za-z0-9._+-]*)(?: ([A-Za-z0-9][A-Za-z0-9._:-]*))?$/;

interface UserLayer {
  // Program entries as written, with the file each came from.
  programs: Map<string, { entry: Record<string, unknown>; file: string }>;
  disable: { id: string; file: string }[];
  files: string[];
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Read one user rules file and the files it includes into `layer`. */
function readUserFile(path: string, layer: UserLayer, chain: string[]): void {
  const label = displayPath(path);
  // Recorded before reading, so that a file that is missing or broken is
  // still protected from the write fast path and shown in status.
  if (!layer.files.includes(path)) {
    layer.files.push(path);
  }
  let canonical: string;
  let document: Record<string, unknown>;
  try {
    canonical = realpathSync(path);
    document = record(parseJsonc(readFileSync(canonical, "utf8")), "");
  } catch (error) {
    throw new RulesError(`${label}: ${(error as Error).message}`);
  }
  if (chain.includes(canonical)) {
    throw new RulesError(`${label}: includes itself through ${chain.map(displayPath).join(" → ")}`);
  }
  if (chain.length > MAX_INCLUDE_DEPTH) {
    throw new RulesError(`${label}: more than ${MAX_INCLUDE_DEPTH} levels of include`);
  }
  const fail = (message: string): never => {
    throw new RulesError(`${label}: ${message}`);
  };
  try {
    onlyKeys(document, ["$schema", "include", "programs", "disable"], "");
  } catch (error) {
    fail((error as Error).message);
  }
  const includes = document.include ?? [];
  if (!Array.isArray(includes)) {
    fail("include: expected a list of paths");
  }
  for (const include of includes as unknown[]) {
    if (typeof include !== "string" || !(isAbsolute(include) || include.startsWith("~/"))) {
      fail(`include: expected an absolute path or one starting with ~/, got ${JSON.stringify(include)}`);
    }
    const target = (include as string).startsWith("~/") ? join(homedir(), (include as string).slice(2)) : include as string;
    readUserFile(target, layer, [...chain, canonical]);
  }
  const disable = document.disable ?? [];
  if (!Array.isArray(disable)) {
    fail("disable: expected a list of rule ids");
  }
  for (const id of disable as unknown[]) {
    if (typeof id !== "string" || !RULE_ID.test(id)) {
      fail(`disable: expected ids like "program:sed" or "program:git blame", got ${JSON.stringify(id)}`);
    }
    if (!layer.disable.some((earlier) => earlier.id === id)) {
      layer.disable.push({ id: id as string, file: label });
    }
  }
  let programs: Record<string, unknown> = {};
  try {
    programs = record(document.programs ?? {}, "programs");
  } catch (error) {
    fail((error as Error).message);
  }
  for (const [name, entry] of Object.entries(programs)) {
    const where = `programs[${JSON.stringify(name)}]`;
    if (entry === null) {
      fail(`${where}: to turn off a built-in program, list "program:${name}" in "disable"`);
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${where}: expected an object`);
    }
    const earlier = layer.programs.get(name);
    if (earlier) {
      fail(`${where}: also defined in ${earlier.file}; define each program in one file`);
    }
    layer.programs.set(name, { entry: entry as Record<string, unknown>, file: label });
  }
}

/** Subcommands by single name, as compileEntry reads grouped keys. */
function subcommandsByName(value: unknown, where: string): Map<string, unknown> {
  const byName = new Map<string, unknown>();
  for (const [key, entry] of Object.entries(record(value, where))) {
    for (const name of names(key, SUBCOMMAND_NAME, `${where}[${JSON.stringify(key)}]`)) {
      byName.set(name, entry);
    }
  }
  return byName;
}

function mergeOptions(base: Record<string, unknown>, user: Record<string, unknown>, where: string): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, kind] of Object.entries(user)) {
    if (kind !== null) {
      merged[key] = kind;
    } else if (Object.hasOwn(merged, key)) {
      delete merged[key];
    } else {
      // Deleting by part of a grouped key would be ambiguous.
      const tokens = key.split(/\s+/);
      const group = Object.keys(base).find((other) => other.split(/\s+/).some((token) => tokens.includes(token)));
      throw new RulesError(`${where}[${JSON.stringify(key)}]: no such option in the default entry${group ? `; it lists ${JSON.stringify(group)}` : ""}`);
    }
  }
  return merged;
}

/**
 * A user entry that says `"extends": "default"`, merged into the default
 * one: `options` and `subcommands` key by key, where `null` deletes a
 * default key; `except` lists are joined, and `"except": null` drops the
 * default one; any other key the user gives replaces the default.
 */
function mergeEntry(base: Record<string, unknown>, user: Record<string, unknown>, where: string, id: string, file: string, sources: Map<string, string>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(user)) {
    if (key === "extends") {
      continue;
    }
    if (value === null) {
      if (!Object.hasOwn(base, key)) {
        throw new RulesError(`${where}.${key}: the default entry has none to delete`);
      }
      delete merged[key];
    } else if (key === "options" && typeof value === "object" && typeof base.options === "object" && base.options !== null) {
      merged.options = mergeOptions(record(base.options, `${where}.options`), record(value, `${where}.options`), `${where}.options`);
    } else if (key === "except" && Array.isArray(value) && Array.isArray(base.except)) {
      merged.except = [...base.except, ...value.filter((option) => !(base.except as unknown[]).includes(option))];
    } else if (key === "subcommands" && base.subcommands !== undefined) {
      const subcommands = subcommandsByName(base.subcommands, `${where}.subcommands`);
      for (const [userKey, entry] of Object.entries(record(value, `${where}.subcommands`))) {
        const subWhere = `${where}.subcommands[${JSON.stringify(userKey)}]`;
        for (const name of names(userKey, SUBCOMMAND_NAME, subWhere)) {
          const existing = subcommands.get(name);
          if (entry === null) {
            if (existing === undefined) {
              throw new RulesError(`${subWhere}: the default entry has no subcommand "${name}"`);
            }
            subcommands.delete(name);
            continue;
          }
          const userEntry = record(entry, subWhere);
          sources.set(`${id} ${name}`, file);
          if (userEntry.extends === undefined) {
            subcommands.set(name, userEntry);
          } else if (userEntry.extends !== "default" || existing === undefined) {
            throw new RulesError(`${subWhere}.extends: only "default", for a subcommand the default entry has`);
          } else {
            sources.set(`${id} ${name}`, `default, ${file}`);
            subcommands.set(name, mergeEntry(record(existing, subWhere), userEntry, subWhere, `${id} ${name}`, file, sources));
          }
        }
      }
      merged.subcommands = Object.fromEntries(subcommands);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Reject `extends` in a user entry that has nothing to extend. */
function noExtends(entry: Record<string, unknown>, where: string): void {
  if (entry.extends !== undefined) {
    throw new RulesError(`${where}.extends: only "default", for a program or subcommand the defaults have`);
  }
  if (entry.subcommands && typeof entry.subcommands === "object") {
    for (const [key, sub] of Object.entries(entry.subcommands)) {
      if (sub && typeof sub === "object" && (sub as Record<string, unknown>).extends !== undefined) {
        throw new RulesError(`${where}.subcommands[${JSON.stringify(key)}].extends: only "default", for a subcommand the defaults have`);
      }
    }
  }
}

/**
 * The built-in rules with the user's rules file over them (see
 * userRulesPath). A user entry for a program replaces the built-in one, or
 * merges into it with `"extends": "default"`; `disable` removes built-in
 * entries by id. With no user file, the built-in rules alone. Any problem
 * in any file means no rules at all (see CommandRules.problem). Never throws.
 */
export function loadCommandRules(path = userRulesPath()): CommandRules {
  const { rules: base, document } = loadDefaults();
  if (base.problem || !document) {
    return base;
  }
  // Only a path with nothing at all there means no user file: a dangling
  // symbolic link is an error, not a reason to drop the user's rules.
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return base;
    }
  }
  const layer: UserLayer = { programs: new Map(), disable: [], files: [] };
  try {
    readUserFile(path, layer, []);
    // Without a prototype, so that a program named `__proto__` is just a name.
    const programs: Record<string, unknown> = Object.assign(Object.create(null), record(document.programs ?? {}, "programs"));
    for (const { id, file } of layer.disable) {
      const [, name, subcommand] = RULE_ID.exec(id)!;
      const entry = Object.hasOwn(programs, name) ? record(programs[name], name) : undefined;
      if (!entry) {
        throw new RulesError(`${file}: disable: no built-in rule "${id}"`);
      }
      if (subcommand === undefined) {
        delete programs[name];
        continue;
      }
      const subcommands = entry.subcommands === undefined ? undefined : subcommandsByName(entry.subcommands, id);
      if (!subcommands?.delete(subcommand)) {
        throw new RulesError(`${file}: disable: no built-in rule "${id}"`);
      }
      programs[name] = { ...entry, subcommands: Object.fromEntries(subcommands) };
    }
    const sources = new Map<string, string>();
    for (const [name, { entry, file }] of layer.programs) {
      const where = `${file}: programs[${JSON.stringify(name)}]`;
      const id = `program:${name}`;
      if (entry.extends === undefined) {
        noExtends(entry, where);
        programs[name] = entry;
        sources.set(id, file);
      } else if (entry.extends !== "default" || !Object.hasOwn(programs, name)) {
        throw new RulesError(`${where}.extends: only "default", for a program the defaults have${Object.hasOwn(record(document.programs, "programs"), name) ? " (this one is disabled)" : ""}`);
      } else {
        sources.set(id, `default, ${file}`);
        programs[name] = mergeEntry(record(programs[name], where), entry, where, id, file, sources);
      }
    }
    // Errors from here on are in the merged entries; name the user file.
    try {
      return { programs: compileRules({ programs }, sources), files: layer.files, problem: null };
    } catch (error) {
      throw new RulesError(`${displayPath(path)}${layer.files.length > 1 ? " (or a file it includes)" : ""}: ${(error as Error).message}`);
    }
  } catch (error) {
    return { programs: new Map(), files: layer.files, problem: (error as Error).message };
  }
}
