import { defaultRules, type CommandRules, type OperandCheckName, type OperandRule, type OptionKind, type ProgramEntry } from "./command-rules.js";
import type { FileFilter } from "./path-expansion.js";
import { isSensitivePath } from "./sensitive-paths.js";
import type { ShellWord } from "./shell-syntax.js";

/**
 * Applies the command rules (layer 2 of the bash fast path): whether one
 * simple command is read-only by its program's entry in
 * config/default-rules.jsonc. Each entry lists the options a program may be
 * given without review; anything else, including an option that is merely
 * unknown, sends the command to review. The checks an entry names for its
 * operands are here, in OPERAND_CHECK_FUNCTIONS.
 *
 * Where operands are files, the caller decides whether they may be read
 * (see RuleContext).
 */

export interface ParsedOption {
  // The long name without dashes, or the short letter; a short letter that
  // shares an entry with a long name is reported by the long one.
  name: string;
  kind: OptionKind;
  value?: string;
  // The word holding the option, which bash may rewrite if it expands.
  word: ShellWord;
}

export interface ParsedCommand {
  options: ParsedOption[];
  operands: ShellWord[];
}

export interface RuleContext {
  // The directory the command runs in, absolute.
  directory: string;
  // The absolute paths an operand can name, all of them readable without
  // review, or null. A glob gives every file it could match; `-` (stdin)
  // gives none.
  operandPaths(word: ShellWord): string[] | null;
  // Whether an option's literal path value is readable without review.
  readablePath(text: string): boolean;
  // Whether no file matches the word as a glob, so bash passes it on as
  // written (or drops it, under nullglob).
  matchesNothing(word: ShellWord): boolean;
  // Whether reading the tree under an absolute path recursively surely
  // reads nothing credential-like.
  treeIsClean(path: string, filter?: FileFilter): boolean;
  // Whether a word that may name a file, in any part a program could open
  // (`--opt=path`, `-fpath`), names nothing it may not read.
  namesNoUnreadableFile(text: string): boolean;
  // Whether a path, from the directory, stays inside the workspace and away
  // from credential-like files.
  workspacePath(text: string): boolean;
  // The existing workspace directory a path names, or null.
  workspaceDirectory(text: string): string | null;
  // The same context, for a command that runs in another directory.
  within(directory: string): RuleContext;
  // Whether a command that this one runs (`timeout 5 git status`) is safe
  // on its own; its program is then pinned like the outer one.
  command(words: ShellWord[]): boolean;
}

// The parts of an entry that option parsing reads.
type OptionTable = Pick<ProgramEntry, "flags" | "values" | "long" | "longValues" | "aliases" | "numeric" | "stopAtOperand">;

const NUMBER = /^[+-]?\d+(\.\d+)?[A-Za-z]{0,3}$/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

function words(list: string): string[] {
  return list.split(/\s+/).filter(Boolean);
}

/**
 * The options and operands of a command by GNU getopt_long's rules: options
 * anywhere unless `stopAtOperand`, `--` ends them, short options group, a
 * value is glued or the next word, and long options are exact (an
 * abbreviation could resolve to an option missing from the table).
 */
export function parseOptions(spec: OptionTable, words: ShellWord[]): ParsedCommand | null {
  const options: ParsedOption[] = [];
  const operands: ShellWord[] = [];
  let endOfOptions = false;
  const valueWord = (index: number): ShellWord | null => {
    const next = words[index];
    return next && !next.expands ? next : null;
  };
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    const text = word.text;
    if (endOfOptions || text === "-" || !text.startsWith("-")) {
      operands.push(word);
      endOfOptions ||= spec.stopAtOperand === true;
      continue;
    }
    if (text === "--") {
      endOfOptions = true;
      continue;
    }
    // A word bash may rewrite can only be a self-contained `--name=value`,
    // so that dropping or replacing it moves no other word.
    if (word.expands && !(text.startsWith("--") && text.includes("="))) {
      return null;
    }
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const name = equals < 0 ? text.slice(2) : text.slice(2, equals);
      if (spec.long?.includes(name)) {
        if (equals >= 0) {
          return null;
        }
        options.push({ name, kind: "flag", word });
        continue;
      }
      const kind = spec.longValues?.[name];
      if (!kind) {
        return null;
      }
      if (kind === "optional") {
        options.push({ name, kind, value: equals < 0 ? undefined : text.slice(equals + 1), word });
        continue;
      }
      if (kind === "pair") {
        const first = valueWord(index + 1);
        const second = valueWord(index + 2);
        if (equals >= 0 || !first || !second) {
          return null;
        }
        options.push({ name, kind, value: second.text, word });
        index += 2;
        continue;
      }
      let value = equals < 0 ? undefined : text.slice(equals + 1);
      if (value === undefined) {
        const next = valueWord(index + 1);
        if (!next) {
          return null;
        }
        value = next.text;
        index += 1;
      }
      options.push({ name, kind, value, word });
      continue;
    }
    for (let position = 1; position < text.length; position += 1) {
      const letter = text[position];
      if (spec.numeric && /[0-9]/.test(letter)) {
        const digits = /^[0-9]+/.exec(text.slice(position))![0];
        options.push({ name: "#", kind: "number", value: digits, word });
        position += digits.length - 1;
        continue;
      }
      const name = spec.aliases?.[letter] ?? letter;
      if (spec.flags?.includes(letter)) {
        options.push({ name, kind: "flag", word });
        continue;
      }
      const kind = spec.values?.[letter];
      if (!kind || kind === "pair") {
        return null;
      }
      const rest = text.slice(position + 1);
      if (kind === "optional") {
        options.push({ name, kind, value: rest || undefined, word });
        break;
      }
      let value = rest;
      if (!value) {
        const next = valueWord(index + 1);
        if (!next) {
          return null;
        }
        value = next.text;
        index += 1;
      }
      options.push({ name, kind, value, word });
      break;
    }
  }
  return { options, operands };
}

function has(command: ParsedCommand, ...names: string[]): boolean {
  return command.options.some((option) => names.includes(option.name));
}

function readsFiles(command: ParsedCommand, context: RuleContext, operands = command.operands): string[] | null {
  const paths: string[] = [];
  for (const operand of operands) {
    const named = context.operandPaths(operand);
    if (!named) {
      return null;
    }
    paths.push(...named);
  }
  return paths;
}

/**
 * Whether a recursive search of `paths` reads only clean trees. With no file
 * operand, or one that bash may drop (a glob, under nullglob), the search
 * covers the working directory too.
 */
function recursiveReadIsClean(command: ParsedCommand, context: RuleContext, operands: ShellWord[], paths: string[], filter?: FileFilter): boolean {
  const roots = !operands.length || operands.some((word) => word.expands) ? [...paths, context.directory] : paths;
  return roots.every((path) => context.treeIsClean(path, filter));
}

/**
 * --include, --exclude and --exclude-dir as far as they surely apply. A
 * filter bash may rewrite or drop (an unquoted glob) could be any filter, so
 * then --include narrows nothing and that --exclude-dir is ignored.
 */
function grepFilter(command: ParsedCommand): FileFilter {
  const fileFilters = command.options.filter((option) => option.name === "include" || option.name === "exclude");
  return {
    include: fileFilters.filter((option) => option.name === "include").map((option) => option.value ?? ""),
    includeFirst: fileFilters[0]?.name === "include" && !fileFilters.some((option) => option.word.expands),
    excludeDirectories: command.options
      .filter((option) => option.name === "exclude-dir" && !option.word.expands)
      .map((option) => option.value ?? ""),
  };
}

function checkGrep(command: ParsedCommand, context: RuleContext): boolean {
  const operands = [...command.operands];
  if (!has(command, "regexp", "file")) {
    const pattern = operands.shift();
    if (!pattern || pattern.expands) {
      return false;
    }
  }
  const paths = readsFiles(command, context, operands);
  if (!paths) {
    return false;
  }
  // ugrep searches a directory operand recursively even without -r, so every
  // directory named is walked. Without a file operand grep reads stdin: OMP
  // gives bash calls /dev/null, not a terminal, where ugrep would search the
  // working directory instead.
  const filter = grepFilter(command);
  return has(command, "recursive")
    ? recursiveReadIsClean(command, context, operands, paths, filter)
    : paths.every((path) => context.treeIsClean(path, filter));
}

function checkDiff(command: ParsedCommand, context: RuleContext): boolean {
  if (!has(command, "from-file", "to-file") && command.operands.length !== 2) {
    return false;
  }
  // diff reads the files directly inside two directories even without -r.
  const paths = readsFiles(command, context);
  return paths !== null && paths.every((path) => context.treeIsClean(path));
}

/**
 * A sed script made only of commands that print, delete, quit, or edit the
 * pattern space: addresses (line numbers, `$`, `/regex/`, `first~step`,
 * `addr,+N`), `!`, and the commands `p d q Q = l P n N g G h H x z D` and
 * `s` without the `e` and `w` flags. Commands that read or write files
 * (`r R w W`), run programs (`e`), insert text, branch, or group are
 * reviewed.
 */
export function isSafeSedScript(script: string): boolean {
  let index = 0;
  const at = () => script[index] ?? "";
  const blanks = () => {
    while (at() === " " || at() === "\t") {
      index += 1;
    }
  };
  const number = (): boolean => {
    const digits = /^[0-9]+/.exec(script.slice(index));
    index += digits?.[0].length ?? 0;
    return digits !== null;
  };
  // Text up to an unescaped `delimiter`, as sed's own scanner reads it: a
  // backslash escapes the next character; a bracket does not protect the
  // delimiter. Newlines are not accepted.
  const delimited = (delimiter: string): boolean => {
    while (index < script.length) {
      const char = at();
      if (char === "\n") {
        return false;
      }
      if (char === "\\") {
        if (index + 1 >= script.length || script[index + 1] === "\n") {
          return false;
        }
        index += 2;
        continue;
      }
      index += 1;
      if (char === delimiter) {
        return true;
      }
    }
    return false;
  };
  const address = (second: boolean): boolean | null => {
    const char = at();
    if (char === "$") {
      index += 1;
      return true;
    }
    if (char === "/") {
      index += 1;
      if (!delimited("/")) {
        return false;
      }
      while (at() === "I" || at() === "M") {
        index += 1;
      }
      return true;
    }
    if (second && (char === "+" || char === "~")) {
      index += 1;
      return number();
    }
    if (number()) {
      if (at() === "~") {
        index += 1;
        return number();
      }
      return true;
    }
    return null;
  };

  while (index < script.length) {
    blanks();
    if (at() === ";" || at() === "\n") {
      index += 1;
      continue;
    }
    if (index >= script.length) {
      break;
    }
    const first = address(false);
    if (first === false) {
      return false;
    }
    blanks();
    if (first && at() === ",") {
      index += 1;
      blanks();
      if (address(true) !== true) {
        return false;
      }
      blanks();
    }
    while (at() === "!") {
      index += 1;
      blanks();
    }
    const command = at();
    index += 1;
    if (command === "s") {
      const delimiter = at();
      if (!delimiter || delimiter === "\n" || delimiter === "\\") {
        return false;
      }
      index += 1;
      if (!delimited(delimiter) || !delimited(delimiter)) {
        return false;
      }
      while (/[gpiImM0-9]/.test(at())) {
        index += 1;
      }
    } else if (command === "q" || command === "Q" || command === "l") {
      blanks();
      number();
    } else if (!"pd=PnNgGhHxzD".includes(command) || !command) {
      return false;
    }
    blanks();
    if (index < script.length && at() !== ";" && at() !== "\n") {
      return false;
    }
  }
  return true;
}

function checkSed(command: ParsedCommand, context: RuleContext): boolean {
  const operands = [...command.operands];
  const scripts = command.options.filter((option) => option.name === "expression").map((option) => option.value!);
  if (!scripts.length) {
    const script = operands.shift();
    if (!script || script.expands) {
      return false;
    }
    scripts.push(script.text);
  }
  // sed joins -e scripts with newlines before reading them.
  return isSafeSedScript(scripts.join("\n")) && readsFiles(command, context, operands) !== null;
}

// jq builtins that read the environment or load modules from files.
const JQ_UNSAFE = /(?<![.$\w])(?:env|import|include|modulemeta|get_search_list|get_prog_origin|get_jq_origin)(?!\w)|\$ENV(?!\w)/;

function checkJq(command: ParsedCommand, context: RuleContext): boolean {
  const [filter, ...inputs] = command.operands;
  if (!filter || filter.expands || JQ_UNSAFE.test(filter.text)) {
    return false;
  }
  return readsFiles(command, context, inputs) !== null;
}

const FIND_TESTS_WITHOUT_VALUE = new Set(words(`
  -print -print0 -prune -quit -empty -readable -writable -executable -true -false -depth -xdev -mount
  -nouser -nogroup -ls -daystart -noleaf -ignore_readdir_race -noignore_readdir_race
  ! ( ) , -not -a -and -o -or
`));
const FIND_TESTS_WITH_VALUE = new Set(words(`
  -name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -maxdepth -mindepth
  -mtime -mmin -atime -amin -ctime -cmin -size -perm -user -group -uid -gid -links -inum -lname -ilname
  -printf -used -newermt
`));
const FIND_TESTS_WITH_PATH = new Set(["-newer", "-anewer", "-cnewer", "-samefile"]);

/**
 * find's arguments: `-H`/`-P`/`-O<n>`, starting points, then an expression
 * of known tests. A word bash may rewrite is only accepted as a starting
 * point: inside the expression a file name could become an action.
 */
function parseFind(words: ShellWord[]): ParsedCommand | null {
  let index = 1;
  const options: ParsedOption[] = [];
  while (index < words.length && /^-(H|P|O[0-3])$/.test(words[index].text)) {
    index += 1;
  }
  const operands: ShellWord[] = [];
  const startsExpression = (text: string) => text.startsWith("-") || ["(", "!", ")", ","].includes(text);
  while (index < words.length && !startsExpression(words[index].text)) {
    operands.push(words[index]);
    index += 1;
  }
  while (index < words.length) {
    const word = words[index];
    if (word.expands) {
      return null;
    }
    if (FIND_TESTS_WITHOUT_VALUE.has(word.text)) {
      index += 1;
      continue;
    }
    const kind = FIND_TESTS_WITH_VALUE.has(word.text) ? "string" : FIND_TESTS_WITH_PATH.has(word.text) ? "read-file" : null;
    const value = words[index + 1];
    if (!kind || !value || value.expands) {
      return null;
    }
    options.push({ name: word.text, kind, value: value.text, word: value });
    index += 2;
  }
  return { options, operands };
}

function parseLiteralWords(words: ShellWord[]): ParsedCommand | null {
  return words.some((word) => word.expands) ? null : { options: [], operands: words.slice(1) };
}

function checkPrintf(command: ParsedCommand): boolean {
  const [format] = command.operands;
  return format !== undefined && !format.text.startsWith("-");
}

function checkTimeout(command: ParsedCommand, context: RuleContext): boolean {
  const [duration, ...inner] = command.operands;
  return duration !== undefined && DURATION.test(duration.text) && !duration.expands && inner.length > 0 && context.command(inner);
}

/**
 * A git operand (revision, `rev:path`, or path) that stays inside the
 * workspace and away from credential-like files. Git compares files outside
 * the work tree even without `--no-index` (`git diff /etc/passwd /dev/null`),
 * so any operand that resolves outside the workspace is reviewed.
 */
function isWorkspaceGitOperand(operand: string, context: RuleContext): boolean {
  const colon = operand.indexOf(":");
  if (colon >= 0) {
    // `HEAD:path` or `:path` reads a blob; `path` is relative to the repo root.
    const blobPath = operand.slice(colon + 1);
    return !blobPath.startsWith("/") && !blobPath.split(/[\\/]/).includes("..") && !isSensitivePath(blobPath);
  }
  if (operand.startsWith("/") || operand.startsWith("~")) {
    return false;
  }
  return context.workspacePath(operand);
}

function gitOperands(command: ParsedCommand, context: RuleContext): boolean {
  return command.operands.every((operand) => isWorkspaceGitOperand(operand.text, context));
}

const GIT_BRANCH_LIST_FLAGS = new Set(["--show-current", "--list", "--all", "--merged", "--no-merged", "-a", "-r", "-v", "-vv"]);
// Positional arguments are branch-name patterns only in list mode; otherwise
// `git branch <name>` creates a branch.
const GIT_BRANCH_LIST_MODE_FLAGS = new Set(["--list", "--merged", "--no-merged"]);

function gitBranchList(args: string[]): boolean {
  const flags = args.filter((arg) => arg.startsWith("-"));
  return flags.every((flag) => GIT_BRANCH_LIST_FLAGS.has(flag))
    && (flags.length === args.length || flags.some((flag) => GIT_BRANCH_LIST_MODE_FLAGS.has(flag)));
}

// `git tag <name>` creates a tag; patterns are listed only with -l.
function gitTagList(args: string[]): boolean {
  const flags = args.filter((arg) => arg.startsWith("-"));
  return flags.every((flag) => ["-l", "--list"].includes(flag) || /^-n\d*$/.test(flag) || /^--(sort|format)=/.test(flag))
    && (flags.length === args.length || flags.some((flag) => flag === "-l" || flag === "--list"));
}

type OperandCheck = (command: ParsedCommand, context: RuleContext, rule: OperandRule, args: ShellWord[]) => boolean;

const texts = (args: ShellWord[]) => args.map((word) => word.text);
const counted = (command: ParsedCommand, rule: OperandRule) => command.operands.length >= rule.min && command.operands.length <= rule.max;

/** The checks an entry's `operands` can name (see OPERAND_CHECKS). */
const OPERAND_CHECK_FUNCTIONS: Record<OperandCheckName, OperandCheck> = {
  "read-files": (command, context, rule) => counted(command, rule) && readsFiles(command, context) !== null,
  "literals": (command, _context, rule) => counted(command, rule)
    && command.operands.every((word) => !word.expands && (!rule.pattern || rule.pattern.test(word.text))),
  "none": (command) => command.operands.length === 0,
  "any": () => true,
  "printf-format": checkPrintf,
  "grep-operands": checkGrep,
  "diff-operands": checkDiff,
  "sed-script": checkSed,
  "jq-filter": checkJq,
  "duration-then-command": checkTimeout,
  "git-operands": gitOperands,
  "git-branch-list": (command, context, _rule, args) => gitOperands(command, context) && gitBranchList(texts(args)),
  "git-tag-list": (command, context, _rule, args) => gitOperands(command, context) && gitTagList(texts(args)),
  "git-remote": (command, context, _rule, args) => gitOperands(command, context)
    && (args.every((arg) => arg.text === "-v" || arg.text === "--verbose") || args[0]?.text === "get-url"),
  "git-stash-list": (command, context, _rule, args) => gitOperands(command, context) && ["list", "show"].includes(args[0]?.text ?? ""),
};

/**
 * Whether `text` is an option in `except`: a long one also by any
 * abbreviation or extension of its name, since git (like getopt_long)
 * accepts unambiguous abbreviations; a short letter anywhere in a group.
 */
function isExcepted(text: string, except: string[]): boolean {
  if (text.startsWith("--")) {
    const name = text.split("=", 1)[0];
    return except.some((option) => option.startsWith("--") && (name.startsWith(option) || (name.length > 2 && option.startsWith(name))));
  }
  return text.startsWith("-") && except.some((option) => !option.startsWith("--") && text.slice(1).includes(option[1]));
}

/**
 * `"options": "any"`: every word starting with `-` before `--` is an option
 * and every other word an operand, so an option's value given as the next
 * word is checked as an operand too. No word may expand.
 */
function parseAnyOptions(entry: ProgramEntry, args: ShellWord[]): ParsedCommand | null {
  if (args.some((word) => word.expands || isExcepted(word.text, entry.except))) {
    return null;
  }
  const end = args.findIndex((word) => word.text === "--");
  const options: ParsedOption[] = [];
  const operands: ShellWord[] = [];
  args.forEach((word, index) => {
    if (end >= 0 && index > end) {
      operands.push(word);
    } else if (word.text !== "--") {
      if (word.text.startsWith("-")) {
        options.push({ name: word.text, kind: "flag", word });
      } else {
        operands.push(word);
      }
    }
  });
  return { options, operands };
}

function globalOptionKind(entry: ProgramEntry, text: string): OptionKind | null {
  if (/^-[A-Za-z0-9]$/.test(text)) {
    return entry.flags.includes(text[1]) ? "flag" : entry.values[text[1]] ?? null;
  }
  if (text.startsWith("--")) {
    const name = text.slice(2);
    return entry.long.includes(name) ? "flag" : entry.longValues[name] ?? null;
  }
  return null;
}

/**
 * A program with subcommands, read as git reads its own options: global
 * options are whole words before the subcommand, a value is the next word,
 * and no word may expand. `-C dir` style options move the rest of the
 * command to that directory.
 */
function isSafeWithSubcommand(entry: ProgramEntry, words: ShellWord[], context: RuleContext): boolean {
  if (words.some((word) => word.expands)) {
    return false;
  }
  let index = 1;
  let place = context;
  for (let kind = globalOptionKind(entry, words[index]?.text ?? ""); kind; kind = globalOptionKind(entry, words[index]?.text ?? "")) {
    if (kind !== "flag") {
      const value = words[index + 1]?.text;
      if (value === undefined) {
        return false;
      }
      if (kind === "workspace-directory") {
        const directory = place.workspaceDirectory(value);
        if (!directory) {
          return false;
        }
        place = place.within(directory);
      } else if ((kind === "number" && !NUMBER.test(value)) || (kind === "read-file" && !place.readablePath(value))) {
        return false;
      }
      index += 1;
    }
    index += 1;
  }
  const subcommand = entry.subcommands!.get(words[index]?.text ?? "");
  return subcommand !== undefined && isSafeByEntry(subcommand, words.slice(index), place);
}

function isSafeByEntry(entry: ProgramEntry, words: ShellWord[], context: RuleContext): boolean {
  if (entry.subcommands) {
    return isSafeWithSubcommand(entry, words, context);
  }
  const args = words.slice(1);
  const command = entry.anyOptions ? parseAnyOptions(entry, args)
    : entry.arguments === "find-expression" ? parseFind(words)
    : entry.arguments === "literal-words" ? parseLiteralWords(words)
    : parseOptions(entry, words);
  if (!command) {
    return false;
  }
  for (const option of command.options) {
    if (option.kind === "number" && !NUMBER.test(option.value ?? "")) {
      return false;
    }
    if (option.kind === "read-file" && !context.readablePath(option.value ?? "")) {
      return false;
    }
    // `--include=*.ts` stays as written unless a file matches it.
    if (option.word.expands && (option.kind === "read-file" || !context.matchesNothing(option.word))) {
      return false;
    }
  }
  const rule = entry.operands!;
  if (!OPERAND_CHECK_FUNCTIONS[rule.check](command, context, rule, args)) {
    return false;
  }
  // Whatever the entry says each word is, none may name an unreadable file:
  // with `"options": "any"` (git), an option's glued value is never checked
  // otherwise (`git diff -O/path` reads an order file).
  return entry.opensNoFiles || args.every((word) => word.expands || context.namesNoUnreadableFile(word.text));
}

/**
 * Whether a command run by the bare program name `words[0]` is read-only by
 * that program's entry in the rules. Option values that name files are
 * checked with the context, operands by the entry's operand check.
 */
export function isSafeByProgramRule(words: ShellWord[], context: RuleContext, rules: CommandRules): boolean {
  const entry = rules.programs.get(words[0].text);
  return entry !== undefined && isSafeByEntry(entry, words, context);
}

/**
 * The entries of programs without subcommands, for tooling that checks them
 * against the programs themselves (tests/program-oracle/).
 */
export function programTables(rules: CommandRules = defaultRules()): Readonly<Record<string, Readonly<ProgramEntry>>> {
  return Object.fromEntries([...rules.programs].filter(([, entry]) => !entry.subcommands));
}
