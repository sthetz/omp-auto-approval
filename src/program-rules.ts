import type { FileFilter } from "./path-expansion.js";
import type { ShellWord } from "./shell-syntax.js";

/**
 * Built-in knowledge of common read-only programs (layer 2 of the bash fast
 * path). Each table lists the options a program may be given without review;
 * anything else, including an option that is merely unknown, sends the
 * command to review. Options are chosen to be read-only in GNU coreutils,
 * BSD and busybox alike, and for grep in GNU grep and ugrep, since the PATH
 * may resolve to any of them. Options that run programs, write files, follow
 * symbolic links out of a tree, or behave differently between
 * implementations are left out. tests/program-oracle/ runs the tables
 * against the implementations installed locally.
 *
 * The tables describe options and operands. Where operands are files, the
 * caller decides whether they may be read (see RuleContext).
 */

type ValueKind =
  // Any text, never opened as a file.
  | "string"
  // A count or size: digits, an optional sign and unit suffix.
  | "number"
  // A file the program reads.
  | "path"
  // A value only when glued to the option (`--color=auto`, `-Iseconds`).
  | "optional"
  // Two following words (`jq --arg name value`).
  | "pair";

export interface ParsedOption {
  // The long name without dashes, or the short letter; short letters with a
  // long equivalent that a check needs are named by the long one.
  name: string;
  kind: ValueKind | "flag";
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
  // Whether a command that this one runs (`timeout 5 git status`) is safe
  // on its own; its program is then pinned like the outer one.
  command(words: ShellWord[]): boolean;
}

interface ProgramSpec {
  // Short options without a value.
  flags?: string;
  // Short options with one.
  values?: Record<string, ValueKind>;
  // Long options without a value, and with one.
  long?: string[];
  longValues?: Record<string, ValueKind>;
  // Short letters reported by their long name.
  aliases?: Record<string, string>;
  // Accepts `-20` as an option (head, tail, grep context).
  numeric?: boolean;
  // Option parsing stops at the first operand (getopt's leading `+`).
  stopAtOperand?: boolean;
  // Never opens a file named by its arguments.
  opensNoFiles?: boolean;
  // Parse the arguments itself instead of by the tables above.
  parse?: (words: ShellWord[]) => ParsedCommand | null;
  check: (command: ParsedCommand, context: RuleContext) => boolean;
}

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
export function parseOptions(spec: ProgramSpec, words: ShellWord[]): ParsedCommand | null {
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

// Checks for programs whose operands are all files they read.
function files(max = Infinity) {
  return (command: ParsedCommand, context: RuleContext) => command.operands.length <= max && readsFiles(command, context) !== null;
}

function literals(min: number, max: number, pattern?: RegExp) {
  return (command: ParsedCommand) => command.operands.length >= min && command.operands.length <= max
    && command.operands.every((word) => !word.expands && (!pattern || pattern.test(word.text)));
}

function noOperands(command: ParsedCommand): boolean {
  return command.operands.length === 0;
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
    const kind = FIND_TESTS_WITH_VALUE.has(word.text) ? "string" : FIND_TESTS_WITH_PATH.has(word.text) ? "path" : null;
    const value = words[index + 1];
    if (!kind || !value || value.expands) {
      return null;
    }
    options.push({ name: word.text, kind, value: value.text, word: value });
    index += 2;
  }
  return { options, operands };
}

function parseEcho(words: ShellWord[]): ParsedCommand | null {
  return words.some((word) => word.expands) ? null : { options: [], operands: words.slice(1) };
}

function checkPrintf(command: ParsedCommand): boolean {
  const [format] = command.operands;
  return format !== undefined && !format.text.startsWith("-");
}

const GREP: ProgramSpec = {
  flags: "EFGPivwxclLoqsnhHbaIrTU",
  values: { e: "string", f: "path", m: "number", A: "number", B: "number", C: "number" },
  aliases: { r: "recursive", e: "regexp", f: "file" },
  numeric: true,
  long: words(`
    extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case invert-match word-regexp
    line-regexp count files-with-matches files-without-match only-matching quiet silent no-messages line-number
    with-filename no-filename byte-offset text recursive initial-tab line-buffered
  `),
  longValues: {
    regexp: "string", file: "path", "max-count": "number", "after-context": "number", "before-context": "number",
    context: "number", label: "string", include: "string", exclude: "string", "exclude-dir": "string",
    "exclude-from": "path", "binary-files": "string", color: "optional", colour: "optional",
  },
  check: checkGrep,
};

const PROGRAMS: Record<string, ProgramSpec> = {
  cat: {
    flags: "AbeEnstTuv",
    long: words("show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting"),
    check: files(),
  },
  head: {
    flags: "qvz",
    values: { n: "number", c: "number" },
    numeric: true,
    long: words("quiet silent verbose zero-terminated"),
    longValues: { lines: "number", bytes: "number" },
    check: files(),
  },
  // Not -f/-F/--follow, which never finish.
  tail: {
    flags: "qvz",
    values: { n: "number", c: "number" },
    numeric: true,
    long: words("quiet silent verbose zero-terminated"),
    longValues: { lines: "number", bytes: "number" },
    check: files(),
  },
  wc: {
    flags: "clwmL",
    long: words("bytes chars lines words max-line-length"),
    longValues: { total: "string" },
    check: files(),
  },
  // Not -L (follows symbolic links out of the tree).
  ls: {
    flags: "aAbBcCdfFgGhHiklmnNopqQrRsStuUvxXZ1",
    values: { I: "string", T: "number", w: "number" },
    long: words(`
      all almost-all author escape ignore-backups directory file-type full-time group-directories-first no-group
      human-readable si inode literal numeric-uid-gid hide-control-chars show-control-chars quote-name recursive
      reverse size kibibytes dereference-command-line dereference-command-line-symlink-to-dir context zero
    `),
    longValues: {
      "block-size": "string", format: "string", hide: "string", ignore: "string", "indicator-style": "string",
      "quoting-style": "string", sort: "string", time: "string", "time-style": "string", tabsize: "number",
      width: "number", color: "optional", classify: "optional", hyperlink: "optional",
    },
    check: files(),
  },
  // Not egrep or fgrep: scripts that run `grep` from whatever PATH the shell has.
  grep: GREP,
  // Not -i (in place) or -f (script file); the script itself is checked.
  sed: {
    flags: "nErsuz",
    values: { e: "string", l: "number" },
    aliases: { e: "expression" },
    long: words("quiet silent regexp-extended separate unbuffered null-data posix debug sandbox"),
    longValues: { expression: "string", "line-length": "number" },
    check: checkSed,
  },
  cut: {
    flags: "snz",
    values: { b: "string", c: "string", f: "string", d: "string" },
    long: words("complement only-delimited zero-terminated"),
    longValues: { bytes: "string", characters: "string", fields: "string", delimiter: "string", "output-delimiter": "string" },
    check: files(),
  },
  // Not -o (output file), -T (temporary directory), --compress-program or --files0-from.
  sort: {
    flags: "bdfghiMnRrVuszcCm",
    values: { k: "string", t: "string", S: "string" },
    long: words(`
      ignore-leading-blanks dictionary-order ignore-case general-numeric-sort human-numeric-sort ignore-nonprinting
      month-sort numeric-sort random-sort reverse version-sort unique stable zero-terminated merge
    `),
    longValues: { key: "string", "field-separator": "string", "buffer-size": "string", sort: "string", parallel: "number", check: "optional", "random-source": "path" },
    check: files(),
  },
  // A second operand is uniq's output file.
  uniq: {
    flags: "cdDuiz",
    values: { f: "number", s: "number", w: "number" },
    long: words("count repeated unique ignore-case zero-terminated"),
    longValues: { "all-repeated": "optional", group: "optional", "skip-fields": "number", "skip-chars": "number", "check-chars": "number" },
    check: files(1),
  },
  tr: {
    flags: "cCdst",
    long: words("complement delete squeeze-repeats truncate-set1"),
    opensNoFiles: true,
    check: literals(1, 2),
  },
  tac: { flags: "br", values: { s: "string" }, long: words("before regex"), longValues: { separator: "string" }, check: files() },
  paste: { flags: "sz", values: { d: "string" }, long: words("serial zero-terminated"), longValues: { delimiters: "string" }, check: files() },
  base64: { flags: "di", values: { w: "number" }, long: words("decode ignore-garbage"), longValues: { wrap: "number" }, check: files(1) },
  // Not -l (pipes through pr).
  diff: {
    flags: "qrNucwbBiaystTEZpd",
    values: { U: "number", C: "number", W: "number", x: "string", X: "path", I: "string", F: "string" },
    long: words(`
      brief recursive new-file unidirectional-new-file ignore-case ignore-all-space ignore-space-change
      ignore-blank-lines text side-by-side report-identical-files expand-tabs initial-tab ignore-tab-expansion
      ignore-trailing-space show-c-function minimal strip-trailing-cr suppress-common-lines left-column
      speed-large-files ignore-file-name-case no-ignore-file-name-case
    `),
    longValues: {
      unified: "optional", context: "optional", label: "string", exclude: "string", "ignore-matching-lines": "string",
      palette: "string", "exclude-from": "path", "from-file": "path", "to-file": "path", width: "number",
      "horizon-lines": "number", color: "optional",
    },
    check: checkDiff,
  },
  // Not -L (follows symbolic links out of the tree).
  du: {
    flags: "abcDhHklmsSx0",
    values: { d: "number", B: "string", t: "string" },
    long: words("all apparent-size bytes total dereference-args human-readable si summarize separate-dirs one-file-system null"),
    longValues: { "max-depth": "number", "block-size": "string", threshold: "string", exclude: "string", time: "optional", "time-style": "string" },
    check: files(),
  },
  stat: {
    flags: "Lft",
    values: { c: "string" },
    long: words("dereference file-system terse"),
    longValues: { format: "string", printf: "string" },
    check: (command, context) => command.operands.length > 0 && files()(command, context),
  },
  // Not -z/-Z (looks inside compressed files) or -m (magic file).
  file: {
    flags: "bhiLkNnr0",
    long: words("brief mime mime-type mime-encoding dereference no-dereference keep-going raw no-pad print0"),
    check: (command, context) => command.operands.length > 0 && files()(command, context),
  },
  readlink: { flags: "femnqsvz", long: words("canonicalize canonicalize-existing canonicalize-missing no-newline quiet silent verbose zero"), check: files() },
  realpath: {
    flags: "emLPqsz",
    long: words("canonicalize-existing canonicalize-missing logical physical quiet strip no-symlinks zero"),
    longValues: { "relative-to": "path", "relative-base": "path" },
    check: files(),
  },
  // jq can neither write files nor run programs; filters that read the
  // environment or load modules are reviewed. Not -f, -L, --rawfile or --slurpfile.
  jq: {
    flags: "rcesSnRjaCM",
    long: words(`
      raw-output raw-output0 compact-output exit-status slurp sort-keys null-input raw-input join-output ascii-output
      color-output monochrome-output tab seq stream stream-errors
    `),
    longValues: { indent: "number", arg: "pair", argjson: "pair" },
    check: checkJq,
  },
  find: { parse: parseFind, check: files() },
  // GNU timeout runs the rest of its arguments as a command, found on PATH.
  timeout: {
    flags: "v",
    values: { s: "string", k: "string" },
    long: words("preserve-status foreground verbose"),
    longValues: { signal: "string", "kill-after": "string" },
    stopAtOperand: true,
    check: (command, context) => {
      const [duration, ...inner] = command.operands;
      return duration !== undefined && DURATION.test(duration.text) && !duration.expands && inner.length > 0 && context.command(inner);
    },
  },
  echo: { parse: parseEcho, opensNoFiles: true, check: () => true },
  printf: { parse: parseEcho, opensNoFiles: true, check: checkPrintf },
  true: { parse: parseEcho, opensNoFiles: true, check: () => true },
  false: { parse: parseEcho, opensNoFiles: true, check: () => true },
  pwd: { flags: "LP", check: noOperands },
  basename: { flags: "az", values: { s: "string" }, long: words("multiple zero"), longValues: { suffix: "string" }, opensNoFiles: true, check: literals(1, Infinity) },
  dirname: { flags: "z", long: words("zero"), opensNoFiles: true, check: literals(1, Infinity) },
  // Not -s (sets the clock) or -f (reads dates from a file).
  date: {
    flags: "uR",
    values: { d: "string", r: "path", I: "optional" },
    long: words("utc universal rfc-email"),
    longValues: { date: "string", reference: "path", "iso-8601": "optional", "rfc-3339": "string" },
    opensNoFiles: true,
    check: literals(0, 1, /^\+/),
  },
  sleep: { opensNoFiles: true, check: literals(1, Infinity, DURATION) },
  seq: {
    flags: "w",
    values: { s: "string", f: "string" },
    long: words("equal-width"),
    longValues: { separator: "string", format: "string" },
    opensNoFiles: true,
    check: literals(1, 3, /^\d+(\.\d+)?$/),
  },
  which: { flags: "a", long: words("all"), opensNoFiles: true, check: literals(1, Infinity) },
  uname: {
    flags: "asnrvmpio",
    long: words("all kernel-name nodename kernel-release kernel-version machine processor hardware-platform operating-system"),
    opensNoFiles: true,
    check: noOperands,
  },
  whoami: { opensNoFiles: true, check: noOperands },
  id: { flags: "ugGnrz", long: words("user group groups name real zero"), opensNoFiles: true, check: literals(0, 1) },
  // Not with an operand or -F, which set the host name.
  hostname: { flags: "sfiId", long: words("short fqdn long ip-address all-ip-addresses domain"), opensNoFiles: true, check: noOperands },
  nproc: { long: words("all"), longValues: { ignore: "number" }, opensNoFiles: true, check: noOperands },
};

/** The tables, for tooling that checks them against the programs' own help. */
export function programTables(): Readonly<Record<string, Readonly<ProgramSpec>>> {
  return PROGRAMS;
}

/** Whether `name` has a table, so that its safety is decided here. */
export function hasProgramRule(name: string): boolean {
  return Object.hasOwn(PROGRAMS, name);
}

/** Whether the program never opens a file named by its arguments. */
export function opensNoFiles(name: string): boolean {
  return PROGRAMS[name]?.opensNoFiles === true;
}

/**
 * Whether a command run by the bare program name `words[0]` is read-only by
 * that program's table. Option values that name files are checked with the
 * context, operands by the program's own check.
 */
export function isSafeByProgramRule(words: ShellWord[], context: RuleContext): boolean {
  const spec = Object.hasOwn(PROGRAMS, words[0].text) ? PROGRAMS[words[0].text] : undefined;
  if (!spec) {
    return false;
  }
  const command = spec.parse ? spec.parse(words) : parseOptions(spec, words);
  if (!command) {
    return false;
  }
  for (const option of command.options) {
    if (option.kind === "number" && !NUMBER.test(option.value ?? "")) {
      return false;
    }
    if (option.kind === "path" && !context.readablePath(option.value ?? "")) {
      return false;
    }
    // `--include=*.ts` stays as written unless a file matches it.
    if (option.word.expands && (option.kind === "path" || !context.matchesNothing(option.word))) {
      return false;
    }
  }
  return spec.check(command, context);
}
