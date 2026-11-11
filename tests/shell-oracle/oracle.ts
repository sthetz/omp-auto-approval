import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Differential testing of shell parsers against bash itself.
 *
 * A parser under test turns a command string into simple commands with their
 * words, redirections, and the connectors between them, or rejects it. For
 * every command it accepts, bash runs the same string inside a bubblewrap
 * sandbox where every program and builtin is a recorder (see prelude.sh).
 * The records say which simple commands bash would run, with which arguments
 * and file descriptors, so any difference from the parser's view is a bug.
 */

export interface ParsedWord {
  text: string;
  // The shell rewrites this word (glob, brace, tilde); its final text is unknown.
  expands: boolean;
}

export interface ParsedRedirect {
  fd: number;
  // A file path, or for a duplication the fd it copies.
  target: string;
  duplicate?: boolean;
  // `<`: the file is opened for reading (any fd).
  read?: boolean;
}

export interface ParsedCommand {
  words: ParsedWord[];
  redirects: ParsedRedirect[];
}

export type Connector = "&&" | "||" | ";";

export interface ParsedScript {
  // Pipelines in order; `connectors[i]` joins pipeline i and i + 1.
  pipelines: ParsedCommand[][];
  connectors: Connector[];
}

export type ShellParser = (command: string) => ParsedScript | null;

export interface OracleRecord {
  // Where fds 0-2 pointed: "stdin"/"stdout"/"stderr" (the run's own), "pipe",
  // "/dev/null", or a path.
  fds: [string, string, string];
  argv: string[];
}

export interface OracleRun {
  records: OracleRecord[];
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
}

export interface OracleEnvironment {
  bwrap: string;
  bash: string;
  coreutils: string;
}

const PRELUDE = join(dirname(fileURLToPath(import.meta.url)), "prelude.sh");

// Files in the sandbox's working directory, so that globs visibly expand.
const WORKSPACE_FILES = ["a", "b.txt", "c.ts", ".hidden", "notes.txt", "dir/d.txt"];

// Read-only system directories the sandbox needs for bash and coreutils.
const SYSTEM_DIRECTORIES = ["/nix/store", "/usr", "/bin", "/lib", "/lib64"];

function findProgram(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      if (statSync(candidate).isFile()) {
        return realpathSync(candidate);
      }
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/** The programs the oracle needs, or why it cannot run. */
export function findEnvironment(): OracleEnvironment | string {
  const bwrap = findProgram("bwrap");
  const bash = findProgram("bash");
  const coreutils = findProgram("readlink");
  if (!bwrap) {
    return "bubblewrap (bwrap) is not on PATH";
  }
  if (!bash) {
    return "bash is not on PATH";
  }
  if (!coreutils) {
    return "coreutils readlink is not on PATH";
  }
  return { bwrap, bash, coreutils };
}

function parseRecords(log: Buffer, root: string): OracleRecord[] {
  const fields = log.toString("utf8").split("\0");
  const normalizeFd = (target: string): string => {
    if (target.startsWith("pipe:")) {
      return "pipe";
    }
    for (const name of ["stdin", "stdout", "stderr"]) {
      if (target === join(root, name)) {
        return name;
      }
    }
    // Files redirected to inside the run's directory, relative to the
    // working directory as the command named them.
    return target.startsWith(`${root}/`) ? relative(join(root, "work"), target) : target;
  };
  const records: OracleRecord[] = [];
  let index = 0;
  while (index < fields.length && fields[index] === "@@REC") {
    const fds = fields.slice(index + 2, index + 5).map(normalizeFd) as [string, string, string];
    const argc = Number(fields[index + 5]);
    records.push({ fds, argv: fields.slice(index + 6, index + 6 + argc) });
    index += 6 + argc;
  }
  return records;
}

/**
 * Run `command` with bash in a fresh sandbox where every program and builtin
 * records its call and returns `status`. No network, no access to the real
 * home directory, and the system directories are read-only.
 */
export interface OracleFiles {
  // Files a redirection reads: created empty so that bash can open them.
  read: string[];
  // Files a redirection writes: their directories are created.
  written: string[];
}

/** The redirection targets in `script` that must exist for bash to run it. */
export function redirectionFiles(script: ParsedScript): OracleFiles {
  const files: OracleFiles = { read: [], written: [] };
  for (const command of script.pipelines.flat()) {
    for (const { target, duplicate, read } of command.redirects) {
      if (duplicate || target === "/dev/null") {
        continue;
      }
      (read ? files.read : files.written).push(target);
    }
  }
  return files;
}

/** A redirection target the sandbox cannot provide, so bash would fail before running anything. */
export class OracleSetupError extends Error {}

/**
 * Sandbox setup for the redirection targets. A path inside the run's own
 * directory is created there directly; any other path is created only inside
 * the sandbox, so the host's filesystem is never touched.
 */
function prepareFiles(root: string, work: string, files: OracleFiles): string[] {
  const args: string[] = [];
  const emptyFile = join(root, "empty-file");
  writeFileSync(emptyFile, "");
  const place = (target: string, kind: "file" | "directory") => {
    const absolute = resolve(work, target);
    if (SYSTEM_DIRECTORIES.some((directory) => absolute === directory || absolute.startsWith(`${directory}/`))) {
      return;
    }
    if (absolute.startsWith(`${root}/`)) {
      try {
        if (kind === "directory") {
          mkdirSync(absolute, { recursive: true });
        } else if (!existsSync(absolute)) {
          mkdirSync(dirname(absolute), { recursive: true });
          writeFileSync(absolute, "");
        }
      } catch (error) {
        throw new OracleSetupError(`cannot create ${target}: ${(error as Error).message}`);
      }
    } else if (kind === "directory") {
      args.push("--dir", absolute);
    } else {
      args.push("--ro-bind", emptyFile, absolute);
    }
  };
  // A file the command also writes must stay writable, so it is not created
  // as a read-only placeholder; the write creates it.
  files.read.filter((target) => !files.written.includes(target)).forEach((target) => place(target, "file"));
  files.written.forEach((target) => place(dirname(target), "directory"));
  return args;
}

export async function runOracle(
  env: OracleEnvironment,
  command: string,
  status: number,
  options: { files?: OracleFiles; timeoutMs?: number } = {},
): Promise<OracleRun> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const root = mkdtempSync(join(tmpdir(), "shell-oracle-"));
  const work = join(root, "work");
  const home = join(root, "home");
  for (const file of WORKSPACE_FILES) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), "");
  }
  mkdirSync(home);
  const fileArgs = prepareFiles(root, work, options.files ?? { read: [], written: [] });
  writeFileSync(join(root, "stdin"), "");
  mkdirSync(join(root, "log"));
  const stdio = [
    openSync(join(root, "stdin"), "r"),
    openSync(join(root, "stdout"), "w"),
    openSync(join(root, "stderr"), "w"),
  ];
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    ...SYSTEM_DIRECTORIES.filter((directory) => existsSync(directory)).flatMap((directory) => [
      "--ro-bind",
      directory,
      directory,
    ]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    root,
    root,
    "--ro-bind",
    PRELUDE,
    join(root, "prelude.sh"),
    ...fileArgs,
    "--chdir",
    work,
    "--clearenv",
    "--setenv",
    "HOME",
    home,
    "--setenv",
    "PATH",
    join(root, "no-programs"),
    "--setenv",
    "BASH_ENV",
    join(root, "prelude.sh"),
    "--setenv",
    "ORACLE_LOG",
    join(root, "log"),
    "--setenv",
    "ORACLE_STATUS",
    String(status),
    "--setenv",
    "ORACLE_COREUTILS",
    env.coreutils,
    env.bash,
    "--noprofile",
    "-c",
    command,
  ];
  try {
    const { exitCode, timedOut } = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
      const child = spawn(env.bwrap, args, { stdio });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut });
      });
    });
    const log = join(root, "log");
    return {
      records: readdirSync(log)
        .sort()
        .flatMap((name) => parseRecords(readFileSync(join(log, name)), root)),
      exitCode,
      stderr: readFileSync(join(root, "stderr"), "utf8"),
      timedOut,
    };
  } finally {
    stdio.forEach((fd) => closeSync(fd));
    rmSync(root, { recursive: true, force: true });
  }
}

/** Indexes of the pipelines bash runs when every command exits with `status`. */
export function pipelinesRun(script: ParsedScript, status: number): number[] {
  const run: number[] = [];
  let last = 0;
  script.pipelines.forEach((_, index) => {
    const connector = index === 0 ? ";" : script.connectors[index - 1];
    if ((connector === "&&" && last !== 0) || (connector === "||" && last === 0)) {
      return;
    }
    run.push(index);
    last = status;
  });
  return run;
}

function expectedFds(command: ParsedCommand, position: number, length: number): [string, string, string] {
  const fds: [string, string, string] = [
    position === 0 ? "stdin" : "pipe",
    position === length - 1 ? "stdout" : "pipe",
    "stderr",
  ];
  for (const { fd, target, duplicate } of command.redirects) {
    if (fd < 0 || fd > 2) {
      continue;
    }
    fds[fd] = duplicate ? (fds[Number(target)] ?? `&${target}`) : normalize(target);
  }
  return fds;
}

function describe(argv: string[], fds: string[]): string {
  return `${JSON.stringify(argv)} fds=${fds.join(",")}`;
}

function matches(command: ParsedCommand, fds: string[], record: OracleRecord): boolean {
  if (record.fds.some((fd, index) => fd !== fds[index])) {
    return false;
  }
  // A word the shell rewrites can become any text, or several words; the
  // program, unless it is one of them, must still match.
  const program = command.words[0];
  if (!program) {
    return false;
  }
  if (command.words.some((word) => word.expands)) {
    return program.expands || record.argv[0] === program.text;
  }
  return (
    record.argv.length === command.words.length && record.argv.every((arg, index) => arg === command.words[index]?.text)
  );
}

/**
 * How bash's run differs from what the parser expects, or null when they
 * agree. Commands in one pipeline run concurrently, so their records are
 * matched in any order.
 */
export function compareRun(script: ParsedScript, status: number, run: OracleRun): string | null {
  if (run.timedOut) {
    return "bash timed out";
  }
  const records = [...run.records];
  const problems: string[] = [];
  for (const index of pipelinesRun(script, status)) {
    const pipeline = script.pipelines[index];
    if (!pipeline) {
      problems.push(`the parser has no pipeline ${index}`);
      continue;
    }
    const batch = records.splice(0, pipeline.length);
    const unmatched = [...batch];
    pipeline.forEach((command, position) => {
      const fds = expectedFds(command, position, pipeline.length);
      // Exact matches first, so a loosely matched word cannot take another command's record.
      const exact = unmatched.findIndex(
        (record) => !command.words.some((word) => word.expands) && matches(command, fds, record),
      );
      const found = exact >= 0 ? exact : unmatched.findIndex((record) => matches(command, fds, record));
      if (found >= 0) {
        unmatched.splice(found, 1);
      } else {
        problems.push(
          `expected ${describe(
            command.words.map((word) => word.text),
            fds,
          )}`,
        );
      }
    });
    problems.push(...unmatched.map((record) => `bash ran ${describe(record.argv, record.fds)}`));
  }
  problems.push(...records.map((record) => `bash also ran ${describe(record.argv, record.fds)}`));
  if (!problems.length) {
    return null;
  }
  const stderr = run.stderr.trim();
  return [...problems, ...(stderr ? [`bash stderr: ${stderr.slice(0, 300)}`] : [])].join("\n");
}
