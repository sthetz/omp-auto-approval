import { defaultRulesPath, type CommandRule, type CommandRules, type OptionKind, type OperandRule, type ProgramEntry } from "./command-rules.js";

/**
 * Text for `/auto-approval rules`: what the command rules in use say, and
 * where each part comes from.
 */

function operandsText(rule: OperandRule): string {
  const parameters = [
    rule.min > 0 ? `min ${rule.min}` : null,
    rule.max !== Infinity ? `max ${rule.max}` : null,
    rule.pattern ? `pattern ${rule.pattern.source}` : null,
  ].filter(Boolean);
  return parameters.length ? `${rule.check} (${parameters.join(", ")})` : rule.check;
}

/** An entry's options, with short letters next to the long name they are reported by. */
function optionLines(entry: ProgramEntry): string[] {
  const groups = new Map<string, { names: string[]; kind: OptionKind }>();
  for (const name of entry.long) {
    groups.set(name, { names: [`--${name}`], kind: "flag" });
  }
  for (const [name, kind] of Object.entries(entry.longValues)) {
    groups.set(name, { names: [`--${name}`], kind });
  }
  const shorts: [string, OptionKind][] = [...[...entry.flags].map((letter): [string, OptionKind] => [letter, "flag"]), ...Object.entries(entry.values)];
  for (const [letter, kind] of shorts.reverse()) {
    const group = groups.get(entry.aliases[letter] ?? "");
    if (group && group.kind === kind) {
      group.names.unshift(`-${letter}`);
    } else {
      groups.set(`-${letter}`, { names: [`-${letter}`], kind });
    }
  }
  const lines = [...groups.values()].map(({ names, kind }) => `${names.join(" ")}: ${kind}`).sort();
  return entry.numeric ? [...lines, "-NUM: number"] : lines;
}

function entryLines(entry: ProgramEntry, indent: string): string[] {
  const lines: string[] = [];
  const flags = [
    entry.arguments !== "options" ? `arguments: ${entry.arguments}` : null,
    entry.stopAtOperand ? "options end at the first operand" : null,
    entry.opensNoFiles ? "opens no files" : null,
  ].filter(Boolean);
  if (flags.length) {
    lines.push(`${indent}${flags.join("; ")}`);
  }
  if (entry.anyOptions) {
    lines.push(`${indent}options: any${entry.except.length ? `, except ${entry.except.join(" ")}` : ""}`);
  } else {
    const options = optionLines(entry);
    if (options.length) {
      lines.push(`${indent}options${entry.subcommands ? " before the subcommand (whole words)" : ""}:`, ...options.map((line) => `${indent}  ${line}`));
    } else if (entry.arguments === "options") {
      lines.push(`${indent}options: none`);
    }
    if (entry.subcommands && entry.except.length) {
      lines.push(`${indent}never after a subcommand: ${entry.except.join(" ")}`);
    }
  }
  if (entry.operands) {
    lines.push(`${indent}operands: ${operandsText(entry.operands)}`);
  }
  if (entry.subcommands) {
    lines.push(`${indent}subcommands (any other is reviewed):`);
    for (const [name, subcommand] of entry.subcommands) {
      lines.push(`${indent}  ${name}${subcommand.source !== entry.source ? ` (${subcommand.source})` : ""}`);
      lines.push(...entryLines({ ...subcommand, except: subcommand.except.filter((option) => !entry.except.includes(option)) }, `${indent}    `));
    }
  }
  return lines;
}

function ruleLines(rule: CommandRule): string[] {
  return [
    `${rule.id}: ${rule.outcome} (${rule.source})`,
    ...rule.match.map((pattern) => `  match: ${pattern}`),
    ...(rule.why ? [`  why: ${rule.why}`] : []),
  ];
}

/** The overview: files, programs by source, and every rule. */
export function rulesOverview(rules: CommandRules, blockCommands: readonly string[]): string {
  if (rules.problem) {
    return `command rules could not be loaded, so every bash command is reviewed: ${rules.problem}`;
  }
  const bySource = new Map<string, string[]>();
  for (const [name, entry] of rules.programs) {
    bySource.set(entry.source, [...(bySource.get(entry.source) ?? []), name]);
  }
  return [
    `files: ${[defaultRulesPath(), ...rules.files].join(", ")}`,
    "",
    "programs that skip review when every option and operand is allowed:",
    ...[...bySource].map(([source, names]) => `  ${source}: ${names.join(", ")}`),
    "",
    rules.rules.length || blockCommands.length ? "rules, most restrictive first wins (block, ask, review):" : "rules: none",
    ...rules.rules.flatMap(ruleLines).map((line) => `  ${line}`),
    ...blockCommands.filter((pattern) => pattern.trim()).map((pattern) => `  blockCommands: block (config.jsonc)\n    match: ${pattern.trim()}`),
    "",
    "/auto-approval rules <program | rule id> shows one entry.",
  ].join("\n");
}

/** One program's entry, or one rule, or null when there is neither. */
export function describeRule(rules: CommandRules, name: string): string | null {
  const program = rules.programs.get(name.replace(/^program:/, ""));
  if (program) {
    return [`${program.id} (${program.source})`, ...entryLines(program, "  ")].join("\n");
  }
  const rule = rules.rules.find((candidate) => candidate.id === name);
  return rule ? ruleLines(rule).join("\n") : null;
}
