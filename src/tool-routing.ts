import { getString, isPathWithin, sha256, stableStringify, toRecord, truncateInline } from "./common.js";
import { normalizeCommand } from "./safe-command.js";
import type { ReviewSubject, ToolCallEventLike } from "./types.js";

const LOCAL_STATE_TOOLS: Record<string, true> = { todo: true, wait: true };

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "search",
  "web_search",
  "mcp_status",
  "mcp_list",
  "mcp_search",
  "mcp_describe",
]);

const PATH_KEYS = ["path", "file_path", "filepath", "target", "targetPath"];

export function getToolName(event: ToolCallEventLike): string | null {
  const direct = getString(event.toolName) ?? getString(event.name);
  if (direct) {
    return direct;
  }
  const toolRecord = toRecord(event.tool);
  return getString(toolRecord.name) ?? getString(toolRecord.toolName) ?? null;
}

export function getToolInput(event: ToolCallEventLike): unknown {
  return event.input !== undefined ? event.input : event.arguments ?? {};
}

export function isLocalStateTool(toolName: string): boolean {
  return LOCAL_STATE_TOOLS[toolName.trim().toLowerCase()] === true;
}

const IMAGE_SOURCE_ENTITIES: Record<string, string> = {
  colon: ":",
  sol: "/",
  tab: "\t",
  newline: "\n",
};

function decodeImageSource(value: string): string {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_match, hex: string | undefined, decimal: string | undefined) => (
      String.fromCodePoint(Number.parseInt(hex ?? decimal ?? "0", hex ? 16 : 10))
    ))
    .replace(/&(colon|sol|tab|newline);/gi, (_match, entity: string) => IMAGE_SOURCE_ENTITIES[entity.toLowerCase()] ?? "")
    .replace(/[\u0000-\u0020]/g, "");
}

function hasExternalImageUrl(input: unknown): boolean {
  const html = getString(toRecord(input).html) ?? "";
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const source = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
    if (!source) {
      // Malformed source attributes fail closed into classifier review.
      if (/\bsrc\b/i.test(tag)) {
        return true;
      }
      continue;
    }
    const value = decodeImageSource(source[1] ?? source[2] ?? source[3] ?? "");
    if (/^(?:https?:|\/\/)/i.test(value)) {
      return true;
    }
  }
  return false;
}

export function isInteractiveUiOnlyTool(toolName: string, input: unknown, hasUI: boolean): boolean {
  return hasUI && toolName.trim().toLowerCase() === "ask" && !hasExternalImageUrl(input);
}

export function isReadOnlyTool(toolName: string, toolDefinition?: unknown): boolean {
  const definition = toRecord(toolDefinition);
  if (typeof definition.isReadOnly === "function") {
    try {
      if (definition.isReadOnly({})) {
        return true;
      }
    } catch {
      return false;
    }
  }
  if (definition.isReadOnly === true || definition.readOnlyHint === true) {
    return true;
  }
  if (toRecord(definition.annotations).readOnlyHint === true) {
    return true;
  }

  const normalized = toolName.trim().toLowerCase();
  return READ_ONLY_TOOLS.has(normalized);
}

export function getPathFromInput(input: unknown): string | null {
  const record = toRecord(input);
  for (const key of PATH_KEYS) {
    const value = getString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

export function isWorkspaceInternalPath(input: unknown, cwd: string): boolean {
  const pathValue = getPathFromInput(input);
  return Boolean(pathValue && isPathWithin(pathValue, cwd));
}

export function isManualOnlyTool(toolName: string, toolDefinition?: unknown): boolean {
  const normalized = toolName.toLowerCase();
  const record = toRecord(toolDefinition);
  if (typeof record.requiresUserInteraction === "function") {
    try {
      if (record.requiresUserInteraction()) {
        return true;
      }
    } catch {
      return true;
    }
  }
  if (record.requiresUserInteraction === true) {
    return true;
  }
  return normalized.includes("computer")
    || normalized.includes("browser_click")
    || normalized.includes("browser_type")
    || normalized.includes("chrome_click")
    || normalized.includes("chrome_type")
    || normalized.includes("install_plugin")
    || normalized.includes("request_plugin_install")
    || normalized.includes("mcp_config")
    || normalized.includes("permission_config");
}

export function findToolDefinition(toolName: string, tools: unknown[]): unknown | undefined {
  return tools.find((tool) => {
    const record = toRecord(tool);
    return record.name === toolName || record.toolName === toolName;
  });
}

export function createReviewSubject(toolName: string, input: unknown, cwd: string): ReviewSubject {
  const record = toRecord(input);
  const command = toolName === "bash" ? getString(record.command) : undefined;
  const path = getPathFromInput(input);
  const normalizedInput = toolName === "bash" && command
    ? { ...record, command: normalizeCommand(command) }
    : record;
  const actionSummary = toolName === "bash" && command
    ? `bash: ${truncateInline(normalizeCommand(command))}`
    : path
      ? `${toolName}: ${truncateInline(path)}`
      : `${toolName}: ${truncateInline(stableStringify(input))}`;
  const hashSource = stableStringify({ toolName, cwd, input: normalizedInput });
  return {
    toolName,
    input: normalizedInput,
    cwd,
    actionSummary,
    actionHash: sha256(hashSource),
  };
}
