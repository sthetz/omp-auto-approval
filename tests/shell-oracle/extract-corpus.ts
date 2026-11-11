import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Collect the bash commands agents actually ran, from local Claude Code
 * transcripts, OMP sessions and Kimi Code sessions, into a deduplicated JSONL
 * corpus for the shell oracle. The oracle reads every `shell-corpus*.jsonl`
 * in the corpus directory, so commands collected elsewhere (another machine)
 * can be added as a file next to it.
 *
 * The corpus holds whatever those commands contained (hostnames, paths,
 * occasionally secrets), so it is written outside the repository, readable
 * only by you, and must never be committed.
 *
 *   node --import tsx tests/shell-oracle/extract-corpus.ts [--out FILE] [--claude DIR] [--omp DIR] [--kimi DIR]
 */

export const DEFAULT_CORPUS = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "omp-clearance",
  "shell-corpus.jsonl",
);

export interface CorpusEntry {
  command: string;
  // Which agent ran it, optionally prefixed by the machine (`alpha-claude`).
  source: string;
}

type Agent = "claude" | "omp" | "kimi";

function jsonlFiles(directory: string, found: string[] = [], depth = 0): string[] {
  if (depth > 8) {
    return found;
  }
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return found;
  }
  for (const name of names) {
    const path = join(directory, name);
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) {
        jsonlFiles(path, found, depth + 1);
      } else if (stats.isFile() && name.endsWith(".jsonl")) {
        found.push(path);
      }
    } catch {
      // Broken link or unreadable entry.
    }
  }
  return found;
}

function* commandsIn(file: string, source: Agent): Generator<string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const marker = source === "omp" ? '"toolCall"' : '"Bash"';
  for (const line of text.split("\n")) {
    if (!line.includes(marker)) {
      continue;
    }
    let entry: { message?: { content?: unknown }; event?: { name?: unknown; args?: { command?: unknown } } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (source === "kimi") {
      // Kimi Code logs each tool call as an event in the session's wire.jsonl.
      const command = entry.event?.name === "Bash" ? entry.event.args?.command : undefined;
      if (typeof command === "string" && command.trim()) {
        yield command;
      }
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const item of content as unknown[]) {
      // A tool call in a Claude Code transcript or an OMP session.
      const part = (item ?? {}) as {
        type?: unknown;
        name?: unknown;
        input?: { command?: unknown };
        arguments?: { command?: unknown };
      };
      const command =
        source === "claude"
          ? part.type === "tool_use" && part.name === "Bash"
            ? part.input?.command
            : undefined
          : part.type === "toolCall" && part.name === "bash"
            ? part.arguments?.command
            : undefined;
      if (typeof command === "string" && command.trim()) {
        yield command;
      }
    }
  }
}

export function loadCorpus(file: string): CorpusEntry[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusEntry);
}

/** Every corpus file next to `file` (`shell-corpus*.jsonl`), deduplicated by command. */
export function loadCorpusDirectory(file: string): CorpusEntry[] {
  const directory = dirname(file);
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => /^shell-corpus.*\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
  const seen = new Set<string>();
  return names
    .flatMap((name) => loadCorpus(join(directory, name)))
    .filter((entry) => !seen.has(entry.command) && Boolean(seen.add(entry.command)));
}

function main(): void {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    const value = index >= 0 ? args[index + 1] : undefined;
    return value || fallback;
  };
  const out = option("--out", DEFAULT_CORPUS);
  const sources: [Agent, string][] = [
    ["claude", option("--claude", join(homedir(), ".claude", "projects"))],
    ["omp", option("--omp", join(homedir(), ".omp", "agent", "sessions"))],
    ["kimi", option("--kimi", join(homedir(), ".kimi-code", "sessions"))],
  ];
  const seen = new Set<string>();
  const entries: CorpusEntry[] = [];
  for (const [source, directory] of sources) {
    let count = 0;
    for (const file of jsonlFiles(directory)) {
      for (const command of commandsIn(file, source)) {
        if (!seen.has(command)) {
          seen.add(command);
          entries.push({ command, source });
          count += 1;
        }
      }
    }
    console.log(`${source}: ${count} unique commands from ${directory}`);
  }
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`wrote ${entries.length} commands to ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
