import type { ClearanceConfig, ExtensionContextLike, ClassifierDecision, ReviewSubject } from "./types.js";
import { buildProjectedContext } from "./context-projection.js";
import type { CommandRule } from "./command-rules.js";
import { buildSystemPrompt } from "./prompt.js";
import { toRecord } from "./common.js";

export type ClassifierClient = (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<unknown>;

async function loadCompleteSimple(): Promise<ClassifierClient> {
  // The specifier must stay a string literal: OMP serves its bundled host
  // packages only for imports it can see statically. A computed
  // `import(name)` bypasses that and needs a separately installed copy.
  const mod: unknown = await import("@oh-my-pi/pi-ai");
  const completeSimple = toRecord(mod).completeSimple;
  if (typeof completeSimple !== "function") {
    throw new Error("Could not load completeSimple from @oh-my-pi/pi-ai.");
  }
  return completeSimple as ClassifierClient;
}

function extractAssistantText(message: unknown): string | undefined {
  const record = toRecord(message);
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const itemRecord = toRecord(item);
        return typeof itemRecord.text === "string" ? itemRecord.text : "";
      })
      .join("");
  }
  if (Array.isArray(record.output)) {
    return record.output
      .map((item) => toRecord(item).text)
      .filter((text): text is string => typeof text === "string")
      .join("");
  }
  return undefined;
}

export function parseClassifierDecision(text: string | undefined): ClassifierDecision {
  if (!text) {
    throw new Error("Classifier returned no text.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Classifier output was not valid JSON.");
    }
    payload = JSON.parse(text.slice(start, end + 1));
  }

  const record = toRecord(payload);
  if (record.outcome !== "allow" && record.outcome !== "deny") {
    throw new Error("Classifier JSON is missing outcome allow/deny.");
  }
  const decision: ClassifierDecision = { outcome: record.outcome };
  if (["low", "medium", "high", "critical"].includes(String(record.risk_level))) {
    decision.risk_level = record.risk_level as ClassifierDecision["risk_level"];
  }
  if (["unknown", "low", "medium", "high"].includes(String(record.user_authorization))) {
    decision.user_authorization = record.user_authorization as ClassifierDecision["user_authorization"];
  }
  if (typeof record.rationale === "string" && record.rationale.trim()) {
    decision.rationale = record.rationale.trim();
  }
  return decision;
}

/**
 * Deterministic guard on the classifier's own risk assessment: an "allow" for
 * an action it rates high risk needs high user authorization, and a critical
 * one is never allowed without it. Catches a model that contradicts itself,
 * for example after being steered by text inside the action.
 */
export function applyDecisionPolicy(decision: ClassifierDecision): ClassifierDecision {
  if (decision.outcome !== "allow") {
    return decision;
  }
  const risky = decision.risk_level === "high" || decision.risk_level === "critical";
  if (!risky || decision.user_authorization === "high") {
    return decision;
  }
  const authorization = decision.user_authorization ?? "unstated";
  return {
    ...decision,
    outcome: "deny",
    rationale: `The reviewer rated this ${decision.risk_level} risk with ${authorization} user authorization, which needs explicit approval.${decision.rationale ? ` Reviewer note: ${decision.rationale}` : ""}`,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`classifier timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    // A rejection of the classifier call comes through race() unchanged.
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function splitModelRef(modelRef: string, currentModel: Record<string, unknown>): { provider?: string; id: string } {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: modelRef.slice(0, slashIndex),
      id: modelRef.slice(slashIndex + 1),
    };
  }
  return {
    provider: typeof currentModel.provider === "string" ? currentModel.provider : undefined,
    id: modelRef,
  };
}

function resolveClassifierModel(ctx: ExtensionContextLike, config: ClearanceConfig): unknown {
  const currentModel = ctx.model;
  if (!config.classifierModel) {
    return currentModel;
  }

  const currentModelRecord = toRecord(currentModel);
  const { provider, id } = splitModelRef(config.classifierModel, currentModelRecord);
  if (provider) {
    const found = ctx.modelRegistry?.find?.(provider, id);
    if (found) {
      return found;
    }
  }

  return provider ? { ...currentModelRecord, provider, id } : { ...currentModelRecord, id };
}

/**
 * Resolve request auth (apiKey/headers/env) for the classifier model through
 * the same ModelRegistry path pi uses for normal model calls.
 *
 * The compat `completeSimple` the classifier invokes only injects an API key
 * from the known provider env-var map; it never reads ~/.pi/agent/models.json.
 * Custom providers whose apiKey/headers live in models.json (or OAuth-backed
 * providers whose token lives in auth storage) therefore send unauthenticated
 * requests and fail opaquely. By mirroring ModelRegistry.getApiKeyAndHeaders
 * here and passing the result into `completeSimple` as request options, the
 * classifier stays on the same auth chain as the rest of pi.
 */
async function resolveRequestAuth(
  ctx: ExtensionContextLike,
  model: unknown,
): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }> {
  // OMP's result was already checked at the boundary (canonicalAuthResolution).
  const registry = ctx.modelRegistry;
  if (!registry?.getApiKeyAndHeaders) {
    return {};
  }
  const result = await registry.getApiKeyAndHeaders(model);
  if (!result.ok) {
    const error = result.error?.trim() || "auth resolution reported failure with no error message";
    throw new Error(`Could not resolve classifier model auth: ${error}`);
  }
  const { apiKey, headers, env } = result;
  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(env ? { env } : {}),
  };
}

export async function classifyAction(
  ctx: ExtensionContextLike,
  config: ClearanceConfig,
  subject: ReviewSubject,
  client?: ClassifierClient,
  context: { agentMessage?: string; rule?: CommandRule; ruleTextOnly?: boolean } = {},
): Promise<ClassifierDecision> {
  const completeSimple = client ?? (await loadCompleteSimple());

  const model = resolveClassifierModel(ctx, config);
  if (!model) {
    throw new Error("No active model is available for the approval classifier.");
  }

  const auth = await resolveRequestAuth(ctx, model);

  const controller = new AbortController();
  const response = await withTimeout(
    completeSimple(
      model,
      {
        systemPrompt: buildSystemPrompt(config),
        messages: [
          {
            role: "user",
            content: buildProjectedContext(ctx, subject, context),
            timestamp: Date.now(),
          },
        ],
      },
      {
        temperature: 0,
        ...auth,
        signal: controller.signal,
      },
    ),
    config.classifierTimeoutSeconds * 1000,
    controller,
  );

  const responseText = extractAssistantText(response);
  if (!responseText) {
    const responseRecord = toRecord(response);
    const upstreamError = typeof responseRecord.errorMessage === "string" ? responseRecord.errorMessage.trim() : "";
    if (upstreamError) {
      throw new Error(`Classifier request failed: ${upstreamError}`);
    }
    throw new Error("Classifier returned no text.");
  }
  return applyDecisionPolicy(parseClassifierDecision(responseText));
}
