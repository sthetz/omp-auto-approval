import { statSync } from "node:fs";
import { defaultRulesPath, loadCommandRules, userRulesPath, type CommandRules } from "./command-rules.js";
import { toRecord } from "./common.js";

export interface CommandRulesWatch {
  main: string;
  rules: CommandRules;
  version: string;
}

function versionFor(main: string, included: string[]): string {
  return [...new Set([defaultRulesPath(), main, ...included])]
    .map((path) => {
      try {
        const stats = statSync(path);
        return `${path}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}:${stats.size}`;
      } catch (error) {
        const code = toRecord(error).code;
        return `${path}:missing-or-unreadable:${typeof code === "string" ? code : "unknown"}`;
      }
    })
    .join("\n");
}

/**
 * Check the default, main rules file, and every known include on each call.
 * Reload only when one changes; a changed main file can change the include set.
 */
export function watchCommandRules(previous?: CommandRulesWatch): CommandRulesWatch {
  const main = userRulesPath();
  const version = versionFor(main, previous?.rules.files ?? []);
  if (previous?.main === main && previous.version === version) {
    return previous;
  }
  const rules = loadCommandRules(main, true);
  return { main, rules, version: versionFor(main, rules.files) };
}
