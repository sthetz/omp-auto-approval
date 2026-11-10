import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionRoot } from "./extension-config.js";
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
    throw new RulesError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(object: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new RulesError(`${where}: unknown key "${key}"`);
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
  context: { subcommand: boolean; inheritedExcept: string[] },
): ProgramEntry {
  const object = record(value, where);
  onlyKeys(object, ["options", "except", "operands", "arguments", "subcommands", "stopAtOperand", "opensNoFiles"], where);
  const hasSubcommands = object.subcommands !== undefined;
  if (hasSubcommands && context.subcommand) {
    throw new RulesError(`${where}: subcommands cannot have subcommands`);
  }
  const entry: ProgramEntry = {
    id,
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
        entry.subcommands.set(name, compileEntry(sub, `${id} ${name}`, subWhere, { subcommand: true, inheritedExcept: entry.except }));
      }
    }
  } else {
    if (object.operands === undefined) {
      throw new RulesError(`${where}: missing "operands"`);
    }
    entry.operands = compileOperands(object.operands, `${where}.operands`);
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
export function compileRules(raw: unknown): Map<string, ProgramEntry> {
  const top = record(raw, "file");
  onlyKeys(top, ["$schema", "programs"], "file");
  const programs = new Map<string, ProgramEntry>();
  for (const [key, entry] of Object.entries(record(top.programs ?? {}, "programs"))) {
    const where = `programs[${JSON.stringify(key)}]`;
    const [name, ...extra] = names(key, PROGRAM_NAME, where);
    if (extra.length) {
      throw new RulesError(`${where}: one program per entry`);
    }
    programs.set(name, compileEntry(entry, `program:${name}`, where, { subcommand: false, inheritedExcept: [] }));
  }
  return programs;
}

/** Read and compile a rules file; never throws. */
export function loadRulesFile(path: string, label = path): CommandRules {
  try {
    return { programs: compileRules(parseJsonc(readFileSync(path, "utf8"))), problem: null };
  } catch (error) {
    return { programs: new Map(), problem: `${label}: ${(error as Error).message}` };
  }
}

export function defaultRulesPath(): string {
  return join(extensionRoot(), "config", "default-rules.jsonc");
}

let defaults: CommandRules | undefined;

/** The built-in rules, read once. */
export function defaultRules(): CommandRules {
  defaults ??= loadRulesFile(defaultRulesPath(), "config/default-rules.jsonc");
  return defaults;
}
