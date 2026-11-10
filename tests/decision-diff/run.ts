/**
 * Compares what two revisions decide for the same bash commands: blocked,
 * asked about, reviewed by a rule, fast-pathed (and as which pinned command),
 * or left to the classifier. Use it before committing a change to the rules,
 * the program tables or the shell parser, to see every decision it changes.
 *
 *   npm run decisions:diff                        # working tree against HEAD
 *   npm run decisions:diff -- --base v0.4.0       # against another revision
 *   npm run decisions:diff -- --rules my.jsonc    # with a user rules file on both sides
 *   npm run decisions:diff -- --source synthetic  # only the public command list
 *   npm run decisions:diff -- --examples 20       # more examples per change
 *
 * Commands come from two sources:
 * - synthetic: a public list built from the program tables (synthetic.ts);
 * - corpus: your own agents' commands, collected by `npm run oracle:corpus`
 *   into ~/.cache/omp-clearance (see CONTRIBUTING.md). They are private, so
 *   only counts are printed for them unless you pass --show-corpus.
 *
 * The base revision is checked out into a temporary git worktree, so it must
 * have the command rules (0.4.0 or later). Both sides plan in the same
 * temporary workspace, with programs looked up on the current PATH and no
 * user rules unless --rules names a file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CORPUS, loadCorpusDirectory } from "../shell-oracle/extract-corpus.js";
import { syntheticCommands } from "./synthetic.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

interface Side {
  decide(command: string): string;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The decision for each command, as one comparable string. */
async function loadSide(root: string, workspace: string, rulesPath: string): Promise<{ side: Side; rules: unknown }> {
  const safe = await import(join(root, "src", "safe-command.ts"));
  const commandRules = await import(join(root, "src", "command-rules.ts"));
  const config = await import(join(root, "src", "extension-config.ts"));
  if (typeof commandRules.loadCommandRules !== "function" || typeof commandRules.escalateCommand !== "function") {
    throw new Error(`${root} has no command rules; pick a base revision from 0.4.0 on`);
  }
  const rules = commandRules.loadCommandRules(rulesPath);
  if (rules.problem) {
    throw new Error(`rules in ${root}: ${rules.problem}`);
  }
  const settings = { ...config.DEFAULT_CONFIG, enabled: true };
  const options = { workspace, searchPath: process.env.PATH ?? "", rules };
  return {
    rules,
    side: {
      decide(command: string): string {
        try {
          const escalation = commandRules.escalateCommand(command, rules);
          if (escalation) {
            return `${escalation.outcome}:${escalation.rule?.id ?? "?"}${escalation.textOnly ? " (text-only)" : ""}`;
          }
          const plan = safe.planSafeCommand(command, settings, options);
          return plan ? `fast:${plan.command}${plan.cwd ? ` [cwd ${plan.cwd}]` : ""}` : "classifier";
        } catch (error) {
          return `error:${String(error).slice(0, 80)}`;
        }
      },
    },
  };
}

/** "fast", "classifier", or the outcome and rule: what a change is counted by. */
function kind(decision: string): string {
  return decision.startsWith("fast:") ? "fast path" : decision;
}

function workspaceFixture(root: string): string {
  const workspace = join(root, "work");
  for (const [path, text] of Object.entries({ "notes.txt": "alpha\n", "src/a.ts": "a\n", "dir/d.txt": "d\n", ".env": "SECRET=1\n", "a b": "x\n" })) {
    mkdirSync(join(workspace, path, ".."), { recursive: true });
    writeFileSync(join(workspace, path), text);
  }
  writeFileSync(join(root, "outside.txt"), "o\n");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  return workspace;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const base = option(argv, "--base") ?? "HEAD";
  const source = option(argv, "--source") ?? "all";
  const examples = Number(option(argv, "--examples") ?? 5);
  const showCorpus = argv.includes("--show-corpus");
  const userRules = option(argv, "--rules");

  const temp = realpathSync(mkdtempSync(join(tmpdir(), "decision-diff-")));
  const baseRoot = join(temp, "base");
  const rulesPath = userRules ? resolve(userRules) : join(temp, "no-rules.jsonc");
  try {
    const revision = execFileSync("git", ["rev-parse", "--short", base], { cwd: ROOT, encoding: "utf8" }).trim();
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", baseRoot, revision], { cwd: ROOT, stdio: "ignore" });
    const workspace = workspaceFixture(temp);
    const before = await loadSide(baseRoot, workspace, rulesPath);
    const after = await loadSide(ROOT, workspace, rulesPath);

    const sources: { name: string; private: boolean; commands: string[] }[] = [];
    if (source === "all" || source === "synthetic") {
      sources.push({ name: "synthetic", private: false, commands: syntheticCommands(after.rules as never) });
    }
    if (source === "all" || source === "corpus") {
      const corpus = loadCorpusDirectory(DEFAULT_CORPUS).map((item: { command: string }) => item.command);
      if (corpus.length) {
        sources.push({ name: "corpus", private: !showCorpus, commands: corpus });
      } else {
        console.log(`no corpus in ${DEFAULT_CORPUS}: run \`npm run oracle:corpus\` to collect one`);
      }
    }

    console.log(`${base} (${revision}) → working tree${userRules ? `, with rules from ${userRules}` : ""}\n`);
    let changedTotal = 0;
    for (const { name, private: hidden, commands } of sources) {
      const changes = new Map<string, string[]>();
      let fastBefore = 0;
      let fastAfter = 0;
      for (const command of commands) {
        const was = before.side.decide(command);
        const now = after.side.decide(command);
        fastBefore += was.startsWith("fast:") ? 1 : 0;
        fastAfter += now.startsWith("fast:") ? 1 : 0;
        if (was === now) {
          continue;
        }
        const key = kind(was) === kind(now) ? `${kind(now)} (pinned command changed)` : `${kind(was)} → ${kind(now)}`;
        const list = changes.get(key) ?? [];
        list.push(command);
        changes.set(key, list);
      }
      const changed = [...changes.values()].reduce((sum, list) => sum + list.length, 0);
      changedTotal += changed;
      console.log(`${name}: ${commands.length} commands, ${changed} changed; fast path ${fastBefore} → ${fastAfter}`);
      for (const [key, list] of [...changes].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${String(list.length).padStart(6)}  ${key}`);
        if (!hidden) {
          for (const command of list.slice(0, examples)) {
            console.log(`            ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`);
          }
        }
      }
      if (hidden && changed) {
        console.log("  (corpus commands are private: --show-corpus prints them; don't paste them anywhere public)");
      }
      console.log("");
    }
    process.exitCode = changedTotal ? 1 : 0;
  } finally {
    if (existsSync(baseRoot)) {
      execFileSync("git", ["worktree", "remove", "--force", baseRoot], { cwd: ROOT, stdio: "ignore" });
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
