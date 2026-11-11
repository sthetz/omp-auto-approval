import type {
  AuthResolution,
  ClearanceConfig,
  ExtensionContextLike,
  KeybindingsLike,
  Reviewer,
  ThemeLike,
  TuiLike,
} from "./types.js";
import type { ClassifierClient } from "./classifier.js";
import type { CommandRules } from "./command-rules.js";
import { getString, toRecord } from "./common.js";
import { jobsIdle, runDecision, sessionKey, type CanonicalToolCall, type Decision } from "./decision.js";
import { writeAudit } from "./logging.js";
import { unreadableLspLocation, withheldLspResultText } from "./lsp-results.js";
import { createReviewSubject, resolveReadRoots } from "./tool-routing.js";
import {
  appliedEditMismatch,
  cleanPreviewFiles,
  isLspEditApply,
  isLspEditPreview,
  lspEditKey,
  lspWritable,
  PREVIEW_NOTE,
} from "./lsp-edits.js";
import type { SessionApprovalStore } from "./session-approval-store.js";

/** OMP runs the call on an empty object and blocks it on `block: true`. */
export type ToolCallDecision = Record<string, never> | { block: true; reason: string };

/** OMP event → canonical tool call. Every event field is untrusted. */
export function canonicalToolCall(event: unknown): CanonicalToolCall {
  const record = toRecord(event);
  const direct = getString(record.toolName) ?? getString(record.name);
  const toolRecord = toRecord(record.tool);
  const toolCallId = getString(record.toolCallId);
  return {
    toolName: direct ?? getString(toolRecord.name) ?? getString(toolRecord.toolName) ?? null,
    input: record.input !== undefined ? record.input : (record.arguments ?? {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function canonicalAuthResolution(value: unknown): AuthResolution {
  const record = toRecord(value);
  const headers = stringRecord(record.headers);
  const env = stringRecord(record.env);
  const error = getString(record.error);
  return {
    ok: record.ok === true,
    ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(env ? { env } : {}),
    ...(error ? { error } : {}),
  };
}

/** The TUI handle OMP passes to a custom component's factory. */
function canonicalTui(value: unknown): TuiLike {
  const record = toRecord(value);
  const requestRender = record.requestRender;
  return typeof requestRender === "function"
    ? {
        requestRender: () => {
          requestRender.call(record);
        },
      }
    : {};
}

function canonicalTheme(value: unknown): ThemeLike {
  const record = toRecord(value);
  const fg = record.fg;
  return typeof fg === "function"
    ? {
        fg: (name, text) => {
          const styled: unknown = fg.call(record, name, text);
          return typeof styled === "string" ? styled : text;
        },
      }
    : {};
}

function canonicalKeybindings(value: unknown): KeybindingsLike {
  const record = toRecord(value);
  const matches = record.matches;
  return typeof matches === "function"
    ? {
        matches: (data, key) => {
          // As before: only no answer falls back to the built-in keys.
          const matched: unknown = matches.call(record, data, key);
          return matched === undefined || matched === null ? undefined : Boolean(matched);
        },
      }
    : {};
}

/**
 * Validate OMP's extension context once. Internal code receives only the
 * fields and return shapes declared in ExtensionContextLike.
 */
export function canonicalContext(value: unknown): ExtensionContextLike | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = toRecord(value);
  const cwd = getString(record.cwd);
  const mode = getString(record.mode);
  const context: ExtensionContextLike = {
    hasUI: record.hasUI === true,
    ...(cwd ? { cwd } : {}),
    ...(mode ? { mode } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
  };

  if (typeof record.abort === "function") {
    const abort = record.abort;
    context.abort = () => {
      abort.call(record);
    };
  }
  if (typeof record.getAsyncJobSnapshot === "function") {
    const getAsyncJobSnapshot = record.getAsyncJobSnapshot;
    // OMP returns null when the session has no job manager, so no jobs.
    // Anything else it cannot read counts as a running job.
    context.runningJobCount = () => {
      const snapshot: unknown = getAsyncJobSnapshot.call(record);
      if (snapshot === null || snapshot === undefined) {
        return 0;
      }
      const running = toRecord(snapshot).running;
      return Array.isArray(running) ? running.length : 1;
    };
  }

  const uiRecord = toRecord(record.ui);
  const ui: NonNullable<ExtensionContextLike["ui"]> = {};
  if (typeof uiRecord.select === "function") {
    const select = uiRecord.select;
    ui.select = async (title, options, optionsOverride) =>
      getString(await select.call(uiRecord, title, options, optionsOverride));
  }
  if (typeof uiRecord.input === "function") {
    const input = uiRecord.input;
    ui.input = async (title, placeholder, optionsOverride) =>
      getString(await input.call(uiRecord, title, placeholder, optionsOverride));
  }
  if (typeof uiRecord.custom === "function") {
    const custom = uiRecord.custom;
    ui.custom = async <T>(
      factory: (tui: TuiLike, theme: ThemeLike, keybindings: KeybindingsLike, done: (result: T) => void) => unknown,
      optionsOverride?: unknown,
    ): Promise<T> =>
      // The extension-supplied factory, not OMP, determines this result type.
      (await custom.call(
        uiRecord,
        (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) =>
          factory(canonicalTui(tui), canonicalTheme(theme), canonicalKeybindings(keybindings), done),
        optionsOverride,
      )) as T;
  }
  if (typeof uiRecord.notify === "function") {
    const notify = uiRecord.notify;
    ui.notify = (message, type) => {
      notify.call(uiRecord, message, type);
    };
  }
  if (typeof uiRecord.setStatus === "function") {
    const setStatus = uiRecord.setStatus;
    ui.setStatus = (key, status) => {
      setStatus.call(uiRecord, key, status);
    };
  }
  if (record.ui !== undefined) {
    context.ui = ui;
  }

  const sessionRecord = toRecord(record.sessionManager);
  const sessionManager: NonNullable<ExtensionContextLike["sessionManager"]> = {};
  if (typeof sessionRecord.getEntries === "function") {
    const getEntries = sessionRecord.getEntries;
    sessionManager.getEntries = () => {
      const entries: unknown = getEntries.call(sessionRecord);
      return Array.isArray(entries) ? entries : [];
    };
  }
  if (typeof sessionRecord.getBranch === "function") {
    const getBranch = sessionRecord.getBranch;
    sessionManager.getBranch = () => {
      const entries: unknown = getBranch.call(sessionRecord);
      return Array.isArray(entries) ? entries : [];
    };
  }
  if (typeof sessionRecord.getHeader === "function") {
    const getHeader = sessionRecord.getHeader;
    sessionManager.getHeader = () => getHeader.call(sessionRecord);
  }
  if (typeof sessionRecord.getSessionId === "function") {
    const getSessionId = sessionRecord.getSessionId;
    sessionManager.getSessionId = () => getString(getSessionId.call(sessionRecord)) ?? "";
  }
  if (record.sessionManager !== undefined) {
    context.sessionManager = sessionManager;
  }

  const registryRecord = toRecord(record.modelRegistry);
  const modelRegistry: NonNullable<ExtensionContextLike["modelRegistry"]> = {};
  if (typeof registryRecord.refresh === "function") {
    const refresh = registryRecord.refresh;
    modelRegistry.refresh = () => refresh.call(registryRecord);
  }
  if (typeof registryRecord.getError === "function") {
    const getError = registryRecord.getError;
    modelRegistry.getError = () => getString(getError.call(registryRecord));
  }
  if (typeof registryRecord.find === "function") {
    const find = registryRecord.find;
    modelRegistry.find = (provider, id) => find.call(registryRecord, provider, id);
  }
  if (typeof registryRecord.getAvailable === "function") {
    const getAvailable = registryRecord.getAvailable;
    modelRegistry.getAvailable = async () => {
      const available: unknown = await getAvailable.call(registryRecord);
      return Array.isArray(available) ? (available as unknown[]) : [];
    };
  }
  if (typeof registryRecord.getApiKeyAndHeaders === "function") {
    const getApiKeyAndHeaders = registryRecord.getApiKeyAndHeaders;
    modelRegistry.getApiKeyAndHeaders = async (model) =>
      canonicalAuthResolution(await getApiKeyAndHeaders.call(registryRecord, model));
  }
  if (record.modelRegistry !== undefined) {
    context.modelRegistry = modelRegistry;
  }

  return context;
}

/** OMP's getAllTools() result → the tool list the static evaluator accepts. */
export function canonicalTools(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Final Decision → OMP's tool_call response. */
export function ompToolCallResponse(decision: Decision): ToolCallDecision {
  if (decision.outcome === "allow") {
    return {};
  }
  if (decision.outcome === "deny") {
    return { block: true, reason: decision.reason ?? "Tool call was blocked." };
  }
  throw new Error(`Decision still needs ${decision.outcome}; apply() must finish it before OMP gets a response.`);
}

/** What a `tool_result` handler returns to replace the result OMP passes on. */
export type ToolResultReplacement = { content: unknown[]; isError?: true } | undefined;

/**
 * Check an OMP `tool_result` event for an `lsp` call. Every event field is
 * untrusted.
 *
 * - A result that shows source lines from a file the read fast path would
 *   not read is replaced, so the agent never sees them.
 * - An edit preview whose files could all be written without review is
 *   remembered, so the apply that repeats it can skip review, and the agent
 *   is told so. Any other preview of the same call forgets an earlier one.
 * - The result of an apply that skipped review is compared with its
 *   preview; a difference is reported and turns lsp edits back to review
 *   for the session.
 */
export async function reviewToolResult(
  event: unknown,
  ctx: ExtensionContextLike,
  config: ClearanceConfig,
  options: { store: SessionApprovalStore; protectedFiles: string[] },
): Promise<ToolResultReplacement> {
  const { toolName, input, toolCallId } = canonicalToolCall(event);
  const { store } = options;
  if (toolCallId !== undefined) {
    store.noteResult(toolCallId);
  }
  if (toolName !== "lsp") {
    return undefined;
  }
  const record = toRecord(event);
  const content: unknown[] = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((part) => getString(toRecord(part).text))
    .filter((part) => part !== undefined)
    .join("\n");
  const cwd = ctx.cwd || process.cwd();
  const session = sessionKey(ctx);
  const subject = () => createReviewSubject(toolName, input, cwd);
  const action = getString(toRecord(input).action) ?? "";

  // An apply let through on a preview: compare what it did with the preview.
  const previewFiles = toolCallId !== undefined ? store.finishLspApply(toolCallId) : undefined;
  if (previewFiles) {
    const line = appliedEditMismatch(action, text, record.isError === true, previewFiles);
    if (line !== null) {
      store.turnLspEditsOff(session, line);
      const { actionSummary, actionHash } = subject();
      await writeAudit(config, { event: "lsp_edit_mismatch", toolName, actionSummary, actionHash, line });
      ctx.ui?.notify?.(
        `omp-clearance: an lsp ${action} that skipped review changed more than its preview showed, or its result could not be checked (${line}). lsp edits are reviewed for the rest of this session; check what it changed.`,
        "warning",
      );
    }
  }

  const key = lspEditKey(input, session, cwd);
  const isPreview = key !== null && isLspEditPreview(input);
  const path = unreadableLspLocation(content, resolveReadRoots(cwd, config.readRoots));
  if (path !== null) {
    if (isPreview && toolCallId !== undefined) {
      // Withheld, so not a usable preview; an earlier one of this call goes too.
      store.finishLspPreview(toolCallId, key, null);
    }
    const { actionSummary, actionHash } = subject();
    await writeAudit(config, { event: "result_withheld", toolName, actionSummary, actionHash, path });
    return { content: [{ type: "text", text: withheldLspResultText(path) }], isError: true };
  }

  if (key === null || !isPreview) {
    return undefined;
  }
  const files =
    record.isError === true ? null : cleanPreviewFiles(action, text, lspWritable(cwd, options.protectedFiles));
  const recorded = toolCallId !== undefined && store.finishLspPreview(toolCallId, key, files);
  // Tell the agent only when the apply would in fact skip review.
  const applies =
    recorded &&
    store.hasLspPreview(session, key) &&
    jobsIdle(ctx) &&
    isLspEditApply({ ...toRecord(input), apply: true }, cwd, options.protectedFiles);
  return applies ? { content: [...content, { type: "text", text: PREVIEW_NOTE }] } : undefined;
}

/** Run the canonical pipeline for an OMP event and adapt its final response. */
export async function evaluateToolCall(
  event: unknown,
  ctx: ExtensionContextLike,
  config: ClearanceConfig,
  store: SessionApprovalStore,
  options: {
    reviewer?: Reviewer;
    tools?: unknown[];
    classifierClient?: ClassifierClient;
    agentMessage?: string;
    rules?: CommandRules;
  } = {},
): Promise<ToolCallDecision> {
  return ompToolCallResponse(await runDecision(canonicalToolCall(event), ctx, config, store, options));
}
