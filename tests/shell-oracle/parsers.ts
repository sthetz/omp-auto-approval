import { parseSimpleCommand } from "../../src/safe-command.js";
import { recognizeShell } from "../../src/shell-syntax.js";
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

/** The layer 1 recognizer (src/shell-syntax.ts). */
export const recognizerParser: ShellParser = (command) => {
  const script = recognizeShell(command);
  if (!script) {
    return null;
  }
  return {
    connectors: script.connectors,
    pipelines: script.pipelines.map((pipeline) => pipeline.map((shellCommand) => ({
      words: shellCommand.words.map(({ text, expands }) => ({ text, expands })),
      redirects: shellCommand.redirects.map(({ fd, kind, target }) => ({ fd, target, duplicate: kind === "duplicate", read: kind === "read" })),
    }))),
  };
};

export const PARSERS: Record<string, ShellParser> = {
  baseline: baselineParser,
  recognizer: recognizerParser,
};
