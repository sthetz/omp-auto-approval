import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { programTables } from "../../src/program-rules.js";

/**
 * Compares each program's entry in config/default-rules.jsonc with the
 * program's own `--help`, as installed on PATH: options the help does not
 * mention, flags the help shows with a value, value options it shows
 * without one, and short and long options paired in one entry that the help
 * does not show together. Help texts are written for people, so expect a few
 * false reports (`ls --sort`, `jq --indent`); this is a review aid, not a
 * test.
 *
 *   node --import tsx tests/program-oracle/help-check.ts [program…]
 */

function onPath(program: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(directory, program), constants.X_OK);
      return join(directory, program);
    } catch {
      // Not here.
    }
  }
  return null;
}

function helpText(path: string): string {
  let text: string;
  try {
    text = execFileSync(path, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    text = (failed.stdout ?? "") + (failed.stderr ?? "");
  }
  // Coreutils 9.12 links option names (OSC 8) and colours them (SGR).
  return text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const only = process.argv.slice(2);

for (const [name, entry] of Object.entries(programTables())) {
  if (entry.arguments !== "options" || (only.length && !only.includes(name))) {
    continue;
  }
  const path = onPath(name);
  const help = path ? helpText(path) : "";
  if (!help.trim()) {
    console.log(`${name}: no help`);
    continue;
  }
  const problems: string[] = [];
  for (const option of entry.long) {
    const match = new RegExp(`--${escape(option)}(?![\\w-])(\\[?=)?`).exec(help);
    if (!match) {
      problems.push(`--${option} missing`);
    } else if (match[1] && match[1] !== "[=") {
      problems.push(`--${option} takes a value`);
    }
  }
  for (const [option, kind] of Object.entries(entry.longValues)) {
    const match = new RegExp(`--${escape(option)}(?![\\w-])(\\[?=| [A-Z])?`).exec(help);
    if (!match) {
      problems.push(`--${option}= missing`);
    } else if (kind === "optional" && match[1] !== "[=") {
      problems.push(`--${option} is not optional (${match[1]})`);
    } else if (kind !== "optional" && kind !== "pair" && match[1] === "[=") {
      problems.push(`--${option} value is optional`);
    } else if (kind !== "optional" && kind !== "pair" && !match[1]) {
      problems.push(`--${option} shows no value`);
    }
  }
  for (const letter of entry.flags) {
    if (!new RegExp(`(^|[\\s,])-${escape(letter)}\\b(?![=\\[ ][A-Z])`, "m").test(help)) {
      problems.push(`-${letter} flag?`);
    }
  }
  for (const letter of Object.keys(entry.values)) {
    if (!new RegExp(`(^|[\\s,])-${escape(letter)}\\b`, "m").test(help)) {
      problems.push(`-${letter} value?`);
    }
  }
  for (const [letter, option] of Object.entries(entry.aliases)) {
    const together = help
      .split("\n")
      .some(
        (line) =>
          new RegExp(`(^|[\\s,])-${escape(letter)}\\b`).test(line) &&
          new RegExp(`--${escape(option)}(?![\\w-])`).test(line),
      );
    if (!together) {
      problems.push(`-${letter} and --${option} not paired`);
    }
  }
  console.log(`${name}: ${problems.length ? problems.join("; ") : "ok"}`);
}
