import { homedir } from "node:os";
import { join } from "node:path";
import { getString, relativePathWithin, resolvePathForCwd, sha256, stableStringify, toRecord, truncateInline, type ReadRoots } from "./common.js";

export { resolveReadRoots, type ReadRoots } from "./common.js";
import { normalizeCommand } from "./safe-command.js";
import { isSensitivePath } from "./sensitive-paths.js";
import type { ReviewSubject, ToolCallEventLike } from "./types.js";

const LOCAL_STATE_TOOLS: Record<string, true> = { todo: true, wait: true };

// Host tools that only read. They skip review only when every target they
// name passes isWorkspaceReadFastPath. `web_search` is deliberately absent:
// its query is model-chosen text sent to a third party, so it can carry data
// out of the session.
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "search",
  "ast_grep",
  "mcp_status",
  "mcp_list",
  "mcp_search",
  "mcp_describe",
]);

const PATH_KEYS = ["path", "file_path", "filepath", "target", "targetPath"];
const READ_TARGET_KEYS = [...PATH_KEYS, "paths"];

// OMP internal URL schemes backed by local, read-only session data. Others
// reach remote hosts (ssh, mcp, pr, issue, mr), devices or processes (proc,
// out, xd), or user secrets and settings (vault, cfg), and stay reviewed.
const LOCAL_READ_SCHEMES = new Set(["skill", "rule", "agent", "artifact", "memory", "local", "omp"]);


// Keys that can name a write destination anywhere in a write/edit payload,
// e.g. OMP's patch-mode edit `{ path, edits: [{ rename }] }`.
const WRITE_DESTINATION_KEYS = new Set([...PATH_KEYS, "rename", "move", "to", "newPath", "new_path", "destination"]);

// Workspace entries whose contents are executed or trusted without further
// review: git config and hooks (run by fast-pathed git commands such as
// `git status` via core.fsmonitor), agent configuration, direnv, editor tasks.
const PROTECTED_WORKSPACE_ENTRIES = new Set([".git", ".omp", ".pi", ".envrc", ".vscode"]);

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

const NAMED_ENTITIES: Record<string, string> = {
  colon: ":",
  sol: "/",
  tab: "\t",
  newline: "\n",
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (match, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&(colon|sol|tab|newline);/gi, (_match, entity: string) => NAMED_ENTITIES[entity.toLowerCase()] ?? "");
}

/**
 * OMP fetches `<img src>` values that start with http(s):// when it renders an
 * ask form. Rather than re-implement its HTML parser (attribute order, quoted
 * `>`, `<image>` aliasing, inline SVG), any URL-like text anywhere in the
 * payload sends the call to classifier review.
 */
function mayLoadRemoteContent(input: unknown): boolean {
  const text = decodeHtmlEntities(stableStringify(input)).replace(/[\u0000-\u0020]/g, "");
  return /https?:|\/\//i.test(text);
}

export function isInteractiveUiOnlyTool(toolName: string, input: unknown, hasUI: boolean): boolean {
  return hasUI && toolName.trim().toLowerCase() === "ask" && !mayLoadRemoteContent(input);
}

/**
 * Whether a tool name can be trusted to mean the host's own tool. OMP and Pi
 * report `sourceInfo.source` ("builtin", "mcp", "sdk", "extension") from
 * getAllTools(); only "builtin" qualifies. Hosts that expose no tool list, or
 * tool entries without source info, fall back to trusting the name.
 */
export function isBuiltinTool(toolDefinition: unknown, toolListAvailable: boolean): boolean {
  if (toolDefinition === undefined) {
    return !toolListAvailable;
  }
  const source = toRecord(toRecord(toolDefinition).sourceInfo).source;
  return typeof source !== "string" || source === "builtin";
}

/**
 * Read-only tools are recognised by name only. Self-declared metadata
 * (`isReadOnly`, `readOnlyHint`, MCP `annotations.readOnlyHint`) comes from
 * the tool's author, and the MCP spec marks those hints as untrusted.
 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName.trim().toLowerCase());
}

function parseJsonStringArray(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A read target that may skip review: a session-local internal URL, or a local
 * path inside the workspace or a configured read root that is not
 * credential-like below that directory. OMP reads URLs (`http(s)://`,
 * `www.`), internal schemes (`ssh://`, `mcp://`, ...), strips `@` and `:`
 * prefixes, unquotes `"…"`, and accepts JSON-array strings as several scopes.
 * Apart from `~/` expansion, every form other than a plain path or a JSON
 * array of plain paths is left to review instead of being re-implemented here.
 */
function isReadTarget(value: unknown, roots: ReadRoots, depth = 0): boolean {
  if (Array.isArray(value)) {
    return depth === 0 && value.length > 0 && value.every((item) => isReadTarget(item, roots, depth + 1));
  }
  if (typeof value !== "string") {
    return false;
  }
  let trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("[")) {
    const entries = depth === 0 ? parseJsonStringArray(trimmed) : null;
    return entries !== null && isReadTarget(entries, roots, depth);
  }
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme) {
    return LOCAL_READ_SCHEMES.has(scheme);
  }
  // OMP expands `~` and `~/…` to the home directory; `~user` stays reviewed.
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    trimmed = join(homedir(), trimmed.slice(1));
  }
  if (/^[@:"'~]/.test(trimmed) || /^www\./i.test(trimmed) || /[?#]/.test(trimmed) || trimmed.includes("://")) {
    return false;
  }
  // A colon before the first path separator may name a scheme (`https:/x`,
  // `ssh:host`) rather than a file; Windows drive letters are the exception.
  const beforeSeparator = trimmed.split(/[\\/]/, 1)[0];
  if (beforeSeparator.includes(":") && !/^[a-z]:$/i.test(beforeSeparator) && !/\.[^:]*:/.test(beforeSeparator)) {
    return false;
  }
  // `path:selector` reads lines from `path`; check both spellings.
  const withoutSelector = trimmed.replace(/:[^:\\/]*$/, "");
  return [trimmed, withoutSelector].every((candidate) => {
    // Resolve against the session cwd first: that is where OMP resolves it.
    const absolute = resolvePathForCwd(candidate, roots.cwd);
    return [roots.cwd, ...roots.extra].some((root) => {
      const relative = relativePathWithin(absolute, root);
      return relative !== null && !isSensitivePath(relative);
    });
  });
}


/**
 * Read fast path: every target named in the payload must pass
 * isReadTarget. A call naming no target reads the workspace itself.
 * OMP's grep and glob include hidden files but honour .gitignore, which keeps
 * the usual ignored `.env` out of a workspace-wide search; a search that turns
 * that off is reviewed.
 */
export function isWorkspaceReadFastPath(input: unknown, roots: ReadRoots): boolean {
  const record = toRecord(input);
  if (record.gitignore === false) {
    return false;
  }
  const targets = READ_TARGET_KEYS.filter((key) => record[key] !== undefined && record[key] !== null).map((key) => record[key]);
  return targets.every((target) => isReadTarget(target, roots));
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

function collectWriteDestinations(value: unknown, found: unknown[], depth = 0): void {
  if (depth > 4 || !value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectWriteDestinations(item, found, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (WRITE_DESTINATION_KEYS.has(key)) {
      found.push(child);
    } else {
      collectWriteDestinations(child, found, depth + 1);
    }
  }
}

/**
 * True only for an ordinary filesystem path. OMP rewrites some path forms
 * before resolving them (`[path]` / `[path#hash]` are unwrapped, `~` may be
 * expanded, `scheme://` paths are internal resources), so those never qualify.
 */
function isPlainPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0
    && !trimmed.startsWith("[")
    && !trimmed.endsWith("]")
    && !trimmed.startsWith("~")
    && !(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed));
}

function isProtectedWorkspacePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => PROTECTED_WORKSPACE_ENTRIES.has(segment.toLowerCase()));
}

/**
 * Write/edit fast path: every destination named anywhere in the payload must be
 * a plain path inside the workspace and outside protected entries.
 */
export function isWorkspaceWriteFastPath(input: unknown, cwd: string): boolean {
  const destinations: unknown[] = [];
  collectWriteDestinations(input, destinations);
  return destinations.length > 0 && destinations.every((destination) => {
    if (typeof destination !== "string" || !isPlainPath(destination)) {
      return false;
    }
    const relative = relativePathWithin(destination, cwd);
    return relative !== null && !isProtectedWorkspacePath(relative);
  });
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
