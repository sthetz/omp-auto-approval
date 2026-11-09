import { recognizeShell } from "../../src/shell-syntax.js";
import type { ShellParser } from "./oracle.js";

/** The fast path's recognizer (src/shell-syntax.ts). */
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
  recognizer: recognizerParser,
};
