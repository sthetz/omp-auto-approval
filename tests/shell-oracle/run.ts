import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { SHELL_CASES } from "./cases.js";
import { DEFAULT_CORPUS, loadCorpus, loadCorpusDirectory } from "./extract-corpus.js";
import { fuzzCommands } from "./fuzz.js";
import {
  compareRun,
  findEnvironment,
  OracleSetupError,
  redirectionFiles,
  runOracle,
  type OracleEnvironment,
  type ParsedScript,
  type ShellParser,
} from "./oracle.js";
import { PARSERS } from "./parsers.js";

/**
 * Check a shell parser against bash on hand-written cases, the local corpus
 * of real agent commands (see extract-corpus.ts), and seeded fuzz.
 *
 * The corpus is every `shell-corpus*.jsonl` in ~/.cache/omp-clearance,
 * or one file given with --corpus.
 *
 *   node --import tsx tests/shell-oracle/run.ts [--parser recognizer] [--corpus FILE | --no-corpus]
 *     [--fuzz N] [--seed N] [--jobs N] [--show N]
 *
 * Exits non-zero if bash disagrees with any command the parser accepts.
 */

interface Item {
  source: string;
  command: string;
}

interface Outcome {
  item: Item;
  accepted: boolean;
  skipped?: string;
  divergence?: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// Commands the recorder cannot stand in for, so bash would run them for real
// (inside the sandbox) and leave no record. A program named by a path is not
// looked up on PATH, and the prelude needs the real `builtin` to record
// anything.
// A redirection to a directory, or through a file as if it were one, fails
// before the command runs. The command is still accepted correctly; bash just
// has nothing to show.
function unverifiable(script: ParsedScript): string | undefined {
  const commands = script.pipelines.flat();
  const programs = commands.map((command) => command.words[0]);
  if (programs.some((program) => program?.expands || program?.text.includes("/"))) {
    return "a program named by path, or by an expansion, would really run";
  }
  if (programs.some((program) => program?.text === "builtin")) {
    return "the oracle cannot record `builtin`";
  }
  const files = commands.flatMap((command) =>
    command.redirects.filter((redirect) => !redirect.duplicate).map((redirect) => redirect.target),
  );
  if (
    files.some(
      (file) =>
        file.endsWith("/") ||
        ["", ".", "..", "/"].includes(file) ||
        /(^|\/)\.\.?$/.test(file) ||
        WORKSPACE_DIRECTORIES.has(file),
    )
  ) {
    return "a redirection names a directory";
  }
  return undefined;
}

// Directories in the oracle's working directory (see oracle.ts).
const WORKSPACE_DIRECTORIES = new Set(["dir"]);

async function check(env: OracleEnvironment, parser: ShellParser, item: Item): Promise<Outcome> {
  const script = parser(item.command);
  if (!script) {
    return { item, accepted: false };
  }
  const skipped = unverifiable(script);
  if (skipped) {
    return { item, accepted: true, skipped };
  }
  const branches = script.connectors.some((connector) => connector !== ";") ? [0, 1] : [0];
  const problems: string[] = [];
  for (const status of branches) {
    let run;
    try {
      run = await runOracle(env, item.command, status, { files: redirectionFiles(script) });
    } catch (error) {
      if (error instanceof OracleSetupError) {
        return { item, accepted: true, skipped: error.message };
      }
      throw error;
    }
    const divergence = compareRun(script, status, run);
    if (divergence) {
      problems.push(`[every command exits ${status}]\n${divergence}`);
    }
  }
  return { item, accepted: true, divergence: problems.length ? problems.join("\n") : undefined };
}

async function pool<T, R>(items: T[], jobs: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

function excerpt(item: Item): string {
  // Corpus commands are real and may contain anything; show only the start.
  const limit = item.source === "case" || item.source.startsWith("fuzz") ? 400 : 160;
  const text = JSON.stringify(item.command);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const env = findEnvironment();
  if (typeof env === "string") {
    console.error(`shell oracle unavailable: ${env}`);
    process.exitCode = 2;
    return;
  }
  const parserName = option(args, "--parser") ?? "recognizer";
  const parser = PARSERS[parserName];
  if (!parser) {
    console.error(`unknown parser ${parserName}; known: ${Object.keys(PARSERS).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const seed = Number(option(args, "--seed") ?? 1);
  const items: Item[] = SHELL_CASES.map((command) => ({ source: "case", command }));
  if (!args.includes("--no-corpus")) {
    const corpusFile = option(args, "--corpus");
    const corpus = corpusFile
      ? existsSync(corpusFile)
        ? loadCorpus(corpusFile)
        : []
      : loadCorpusDirectory(DEFAULT_CORPUS);
    if (!corpus.length) {
      console.log(`no corpus at ${corpusFile ?? DEFAULT_CORPUS}; run extract-corpus.ts to build one`);
    }
    items.push(...corpus.map((entry) => ({ source: `corpus:${entry.source}`, command: entry.command })));
  }
  items.push(
    ...fuzzCommands(Number(option(args, "--fuzz") ?? 3000), seed).map((command) => ({
      source: `fuzz:${seed}`,
      command,
    })),
  );

  const started = Date.now();
  const outcomes = await pool(items, Number(option(args, "--jobs") ?? availableParallelism()), (item) =>
    check(env, parser, item),
  );

  const sources = [...new Set(items.map((item) => item.source))];
  console.log(`parser: ${parserName}   bash: ${env.bash}   ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  console.log("source          total  accepted  diverged  skipped");
  for (const source of sources) {
    const rows = outcomes.filter((outcome) => outcome.item.source === source);
    const accepted = rows.filter((outcome) => outcome.accepted).length;
    const diverged = rows.filter((outcome) => outcome.divergence).length;
    const skipped = rows.filter((outcome) => outcome.skipped).length;
    const share = rows.length ? ((100 * accepted) / rows.length).toFixed(1) : "0.0";
    console.log(
      `${source.padEnd(14)} ${String(rows.length).padStart(6)}  ${String(accepted).padStart(5)} ${`(${share}%)`.padStart(8)}  ${String(diverged).padStart(6)}  ${String(skipped).padStart(7)}`,
    );
  }

  const divergent = outcomes.filter((outcome) => outcome.divergence);
  const show = Number(option(args, "--show") ?? 20);
  for (const outcome of divergent.slice(0, show)) {
    console.log(`\n--- ${outcome.item.source}: ${excerpt(outcome.item)}\n${outcome.divergence}`);
  }
  if (divergent.length > show) {
    console.log(`\n… ${divergent.length - show} more divergences (raise --show)`);
  }
  process.exitCode = divergent.length ? 1 : 0;
}

void main();
