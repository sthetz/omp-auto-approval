import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { group, itemAt } from "../../src/common.js";
import { DEFAULT_CONFIG } from "../../src/extension-config.js";
import { programTables } from "../../src/program-rules.js";
import { planSafeCommand } from "../../src/safe-command.js";
import { findEnvironment } from "../shell-oracle/oracle.js";

/**
 * Checks that what the program tables call read-only is read-only. Random
 * commands are built from the tables; each one the fast path accepts runs,
 * pinned, under strace in a bubblewrap sandbox whose workspace is read-only.
 * A run that starts a program the plan did not pin, opens a file for
 * writing, or changes the filesystem is reported.
 *
 *   node --import tsx tests/program-oracle/run.ts [--count 2000] [--seed 1] [--show 20] [--jobs N]
 *   node --import tsx tests/program-oracle/run.ts --self-test
 *
 * PROGRAM_ORACLE_DEBUG=<command prefix> prints the trace of matching runs.
 */

const WORKSPACE_FILES: Record<string, string> = {
  "notes.txt": "alpha beta\ngamma: delta\nalpha again\n",
  "src/a.ts": "export const a = 1; // x\n",
  "src/b.ts": "export const b = 2;\n",
  "data.json": '{"name":"demo","spec":{"env":[1,2]}}\n',
  "dir/d.txt": "d\n",
};
const FILES = ["notes.txt", "src/a.ts", "src/b.ts", "data.json", "dir/d.txt"];

// Values for options, by `program:option`, then by kind.
const VALUES: Record<string, string[]> = {
  "sort:k": ["1", "2,2", "1n"],
  "sort:key": ["2"],
  "sort:t": [":", ","],
  "sort:field-separator": [":"],
  "sort:S": ["1M"],
  "sort:buffer-size": ["1M"],
  "sort:sort": ["numeric", "version"],
  "sort:check": ["quiet"],
  "cut:b": ["1-3"],
  "cut:c": ["1-5", "2"],
  "cut:f": ["1", "1,2"],
  "cut:d": [":", " "],
  "cut:bytes": ["1-2"],
  "cut:characters": ["1-3"],
  "cut:fields": ["1"],
  "cut:delimiter": [":"],
  "cut:output-delimiter": ["|"],
  "ls:I": ["*.ts"],
  "ls:hide": ["*.txt"],
  "ls:ignore": ["dir"],
  "ls:sort": ["size", "time", "none"],
  "ls:format": ["long", "commas"],
  "ls:time": ["atime", "ctime"],
  "ls:time-style": ["iso", "long-iso"],
  "ls:quoting-style": ["literal", "c"],
  "ls:indicator-style": ["slash", "classify"],
  "ls:block-size": ["K"],
  "ls:color": ["never", "always"],
  "ls:classify": ["auto"],
  "ls:hyperlink": ["never"],
  "grep:e": ["alpha", "a.*"],
  "grep:regexp": ["beta"],
  "grep:include": ["*.ts", "*.txt"],
  "grep:exclude": ["*.json"],
  "grep:exclude-dir": ["dir"],
  "grep:binary-files": ["text", "without-match"],
  "grep:label": ["x"],
  "grep:color": ["never", "always"],
  "grep:colour": ["never"],
  "date:d": ["now", "2024-01-01"],
  "date:date": ["yesterday"],
  "date:I": ["seconds", "date"],
  "date:iso-8601": ["ns"],
  "date:rfc-3339": ["date", "seconds"],
  "du:B": ["K"],
  "du:block-size": ["M"],
  "du:t": ["1"],
  "du:threshold": ["1K"],
  "du:exclude": ["*.ts"],
  "du:time": ["atime"],
  "du:time-style": ["iso"],
  "diff:x": ["*.ts"],
  "diff:exclude": ["*.ts"],
  "diff:I": ["alpha"],
  "diff:ignore-matching-lines": ["alpha"],
  "diff:F": ["^x"],
  "diff:label": ["left"],
  "diff:palette": ["ad=1"],
  "diff:color": ["never", "always"],
  "diff:unified": ["1"],
  "diff:context": ["2"],
  "stat:c": ["%s %n"],
  "stat:format": ["%a"],
  "stat:printf": ["%n\\n"],
  "tac:s": [":"],
  "tac:separator": ["a"],
  "paste:d": [","],
  "paste:delimiters": [":"],
  "timeout:s": ["TERM", "KILL"],
  "timeout:signal": ["INT"],
  "timeout:k": ["1"],
  "timeout:kill-after": ["2"],
  "seq:s": [","],
  "seq:separator": [" "],
  "seq:f": ["%g"],
  "seq:format": ["%.1f"],
  "basename:s": [".ts"],
  "basename:suffix": [".txt"],
  "wc:total": ["auto", "never"],
  "uniq:all-repeated": ["separate"],
  "uniq:group": ["append"],
  "sed:l": ["20"],
  "sed:line-length": ["30"],
  "nproc:ignore": ["1"],
};
const SED_SCRIPTS = [
  "p",
  "1,2p",
  "$p",
  "/alpha/,/gamma/p",
  "s/alpha/omega/g",
  "s|a|b|2",
  "1!d",
  "2q",
  "=",
  "s/a/b/;s/c/d/",
  "1~2p",
  "n;p",
  "/x/,+1d",
];
const JQ_FILTERS = [".", ".name", ".spec.env[]", "keys", "to_entries", "[.[] | type]", "$v"];
const FIND_EXPRESSIONS = [
  ["-name", "*.ts"],
  ["-type", "f"],
  ["-maxdepth", "1"],
  ["-path", "./src/*"],
  ["-newer", "notes.txt"],
  ["-size", "-1k"],
  ["-empty"],
  ["-print0"],
  ["-ls"],
  ["-printf", "%p %s\\n"],
  ["!", "-name", "*.json"],
  ["(", "-name", "a*", "-o", "-name", "b*", ")"],
  ["-mmin", "-60"],
  ["-prune"],
  ["-regex", ".*ts"],
  ["-perm", "-u+r"],
  ["-quit"],
];

/** A small seeded generator (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(list: readonly T[]): T => itemAt(list, Math.floor(next() * list.length));
  return { next, pick, chance: (p: number) => next() < p };
}

function quote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

function generate(rng: ReturnType<typeof random>): string {
  const tables = programTables();
  const [program, spec] = rng.pick(Object.entries(tables));
  const args: string[] = [];
  // Values by the option as written, else by the name it is reported as.
  const value = (name: string, kind: string, alias?: string): string => {
    const known = VALUES[`${program}:${name}`] ?? (alias ? VALUES[`${program}:${alias}`] : undefined);
    if (known) {
      return rng.pick(known);
    }
    return kind === "number" ? rng.pick(["1", "2", "10"]) : kind === "read-file" ? rng.pick(FILES) : "x";
  };
  for (let count = Math.floor(rng.next() * 4); count > 0; count -= 1) {
    const choices: (() => void)[] = [];
    for (const letter of spec.flags) {
      choices.push(() => args.push(`-${letter}`));
    }
    for (const [letter, kind] of Object.entries(spec.values)) {
      const alias = spec.aliases[letter];
      choices.push(() =>
        kind === "optional"
          ? args.push(rng.chance(0.5) ? `-${letter}${value(letter, kind, alias)}` : `-${letter}`)
          : args.push(`-${letter}`, value(letter, kind, alias)),
      );
    }
    for (const name of spec.long) {
      choices.push(() => args.push(`--${name}`));
    }
    for (const [name, kind] of Object.entries(spec.longValues)) {
      choices.push(() => {
        if (kind === "optional") {
          args.push(rng.chance(0.5) ? `--${name}=${value(name, kind)}` : `--${name}`);
        } else if (kind === "pair") {
          args.push(`--${name}`, "v", "1");
        } else {
          if (rng.chance(0.5)) {
            args.push(`--${name}=${value(name, kind)}`);
          } else {
            args.push(`--${name}`, value(name, kind));
          }
        }
      });
    }
    if (spec.numeric) {
      choices.push(() => args.push(`-${rng.pick(["1", "2", "5"])}`));
    }
    if (choices.length) {
      rng.pick(choices)();
    }
  }
  const files = () => Array.from({ length: Math.floor(rng.next() * 3) }, () => rng.pick(FILES));
  switch (program) {
    case "grep":
      return [
        program,
        ...args,
        rng.pick(["alpha", "a", "export"]),
        ...(rng.chance(0.5) ? files() : [rng.pick(["src", "dir", "."])]),
      ]
        .map(quote)
        .join(" ");
    case "sed":
      return [program, ...args, rng.pick(SED_SCRIPTS), rng.pick(FILES)].map(quote).join(" ");
    case "jq":
      return [program, ...args, rng.pick(JQ_FILTERS), "data.json"].map(quote).join(" ");
    case "find":
      return [program, rng.pick([".", "src", "dir"]), ...rng.pick(FIND_EXPRESSIONS)].map(quote).join(" ");
    case "timeout":
      return [program, ...args, "5", rng.pick(["cat", "head", "wc"]), rng.pick(FILES)].map(quote).join(" ");
    case "diff":
      return [program, ...args, rng.pick(FILES), rng.pick(["notes.txt", "src", "dir/d.txt"])].map(quote).join(" ");
    case "uniq":
    case "base64":
      return [program, ...args, rng.pick(FILES)].map(quote).join(" ");
    case "tr":
      return [program, ...args, "a-z", "A-Z"].map(quote).join(" ");
    case "echo":
    case "printf":
      return [program, rng.pick(["%s\\n", "hello"]), "a", "-n"].map(quote).join(" ");
    case "seq":
      return [program, ...args, "1", "3"].map(quote).join(" ");
    case "sleep":
      return "sleep 0.01";
    case "date":
      return [program, ...args, ...(rng.chance(0.5) ? ["+%F"] : [])].map(quote).join(" ");
    case "basename":
    case "dirname":
      return [program, ...args, "/a/b.ts"].map(quote).join(" ");
    case "which":
      return [program, ...args, "cat"].map(quote).join(" ");
    case "id":
    case "pwd":
    case "uname":
    case "whoami":
    case "hostname":
    case "nproc":
    case "true":
    case "false":
      return [program, ...args].map(quote).join(" ");
    default:
      return [program, ...args, ...files()].map(quote).join(" ");
  }
}

interface Finding {
  command: string;
  problems: string[];
}

const SYSTEM_DIRECTORIES = ["/nix/store", "/usr", "/bin", "/lib", "/lib64", "/etc", "/run/current-system"];
const SORT_TEMPORARY = /^\/tmp\/sort[A-Za-z0-9]{6}$/;
const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;
const CHANGES =
  /^(creat|rename|renameat2?|unlink|unlinkat|mkdir|mkdirat|rmdir|link|linkat|symlink|symlinkat|chmod|fchmodat|truncate|utimensat)\(/;

async function runTraced(
  env: { bwrap: string; bash: string },
  strace: string,
  root: string,
  workspace: string,
  command: string,
): Promise<string> {
  const log = mkdtempSync(join(tmpdir(), "program-oracle-log-"));
  try {
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      ...SYSTEM_DIRECTORIES.flatMap((directory) => ["--ro-bind-try", directory, directory]),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      root,
      root,
      "--bind",
      log,
      log,
      "--chdir",
      workspace,
      "--setenv",
      "HOME",
      join(root, "home"),
      strace,
      "-f",
      "-qq",
      "-s",
      "200",
      "-o",
      join(log, "trace"),
      "-e",
      "trace=execve,execveat,open,openat,openat2,creat,rename,renameat,renameat2,unlink,unlinkat,mkdir,mkdirat,rmdir,link,linkat,symlink,symlinkat,chmod,fchmodat,truncate,utimensat",
      env.bash,
      "--noprofile",
      "--norc",
      "-c",
      command,
    ];
    await new Promise<void>((resolve) => {
      const child = spawn(env.bwrap, args, { stdio: ["ignore", "ignore", "ignore"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return readFileSync(join(log, "trace"), "utf8");
  } catch {
    return "";
  } finally {
    rmSync(log, { recursive: true, force: true });
  }
}

/**
 * What in a trace goes beyond reading the sandbox: programs other than
 * `expected`, writes, filesystem changes, and reads outside `root` and the
 * system directories.
 */
function traceProblems(trace: string, expected: Set<string>, bash: string, root: string): string[] {
  const problems: string[] = [];
  for (const line of trace.split("\n")) {
    const call = line.replace(/^\d+\s+/, "");
    const exec = /^execve\("([^"]*)"/.exec(call);
    if (exec) {
      const path = group(exec, 1);
      if (path !== bash && !expected.has(path) && !call.endsWith("= -1 ENOENT (No such file or directory)")) {
        problems.push(`ran ${path}`);
      }
      continue;
    }
    const openMatch =
      /^(open|openat2?)\((?:AT_FDCWD|\d+), "([^"]*)", ([^)]*)/.exec(call) ?? /^(open)\("([^"]*)", ([^)]*)/.exec(call);
    const open = openMatch ? { path: group(openMatch, 2), flags: group(openMatch, 3) } : null;
    // sort keeps temporary files of its own in TMPDIR, created exclusively and removed.
    if (open && SORT_TEMPORARY.test(open.path) && (open.flags.includes("O_EXCL") || !WRITE_FLAGS.test(open.flags))) {
      continue;
    }
    const unlink = /^unlink\("([^"]*)"/.exec(call);
    if (unlink && SORT_TEMPORARY.test(group(unlink, 1))) {
      continue;
    }
    // A successful read outside the sandbox's workspace and system directories.
    // O_PATH gives a handle that cannot read (file opens `/` for its sandbox).
    if (
      open &&
      !WRITE_FLAGS.test(open.flags) &&
      !open.flags.includes("O_PATH") &&
      open.path.startsWith("/") &&
      !/= -1 /.test(call) &&
      ![root, ...SYSTEM_DIRECTORIES, "/proc/", "/dev/", "/sys/"].some(
        (prefix) => open.path === prefix || open.path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
      )
    ) {
      problems.push(`read ${open.path}`);
      continue;
    }
    if (open && WRITE_FLAGS.test(open.flags) && !["/dev/null", "/dev/tty"].includes(open.path)) {
      problems.push(`opened ${open.path} with ${open.flags}`);
      continue;
    }
    if (CHANGES.test(call)) {
      problems.push(call.slice(0, 160));
    }
  }
  return problems;
}

async function pool<T, R>(items: T[], jobs: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(itemAt(items, index));
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const option = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const env = findEnvironment();
  if (typeof env === "string") {
    console.error(`program oracle cannot run: ${env}`);
    process.exit(2);
  }
  const strace = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => join(directory, "strace"))
    .find((candidate) => {
      try {
        return realpathSync(candidate) !== "";
      } catch {
        return false;
      }
    });
  if (!strace) {
    console.error("program oracle cannot run: strace is not on PATH");
    process.exit(2);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "program-oracle-")));
  const workspace = join(root, "workspace");
  for (const [file, content] of Object.entries(WORKSPACE_FILES)) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true });
    writeFileSync(join(workspace, file), content);
  }
  mkdirSync(join(root, "home"));
  if (argv.includes("--self-test")) {
    // Commands with known side effects, run without the planner: each must be caught.
    const program = (name: string): string => {
      // The PATH entry itself, not its target: a multi-call binary such as
      // coreutils picks the program by the name it was run as.
      const path = (process.env.PATH ?? "")
        .split(":")
        .map((directory) => join(directory, name))
        .find((candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
      if (!path) {
        console.error(`program oracle cannot run: ${name} is not on PATH`);
        process.exit(2);
      }
      return path;
    };
    let missed = 0;
    for (const command of [
      `${program("sort")} -o /tmp/out notes.txt`,
      `${program("find")} . -maxdepth 0 -exec ${program("true")} ';'`,
      `${program("sed")} -i s/a/b/ notes.txt`,
      `${program("touch")} /tmp/x`,
    ]) {
      const problems = traceProblems(
        await runTraced(env, strace, root, workspace, command),
        new Set([itemAt(command.split(" "), 0)]),
        env.bash,
        root,
      );
      console.log(`${problems.length ? "caught" : "MISSED"}: ${command}${problems.length ? ` (${problems[0]})` : ""}`);
      missed += problems.length ? 0 : 1;
    }
    rmSync(root, { recursive: true, force: true });
    process.exit(missed ? 1 : 0);
  }
  const rng = random(Number(option("--seed") ?? 1));
  const count = Number(option("--count") ?? 2000);
  const config = { ...DEFAULT_CONFIG, reviewer: "ai" as const };
  const commands = new Set<string>();
  for (let attempt = 0; commands.size < count && attempt < count * 20; attempt += 1) {
    commands.add(generate(rng));
  }
  const planned = [...commands].map((command) => ({ command, plan: planSafeCommand(command, config, { workspace }) }));
  const accepted = planned.flatMap(({ command, plan }) => (plan ? [{ command, plan }] : []));
  const started = Date.now();
  try {
    const findings = (
      await pool(
        accepted,
        Number(option("--jobs") ?? availableParallelism()),
        async ({ command, plan }): Promise<Finding | null> => {
          const expected = new Set([...plan.command.matchAll(/(?:^|\s)(\/\S+)/g)].map((match) => group(match, 1)));
          const trace = await runTraced(env, strace, root, workspace, plan.command);
          if (process.env.PROGRAM_ORACLE_DEBUG && command.startsWith(process.env.PROGRAM_ORACLE_DEBUG)) {
            console.log(trace);
          }
          if (!trace) {
            return { command, problems: ["no trace"] };
          }
          const problems = traceProblems(trace, expected, env.bash, root);
          return problems.length ? { command, problems } : null;
        },
      )
    ).filter((finding): finding is Finding => finding !== null);
    console.log(
      `${commands.size} generated, ${accepted.length} accepted by the fast path, ${findings.length} with side effects   ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    for (const finding of findings.slice(0, Number(option("--show") ?? 20))) {
      console.log(`\n${finding.command}\n  ${finding.problems.slice(0, 5).join("\n  ")}`);
    }
    process.exitCode = findings.length ? 1 : 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
