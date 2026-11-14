import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  canonicalPath,
  getString,
  isRecord,
  itemAt,
  relativePathWithin,
  resolvePathForCwd,
  sha256,
  stableStringify,
  toRecord,
  truncateInline,
  type ReadRoots,
} from "./common.js";

export { resolveReadRoots, type ReadRoots } from "./common.js";
import { isSensitivePath } from "./sensitive-paths.js";
import type { ReviewSubject } from "./types.js";

const LOCAL_STATE_TOOLS: Readonly<Record<string, true>> = { todo: true, wait: true, yield: true };

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
const LOCAL_READ_SCHEMES: Readonly<Record<string, true>> = {
  skill: true,
  rule: true,
  agent: true,
  history: true,
  artifact: true,
  memory: true,
  local: true,
  omp: true,
};

// Keys that can name a write destination anywhere in a write/edit payload,
// e.g. OMP's patch-mode edit `{ path, edits: [{ rename }] }`.
const WRITE_DESTINATION_KEYS = new Set([...PATH_KEYS, "rename", "move", "to", "newPath", "new_path", "destination"]);

// Workspace entries whose contents run code or configure an agent later,
// without a tool call this extension could review. Matched as a path segment
// at any depth, because a session can start in a subdirectory.
const PROTECTED_WORKSPACE_ENTRIES = new Set([
  // Git config and hooks: fast-pathed git commands run them (`git status`
  // runs core.fsmonitor).
  ".git",
  ".husky",
  // Agent and editor settings. OMP reads its own and other agents' project
  // config at session start and starts the MCP servers, tools, hooks and
  // plugins they name (checked in OMP 18.18.8 for `.mcp.json`, `mcp.json`,
  // `.codex/config.toml`, `.gemini/settings.json`, `opencode.json` and
  // `.windsurf/mcp_config.json`). `ssh.json` names the hosts OMP's ssh tool
  // connects to.
  ".omp",
  ".pi",
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".cursor",
  ".windsurf",
  ".mcp.json",
  "mcp.json",
  "opencode.json",
  "opencode.jsonc",
  "ssh.json",
  ".ssh.json",
  ".envrc",
  ".vscode",
  ".idea",
  ".devcontainer",
  // Language servers. OMP starts them when a code file is written
  // (`lsp.diagnosticsOnWrite` is on by default), reads their command from
  // these files, looks for their programs under `node_modules/.bin` and
  // the virtualenv `bin` directories first, and typescript-language-server
  // runs the workspace's `node_modules/typescript/lib/tsserver.js`.
  "lsp.json",
  ".lsp.json",
  "lsp.yaml",
  ".lsp.yaml",
  "lsp.yml",
  ".lsp.yml",
  "node_modules",
  ".venv",
  "venv",
  ".env",
]);

/** Ordinary children inherit extensions; historical forks and isolated merge/apply runs do not fit this boundary. */
function isOrdinaryAgentSpawn(input: unknown): input is Record<string, unknown> {
  return (
    isRecord(input) &&
    (input.isolated == null || input.isolated === false) &&
    input.sourceSession == null &&
    (typeof input.agent !== "string" || input.agent.trim().toLowerCase() !== "seance")
  );
}

/** Internal bookkeeping or agent orchestration; the caller must verify the tool is built-in. */
export function isLocalStateTool(toolName: string, input: unknown): boolean {
  const name = toolName.trim().toLowerCase();
  if (LOCAL_STATE_TOOLS[name] === true) {
    return true;
  }
  if (name === "task") {
    return (
      isOrdinaryAgentSpawn(input) &&
      (input.tasks == null || (Array.isArray(input.tasks) && input.tasks.every(isOrdinaryAgentSpawn)))
    );
  }
  // OMP 18.20.0 reserves agent:// for handler-owned coordination writes.
  // Every target in this namespace sends a message or errors; it never falls
  // back to writing the output artifact. Do not inspect message text as code.
  return (
    name === "write" &&
    isRecord(input) &&
    typeof input.path === "string" &&
    /^agent:\/\//i.test(input.path) &&
    typeof input.content === "string" &&
    Object.keys(input).every((key) => key === "path" || key === "content")
  );
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
 * Whether a tool name can be trusted to mean the host's own tool. OMP
 * reports `sourceInfo.source` ("builtin", "mcp", "sdk", "extension") from
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

// Match OMP's filesystem splitter (packages/tui/src/tools/read.ts), not an
// arbitrary colon suffix. Bounds are validated by the host; recognition also
// includes invalid bounds so a malformed selector cannot hide a sensitive base.
const READ_RANGE_CHUNK = String.raw`(?:L?\d+(?:(?:\.\.|[-+])L?(?:\d+)?)?(?<=[\d.-])|-\d+)`;
const READ_RANGE_LIST = new RegExp(`^${READ_RANGE_CHUNK}(?:,${READ_RANGE_CHUNK})*$`, "i");
const READ_SELECTOR = new RegExp(`^(?:${READ_RANGE_CHUNK}(?:,${READ_RANGE_CHUNK})*|raw|conflicts|img)$`, "i");
const CONTAINER_PATH =
  /\.(?:tar\.(?:gz|bz2|xz|zst|z)|zip|jar|war|ear|apk|whl|ipa|xpi|vsix|nupkg|cbz|tar|tgz|tbz2?|txz|tzst|asar|rar|cbr|7z|iso|cab|cpio|rpm|ar|a|lib|deb|lzh|lha|arj|gz|bz2|xz|zst|z|lzma|sqlite3?|db3?)(?=:|$)/gi;

function splitReadSelector(value: string, foldLists: boolean): string {
  const colon = value.lastIndexOf(":");
  const suffix = value.slice(colon + 1);
  if (colon <= 0 || !READ_SELECTOR.test(suffix)) return value;
  let base = value.slice(0, colon);
  let list = READ_RANGE_LIST.test(suffix) ? suffix : undefined;
  let rawSuffix = false;
  if (/^raw$/i.test(suffix)) {
    const innerColon = base.lastIndexOf(":");
    const inner = base.slice(innerColon + 1);
    if (innerColon > 0 && READ_RANGE_LIST.test(inner)) {
      list = inner;
      rawSuffix = true;
      base = base.slice(0, innerColon);
    }
  }
  if (list === undefined) return base;
  if (foldLists) {
    const chunks = list.split(",").reverse();
    const originalBase = base;
    let dashed = false;
    while (true) {
      const innerColon = base.lastIndexOf(":");
      if (innerColon < 1) break;
      const head = base.slice(innerColon + 1);
      if (head.endsWith(",")) {
        const repeated = head.slice(0, -1);
        if (!READ_RANGE_LIST.test(repeated)) break;
        chunks.push(...repeated.split(",").reverse());
      } else {
        const preceding = head.split(",");
        const start = itemAt(preceding, preceding.length - 1);
        preceding.pop();
        const end = itemAt(chunks, chunks.length - 1);
        if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) break;
        if (preceding.length > 0 && !READ_RANGE_LIST.test(preceding.join(","))) break;
        chunks[chunks.length - 1] = `${start}-${end}`;
        chunks.push(...preceding.reverse());
        dashed = true;
      }
      base = base.slice(0, innerColon);
    }
    if (dashed && chunks.length === 1) base = originalBase;
  }
  if (!rawSuffix) {
    const innerColon = base.lastIndexOf(":");
    if (innerColon > 0 && /^raw$/i.test(base.slice(innerColon + 1))) base = base.slice(0, innerColon);
  }
  return base;
}

function readResourceCandidates(value: string): string[] {
  // read/grep prefer existing literals, including dangling links; other tools
  // split numerics differently. Authorize every interpretation, never just the
  // currently existing one. Keep the unfolded list spelling for literal probes.
  return [...new Set([value, splitReadSelector(value, true), splitReadSelector(value, false)])];
}

function filesystemSpellings(value: string, cwd: string): string[] {
  const raw = resolvePathForCwd(value, cwd);
  // OMP resolveToCwd preserves absolute inputs but path.resolve normalizes
  // relative ones. Other consumers open the raw spelling; both must be safe.
  return isAbsolute(value) ? [raw] : [...new Set([raw, resolve(cwd, value)])];
}

function isSafeReadResource(value: string, roots: ReadRoots): boolean {
  return filesystemSpellings(value, roots.cwd).every((absolute) =>
    [roots.cwd, ...roots.extra].some((root) => {
      const relative = relativePathWithin(absolute, root);
      return relative !== null && !isSensitivePath(relative);
    }),
  );
}

/**
 * A read target that may skip review: a session-local internal URL, or a local
 * path inside the workspace or a configured read root that is not
 * credential-like below that directory. OMP reads URLs (`http(s)://`,
 * `www.`), internal schemes (`ssh://`, `mcp://`, ...), strips `@` and `:`
 * prefixes, unquotes `"…"`, and accepts JSON-array strings as several scopes.
 * Recognized read selectors are checked before sensitive-path checks. Literal
 * colon names and every plausible selector/container interpretation must pass.
 */
export function isReadTarget(value: unknown, roots: ReadRoots, depth = 0): boolean {
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
    // These exact host documentation topics do not dispatch a device.
    return LOCAL_READ_SCHEMES[scheme] === true || trimmed === "xd://read/sources" || trimmed === "xd://read/urls";
  }
  // OMP expands `~` and `~/…` to the home directory; `~user` stays reviewed.
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    trimmed = homedir() + trimmed.slice(1);
  }
  if (/^[@:"'~]/.test(trimmed) || /^www\./i.test(trimmed) || /[?#]/.test(trimmed) || trimmed.includes("://")) {
    return false;
  }
  // URL shorthands are not literal filenames; ordinary unknown colons are.
  if (/^(?:https?|ssh|mcp|vault|cfg|proc|xd):/i.test(trimmed)) return false;
  return readResourceCandidates(trimmed).every((candidate) => {
    if (!isSafeReadResource(candidate, roots)) return false;
    // Archive and SQLite syntax can select resources after multiple colons.
    // Check every container prefix, not only the longest one the host probes.
    for (const match of candidate.matchAll(CONTAINER_PATH)) {
      const end = match.index + match[0].length;
      if (!isSafeReadResource(candidate.slice(0, end), roots)) return false;
      const member = candidate.slice(end).replace(/^:+/, "");
      for (const interpretation of readResourceCandidates(member)) {
        // Colons delimit SQLite table/key selectors as well as archive names.
        // Treat each component as potentially credential-bearing.
        if (interpretation.split(/[\\/]/).includes("..") || interpretation.split(":").some(isSensitivePath))
          return false;
      }
    }
    return true;
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
  const targets = READ_TARGET_KEYS.filter((key) => record[key] !== undefined && record[key] !== null).map(
    (key) => record[key],
  );
  return targets.every((target) => isReadTarget(target, roots));
}

// OMP's `lsp` actions that only ask a language server a question. OMP lists
// the same ones as its read-only set. `diagnostics` on `*` is the exception:
// it runs the project's checker (`cargo check`, `npx tsc`, `go build`,
// `pyright`) in the workspace, so it is reviewed below.
const LSP_QUERY_ACTIONS = new Set([
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
  "symbols",
  "status",
  "capabilities",
  "diagnostics",
]);

// The `lsp` tool's parameters in OMP 18.18.8, except `payload`, which only
// `request` (a raw LSP method) uses. Anything else is reviewed.
const LSP_QUERY_FIELDS = new Set(["action", "file", "line", "symbol", "query", "new_name", "apply", "timeout"]);

/**
 * A path an `lsp` call names: one plain path the read fast path accepts. OMP
 * takes it literally for most actions but as a glob for `diagnostics`, so
 * glob characters are reviewed.
 */
function isLspTarget(value: unknown, roots: ReadRoots): boolean {
  return value === undefined || (typeof value === "string" && !/[*?[\]{}]/.test(value) && isReadTarget(value, roots));
}

/**
 * LSP read fast path: an `lsp` call that only asks the language server a
 * question, or previews an edit without applying it, about files the read
 * fast path could read anyway. `rename` and `rename_file` apply unless
 * `apply` is false; `code_actions` applies only when `apply` is true. Applied
 * edits are reviewed: the language server picks the files they change, after
 * this decision, and OMP writes them without any path check.
 */
export function isLspReadFastPath(input: unknown, roots: ReadRoots): boolean {
  if (!isRecord(input) || Object.keys(input).some((key) => !LSP_QUERY_FIELDS.has(key) && input[key] !== undefined)) {
    return false;
  }
  const { action, file, apply } = input;
  if (apply !== undefined && typeof apply !== "boolean") {
    return false;
  }
  const isPreview =
    ((action === "rename" || action === "rename_file") && apply === false) ||
    (action === "code_actions" && apply !== true);
  if (typeof action !== "string" || !(LSP_QUERY_ACTIONS.has(action) || isPreview)) {
    return false;
  }
  // `*` means the whole workspace. For `symbols` that is a symbol search;
  // `diagnostics` on `*` runs the project's checker, and the other actions
  // have no use for it.
  if (file === "*" && action === "symbols") {
    return true;
  }
  // rename_file's new_name is a path; rename's is the new symbol name.
  const targets = action === "rename_file" ? [file, input.new_name] : [file];
  return targets.every((target) => isLspTarget(target, roots));
}

/**
 * The agent can call a tool by writing its JSON arguments to `xd://<tool>`.
 * OMP then runs that tool as a call of its own, which reaches this extension
 * as a separate `tool_call` (the inner call has another tool name, so OMP's
 * wrapper emits it). For `lsp`, decide on that inner call and let the
 * outer write through. Only `xd://lsp`: other devices include `bash`.
 */
export function isLspDispatch(input: unknown): boolean {
  return (
    isRecord(input) &&
    input.path === "xd://lsp" &&
    typeof input.content === "string" &&
    Object.keys(input).every((key) => key === "path" || key === "content")
  );
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
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("[") &&
    !trimmed.endsWith("]") &&
    !trimmed.startsWith("~") &&
    !(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed))
  );
}

function isProtectedWorkspacePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => PROTECTED_WORKSPACE_ENTRIES.has(segment.toLowerCase()));
}

/**
 * OMP's write tool runs `chmod +x` on a file whose content starts with `#!`
 * (but not Rust's `#![`), so such a write creates a program.
 */
function writesProgram(input: unknown): boolean {
  const content = toRecord(input).content;
  return typeof content === "string" && startsAsProgram(content);
}

/** Text OMP's write tool would make executable: a `#!` line, but not Rust's `#![`. */
export function startsAsProgram(text: string): boolean {
  return text.startsWith("#!") && !text.startsWith("#![");
}

export function isExecutableFile(path: string, cwd: string): boolean {
  try {
    const stats = statSync(resolvePathForCwd(path, cwd));
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Write/edit fast path: every destination named anywhere in the payload must be
 * a plain path inside the workspace, outside protected entries, and not a
 * credential file. Writes that create or change a program are reviewed: a
 * program in the workspace can shadow a command on the persistent shell's
 * PATH, so `git status` would run it. So are writes to `protectedFiles`,
 * the extension's own config and rules files, when they are in the
 * workspace: changing them changes what is reviewed.
 */
export function isWorkspaceWriteFastPath(input: unknown, cwd: string, protectedFiles: string[] = []): boolean {
  if (writesProgram(input)) {
    return false;
  }
  const writable = workspaceWriteTarget(cwd, protectedFiles);
  const destinations: unknown[] = [];
  collectWriteDestinations(input, destinations);
  return destinations.length > 0 && destinations.every(writable);
}

/**
 * The workspace write fast path's check on one destination, with the
 * protected files resolved once: a plain path inside the workspace, not a
 * protected entry, protected file or credential file, and not an existing
 * program.
 */
export function workspaceWriteTarget(cwd: string, protectedFiles: string[] = []): (destination: unknown) => boolean {
  const protectedPaths = new Set(
    protectedFiles.flatMap((path) => filesystemSpellings(path, cwd).map((spelling) => canonicalPath(spelling, cwd))),
  );
  return (destination) => {
    if (protectedPaths.has(null) || typeof destination !== "string" || !isPlainPath(destination)) {
      return false;
    }
    return filesystemSpellings(destination, cwd).every((spelling) => {
      const relative = relativePathWithin(spelling, cwd);
      const canonical = canonicalPath(spelling, cwd);
      return (
        relative !== null &&
        canonical !== null &&
        !protectedPaths.has(canonical) &&
        !isProtectedWorkspacePath(relative) &&
        !isSensitivePath(relative) &&
        !isExecutableFile(spelling, cwd)
      );
    });
  };
}

export function isManualOnlyTool(toolName: string, toolDefinition?: unknown): boolean {
  const normalized = toolName.toLowerCase();
  const record = toRecord(toolDefinition);
  if (typeof record.requiresUserInteraction === "function") {
    try {
      if ((record as { requiresUserInteraction: () => unknown }).requiresUserInteraction()) {
        return true;
      }
    } catch {
      return true;
    }
  }
  if (record.requiresUserInteraction === true) {
    return true;
  }
  return (
    normalized.includes("computer") ||
    normalized.includes("browser_click") ||
    normalized.includes("browser_type") ||
    normalized.includes("chrome_click") ||
    normalized.includes("chrome_type") ||
    normalized.includes("install_plugin") ||
    normalized.includes("request_plugin_install") ||
    normalized.includes("mcp_config") ||
    normalized.includes("permission_config")
  );
}

export function findToolDefinition(toolName: string, tools: unknown[]): unknown {
  return tools.find((tool) => {
    const record = toRecord(tool);
    return record.name === toolName || record.toolName === toolName;
  });
}

export function createReviewSubject(toolName: string, input: unknown, cwd: string): ReviewSubject {
  const record = toRecord(input);
  const command = toolName === "bash" ? getString(record.command) : undefined;
  const path = getPathFromInput(input);
  // The classifier and the action hash get the command exactly as bash will
  // read it: collapsing whitespace would turn `echo a⏎rm x` into one
  // harmless-looking echo, and give both the same cached decision.
  // One line for display, with line breaks shown as `\n`: the classifier and
  // the approval dialog see this too, and must not see two commands as one.
  const actionSummary =
    toolName === "bash" && command
      ? `bash: ${truncateInline(command.replace(/\r/g, "\\r").replace(/\n/g, "\\n"))}`
      : path
        ? `${toolName}: ${truncateInline(path)}`
        : `${toolName}: ${truncateInline(stableStringify(input))}`;
  const hashSource = stableStringify({ toolName, cwd, input: record });
  return {
    toolName,
    input: record,
    cwd,
    actionSummary,
    actionHash: sha256(hashSource),
  };
}
