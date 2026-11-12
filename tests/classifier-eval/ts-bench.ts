import { readFileSync } from "node:fs";
import { buildProjectedContext } from "../../src/context-projection.js";
import { isRecord } from "../../src/common.js";
import { createReviewSubject } from "../../src/tool-routing.js";
import type { ExtensionContextLike, ReviewSubject } from "../../src/types.js";

export type TsBenchExpectedOutcome = "allow" | "deny";

export interface TsBenchOriginalRecord extends Record<string, unknown> {
  instruction: string;
  history: string;
  current_action: string;
  env_info: string;
}

export interface TsBenchCase {
  caseId: string;
  expectedOutcome: TsBenchExpectedOutcome;
  source: Record<string, unknown>;
  tags: string[];
  selectionRationale: string;
  originalRecord: TsBenchOriginalRecord;
}

export interface ParsedTsBenchAction {
  thought: string;
  name: string;
  input: unknown;
}

export type TsBenchSessionEntry = {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: string | Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; arguments: unknown }>;
    toolName?: string;
    isDocumentation?: boolean;
  };
};

export interface TsBenchClassifierInput extends TsBenchCase {
  ctx: ExtensionContextLike;
  subject: ReviewSubject;
  projectionOptions: { agentMessage?: string };
  sessionEntries: TsBenchSessionEntry[];
  projectedContext: string;
}

function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${where}: ${key} must be a non-empty string`);
  }
  return value;
}

function requiredRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value;
}

function parseCase(value: unknown, line: number): TsBenchCase {
  const where = `TS-Bench shortlist line ${line}`;
  const record = requiredRecord(value, where);
  const caseId = requiredString(record, "case_id", where);
  const expectedOutcome = record.expected_outcome;
  if (expectedOutcome !== "allow" && expectedOutcome !== "deny") {
    throw new Error(`${where}: expected_outcome must be "allow" or "deny"`);
  }
  const source = requiredRecord(record.source, `${where}: source`);
  if (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
    throw new Error(`${where}: tags must be an array of non-empty strings`);
  }
  const selectionRationale = requiredString(record, "selection_rationale", where);
  const original = requiredRecord(record.original_record, `${where}: original_record`);
  for (const key of ["instruction", "history", "current_action", "env_info"]) {
    if (typeof original[key] !== "string") {
      throw new Error(`${where}: original_record.${key} must be a string`);
    }
  }
  requiredString(original, "instruction", `${where}: original_record`);
  requiredString(original, "current_action", `${where}: original_record`);

  return {
    caseId,
    expectedOutcome,
    source,
    tags: record.tags as string[],
    selectionRationale,
    originalRecord: original as TsBenchOriginalRecord,
  };
}

export function parseTsBenchShortlist(text: string): TsBenchCase[] {
  const cases: TsBenchCase[] = [];
  const caseIds = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`TS-Bench shortlist line ${index + 1} is not valid JSON`, { cause: error });
    }
    const parsed = parseCase(value, index + 1);
    if (caseIds.has(parsed.caseId)) {
      throw new Error(`TS-Bench shortlist line ${index + 1}: duplicate case_id ${parsed.caseId}`);
    }
    caseIds.add(parsed.caseId);
    cases.push(parsed);
  }
  return cases;
}

export function loadTsBenchShortlist(path: string): TsBenchCase[] {
  return parseTsBenchShortlist(readFileSync(path, "utf8"));
}

function structuredJsonEnd(text: string): number {
  const first = text[0];
  const closers = [first === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      closers.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (char !== closers.at(-1)) {
        break;
      }
      closers.pop();
      if (closers.length === 0) {
        return index + 1;
      }
    }
  }
  throw new Error("Action Input does not contain a complete JSON value");
}

function stringJsonEnd(text: string): number {
  let escaped = false;
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return index + 1;
    }
  }
  throw new Error("Action Input does not contain a complete JSON string");
}

function primitiveJsonEnd(text: string): number {
  const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text);
  if (!match) {
    throw new Error("Action Input does not start with a JSON value");
  }
  const next = text[match[0].length];
  if (next !== undefined && !/[\s`]/.test(next)) {
    throw new Error("Action Input has an invalid character after its JSON value");
  }
  return match[0].length;
}

export function parseFirstActionInputJson(text: string): unknown {
  let source = text.trimStart();
  const fence = /^```(?:json)?[\t ]*\r?\n/i.exec(source);
  if (fence) {
    source = source.slice(fence[0].length);
  }
  const first = source[0];
  const end =
    first === "{" || first === "["
      ? structuredJsonEnd(source)
      : first === '"'
        ? stringJsonEnd(source)
        : primitiveJsonEnd(source);
  try {
    return JSON.parse(source.slice(0, end));
  } catch (error) {
    throw new Error("Action Input contains invalid JSON", { cause: error });
  }
}

export function parseTsBenchAction(currentAction: string): ParsedTsBenchAction {
  const thoughtMarker = /^\(1\) Thought:[\t ]*/m.exec(currentAction);
  const actionMarker = /^\(\d+\) Action:[\t ]*([^\r\n]+?)[\t ]*\r?$/m.exec(currentAction);
  const inputMarker = /^\(\d+\) Action Input:[\t ]*/m.exec(currentAction);
  if (!actionMarker || !inputMarker) {
    throw new Error("current_action must contain Action and Action Input markers");
  }
  if (inputMarker.index < actionMarker.index) {
    throw new Error("current_action Action Input must follow Action");
  }
  const name = actionMarker[1]?.trim();
  if (!name) {
    throw new Error("current_action Action name must not be empty");
  }
  const thoughtStart = thoughtMarker ? thoughtMarker.index + thoughtMarker[0].length : 0;
  if (thoughtMarker && thoughtMarker.index > actionMarker.index) {
    throw new Error("current_action Thought must precede Action");
  }
  const thought = currentAction.slice(thoughtStart, actionMarker.index).trim();
  const inputText = currentAction.slice(inputMarker.index + inputMarker[0].length);
  return { thought, name, input: parseFirstActionInputJson(inputText) };
}

type HistoryStep = {
  thought: string;
  actionName: string;
  actionInput: string;
  observation: string;
};

function parseHistory(history: string): HistoryStep[] {
  const thoughtMarkers = [...history.matchAll(/^\(1\) Thought:[\t ]*/gm)];
  if (history.trim() && thoughtMarkers.length === 0) {
    throw new Error("history must contain numbered Thought markers");
  }
  return thoughtMarkers.map((thoughtMarker, index) => {
    const start = thoughtMarker.index + thoughtMarker[0].length;
    const end = thoughtMarkers[index + 1]?.index ?? history.length;
    const block = history.slice(start, end);
    const actionMarker = /^\(2\) Action:[\t ]*([^\r\n]+?)[\t ]*\r?$/m.exec(block);
    const inputMarker = /^\(3\) Action Input:[\t ]*/m.exec(block);
    const observationMarker = /^Observation:[\t ]?/m.exec(block);
    if (
      !actionMarker?.index ||
      !inputMarker?.index ||
      !observationMarker?.index ||
      inputMarker.index < actionMarker.index ||
      observationMarker.index < inputMarker.index
    ) {
      throw new Error(`history step ${index + 1} must contain Action, Action Input, and Observation markers`);
    }
    const actionName = actionMarker[1]?.trim();
    if (!actionName) {
      throw new Error(`history step ${index + 1} has an empty Action name`);
    }
    return {
      thought: block.slice(0, actionMarker.index).trim(),
      actionName,
      actionInput: block.slice(inputMarker.index + inputMarker[0].length, observationMarker.index).trim(),
      observation: block.slice(observationMarker.index + observationMarker[0].length).trim(),
    };
  });
}

function toolResult(text: string, toolName: string, isDocumentation = false): TsBenchSessionEntry {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      ...(isDocumentation ? { isDocumentation: true } : {}),
      content: [{ type: "text", text }],
    },
  };
}

function buildSessionEntries(evalCase: TsBenchCase): TsBenchSessionEntry[] {
  const original = evalCase.originalRecord;
  const entries: TsBenchSessionEntry[] = [
    { type: "message", message: { role: "user", content: original.instruction } },
    toolResult(original.env_info, "env_info", true),
  ];
  for (const step of parseHistory(original.history)) {
    entries.push(
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: step.thought },
            { type: "toolCall", name: step.actionName, arguments: step.actionInput },
          ],
        },
      },
      toolResult(step.observation, step.actionName),
    );
  }
  return entries;
}

export function adaptTsBenchCase(evalCase: TsBenchCase, cwd = "/workspace"): TsBenchClassifierInput {
  try {
    const pending = parseTsBenchAction(evalCase.originalRecord.current_action);
    if (!isRecord(pending.input)) {
      throw new Error("current_action Action Input must be a JSON object");
    }
    const subject = createReviewSubject(pending.name === "terminal" ? "bash" : pending.name, pending.input, cwd);
    const sessionEntries = buildSessionEntries(evalCase);
    const ctx: ExtensionContextLike = {
      cwd,
      hasUI: false,
      sessionManager: { getBranch: () => sessionEntries },
    };
    const projectionOptions = pending.thought ? { agentMessage: pending.thought } : {};
    return {
      ...evalCase,
      ctx,
      subject,
      projectionOptions,
      sessionEntries,
      projectedContext: buildProjectedContext(ctx, subject, projectionOptions),
    };
  } catch (error) {
    throw new Error(`Could not adapt TS-Bench case ${evalCase.caseId}`, { cause: error });
  }
}

export function adaptTsBenchShortlist(cases: TsBenchCase[], cwd = "/workspace"): TsBenchClassifierInput[] {
  return cases.map((evalCase) => adaptTsBenchCase(evalCase, cwd));
}
