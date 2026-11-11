import type { AuthResolution, ClearanceConfig, ExtensionContextLike, Reviewer } from "./types.js";
import type { ClassifierClient } from "./classifier.js";
import type { CommandRules } from "./command-rules.js";
import { getString, toRecord } from "./common.js";
import { runDecision, type CanonicalToolCall, type Decision } from "./decision.js";
import type { SessionApprovalStore } from "./session-approval-store.js";

/** OMP runs the call on an empty object and blocks it on `block: true`. */
export type ToolCallDecision = Record<string, never> | { block: true; reason: string };

/** OMP event → canonical tool call. Every event field is untrusted. */
export function canonicalToolCall(event: unknown): CanonicalToolCall {
  const record = toRecord(event);
  const direct = getString(record.toolName) ?? getString(record.name);
  const toolRecord = toRecord(record.tool);
  return {
    toolName: direct ?? getString(toolRecord.name) ?? getString(toolRecord.toolName) ?? null,
    input: record.input !== undefined ? record.input : (record.arguments ?? {}),
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
      factory: Parameters<NonNullable<NonNullable<ExtensionContextLike["ui"]>["custom"]>>[0],
      optionsOverride?: unknown,
    ): Promise<T> =>
      // The extension-supplied factory, not OMP, determines this result type.
      (await custom.call(uiRecord, factory, optionsOverride)) as T;
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
      return Array.isArray(available) ? available : [];
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
