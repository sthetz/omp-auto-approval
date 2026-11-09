import { parseSimpleCommand } from "../../src/safe-command.js";
import type { ParsedScript, ShellParser } from "./oracle.js";

/** Today's fast path: one simple command, no operators, no redirections. */
export const baselineParser: ShellParser = (command) => {
  const tokens = parseSimpleCommand(command);
  if (!tokens) {
    return null;
  }
  const script: ParsedScript = {
    pipelines: [[{ words: tokens.map(({ text, expands }) => ({ text, expands })), redirects: [] }]],
    connectors: [],
  };
  return script;
};

export const PARSERS: Record<string, ShellParser> = {
  baseline: baselineParser,
};
