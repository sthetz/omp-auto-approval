import type { AuditEntry, AutoReviewConfig, ExtensionContextLike, ReviewDecision, ToolCallEventLike } from "./types.js";
import { matchBlockedCommand } from "./block-commands.js";
import { classifyAction, type ClassifierClient } from "./classifier.js";
import { writeAudit } from "./logging.js";
import { planSafeCommand, type SafeCommandPlan } from "./safe-command.js";
import { SessionApprovalStore } from "./session-approval-store.js";
import {
  createReviewSubject,
  findToolDefinition,
  getToolInput,
  getToolName,
  isBuiltinTool,
  isLocalStateTool,
  isInteractiveUiOnlyTool,
  isManualOnlyTool,
  isReadOnlyTool,
  isWorkspaceReadFastPath,
  isWorkspaceWriteFastPath,
  resolveReadRoots,
} from "./tool-routing.js";
import { getString, relativePathWithin, resolvePathForCwd, toRecord } from "./common.js";
import { requestHumanApproval } from "./human-approval.js";

export type ToolCallDecision = {} | { block: true; reason: string };

function deny(reason: string): ToolCallDecision {
  return { block: true, reason };
}

function classifierDenyReason(decision: ReviewDecision): string {
  return [
    "AI auto-approval rejected this action.",
    decision.rationale ? `Reason: ${decision.rationale}` : null,
    "Do not retry the same action unless the user explicitly approves it.",
  ].filter(Boolean).join(" ");
}

function failureDenyReason(reason: string): string {
  return `AI auto-approval could not approve this action: ${reason}`;
}

async function handleHumanFallback(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  subject: ReturnType<typeof createReviewSubject>,
  auditBase: { started: number; route: "classifier" | "manual_only"; classifierDecision?: ReviewDecision; failureReason?: string },
): Promise<ToolCallDecision> {
  const human = await requestHumanApproval(ctx, subject, {
    classifierDecision: auditBase.classifierDecision,
    failureReason: auditBase.failureReason,
    timeoutSeconds: config.approvalTimeoutSeconds,
  });
  if (human.approved) {
    if (human.persistence === "exact") {
      store.approveExact(subject.actionHash);
    } else {
      store.recordNonDenial();
    }
    await writeAudit(config, {
      event: "decision",
      route: "human",
      mode: config.mode,
      toolName: subject.toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "allow",
      classifierDecision: auditBase.classifierDecision,
      humanDecision: human.persistence,
      durationMs: Date.now() - auditBase.started,
    });
    return {};
  }

  if (human.state === "stop") {
    // The user ended the turn; the next one starts with a clean count.
    store.recordNonDenial();
    ctx.abort?.();
  } else {
    store.recordDenial();
  }
  const reason = human.state === "stop"
    ? "The user rejected this action and stopped the turn. Wait for the user's next message."
    : human.reason
      ?? auditBase.classifierDecision?.rationale
      ?? auditBase.failureReason
      ?? "Manual approval was rejected.";
  await writeAudit(config, {
    event: "decision",
    route: "human",
    mode: config.mode,
    toolName: subject.toolName,
    actionSummary: subject.actionSummary,
    actionHash: subject.actionHash,
    outcome: "deny",
    classifierDecision: auditBase.classifierDecision,
    humanDecision: human.state,
    reason,
    durationMs: Date.now() - auditBase.started,
  });
  return deny(reason);
}

export type FastPathRoute =
  | "blocked_command"
  | "local_state"
  | "ui_only"
  | "tool_allowlist"
  | "readonly"
  | "workspace_write"
  | "safe_command"
  | "manual_only";

function bashCommand(toolName: string, input: unknown): string | undefined {
  return toolName === "bash" ? getString(toRecord(input).command) : undefined;
}

/**
 * How a bash call that skips review runs (see planSafeCommand), or null. OMP's
 * bash tool accepts a `cwd`; relative paths are resolved from it, and a
 * directory outside the workspace gets no fast path.
 */
export function planBashCommand(toolName: string, input: unknown, cwd: string, config: AutoReviewConfig): SafeCommandPlan | null {
  const command = bashCommand(toolName, input);
  if (!command) {
    return null;
  }
  const requested = getString(toRecord(input).cwd);
  const workingDirectory = requested ? resolvePathForCwd(requested, cwd) : cwd;
  if (relativePathWithin(workingDirectory, cwd) === null) {
    return null;
  }
  return planSafeCommand(command, config, { workspace: cwd, cwd: workingDirectory });
}

/** The input a planned bash call runs with: the plan's command, and its directory when a leading `cd` moved it. */
export function plannedInput(input: unknown, plan: SafeCommandPlan): Record<string, unknown> {
  return { ...toRecord(input), command: plan.command, ...(plan.cwd ? { cwd: plan.cwd } : {}) };
}

/**
 * The route a tool call takes before any classifier or session state is
 * consulted: "blocked_command", a fast path that allows it, "manual_only", or
 * null for review. Name-based fast paths apply only to the host's own builtin
 * tools.
 */
export function selectFastPath(
  toolName: string,
  input: unknown,
  options: { cwd: string; config: AutoReviewConfig; tools: unknown[]; hasUI: boolean },
): FastPathRoute | null {
  const { cwd, config, tools, hasUI } = options;
  const toolDefinition = findToolDefinition(toolName, tools);
  const builtin = isBuiltinTool(toolDefinition, tools.length > 0);
  const normalizedToolName = toolName.trim().toLowerCase();
  const command = bashCommand(toolName, input);

  if (command && matchBlockedCommand(command, config.blockCommands)) {
    return "blocked_command";
  }
  if (builtin && isLocalStateTool(toolName)) {
    return "local_state";
  }
  if (builtin && isInteractiveUiOnlyTool(toolName, input, hasUI)) {
    return "ui_only";
  }
  if (config.reviewExemptTools.some((name) => name.trim().toLowerCase() === normalizedToolName)) {
    return "tool_allowlist";
  }
  if (builtin && isReadOnlyTool(toolName) && isWorkspaceReadFastPath(input, resolveReadRoots(cwd, config.readRoots))) {
    return "readonly";
  }
  if (builtin && (toolName === "write" || toolName === "edit") && isWorkspaceWriteFastPath(input, cwd)) {
    return "workspace_write";
  }
  if (isManualOnlyTool(toolName, toolDefinition)) {
    return "manual_only";
  }
  if (planBashCommand(toolName, input, cwd, config) !== null) {
    return "safe_command";
  }
  return null;
}

/**
 * Block without asking anyone, and end the turn once `maxConsecutiveDenials`
 * automatic denials have happened in a row, instead of trusting the agent to
 * stop on its own.
 */
function automaticDeny(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  reason: string,
): ToolCallDecision {
  const denials = store.recordDenial();
  if (denials < config.maxConsecutiveDenials) {
    return deny(reason);
  }
  store.recordNonDenial();
  if (ctx.abort) {
    // The agent never sees this reason once the turn ends; tell the user why.
    ctx.ui?.notify?.(`omp-auto-approval stopped the turn after ${denials} rejected actions in a row. Last: ${reason}`, "warning");
    ctx.abort();
    return deny(`${reason} Auto-approval rejected ${denials} actions in a row and stopped the turn. Wait for the user's next message.`);
  }
  return deny(`${reason} Auto-approval rejected ${denials} actions in a row; stop and ask the user for guidance.`);
}

export async function evaluateToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  options: {
    tools?: unknown[];
    classifierClient?: ClassifierClient;
    // Text of the assistant message that issued this call, if known.
    agentMessage?: string;
  } = {},
): Promise<ToolCallDecision> {
  const started = Date.now();
  const toolName = getToolName(event);
  if (!config.enabled) {
    return {};
  }
  if (!toolName) {
    return deny("Tool call was blocked because no tool name was provided.");
  }

  const cwd = ctx.cwd || process.cwd();
  const input = getToolInput(event);
  const subject = createReviewSubject(toolName, input, cwd);
  const route = selectFastPath(toolName, input, {
    cwd,
    config,
    tools: options.tools ?? [],
    hasUI: ctx.hasUI === true,
  });
  const audit = (entry: Omit<AuditEntry, "event" | "mode" | "toolName" | "actionSummary" | "actionHash" | "durationMs">) => writeAudit(config, {
    event: "decision",
    mode: config.mode,
    toolName,
    actionSummary: subject.actionSummary,
    actionHash: subject.actionHash,
    durationMs: Date.now() - started,
    ...entry,
  });

  if (route === "blocked_command") {
    const pattern = matchBlockedCommand(bashCommand(toolName, input) ?? "", config.blockCommands);
    const reason = `This command matches the blockCommands rule "${pattern}" and is never auto-approved. Do not retry it in another form; tell the user what you wanted to run and why.`;
    await audit({ route, outcome: "deny", reason });
    return automaticDeny(ctx, config, store, reason);
  }

  if (route === "manual_only") {
    if (config.mode === "fallback" && ctx.hasUI) {
      return handleHumanFallback(ctx, config, store, subject, {
        started,
        route: "manual_only",
        failureReason: "This tool requires explicit user interaction and cannot be auto-approved.",
      });
    }
    await audit({ route, outcome: "deny", reason: "Manual-only tool cannot be auto-approved." });
    return deny("This tool requires explicit user approval and cannot be auto-approved.");
  }

  if (route) {
    if (route === "safe_command") {
      store.recordNonDenial();
      const plan = planBashCommand(toolName, input, cwd, config);
      if (plan) {
        // OMP runs the call with the input as the tool_call handlers leave it.
        const record = toRecord(input);
        if (plan.command !== record.command || plan.cwd) {
          Object.assign(record, plannedInput(input, plan));
          await audit({ route, outcome: "allow", pinnedCommand: plan.command, ...(plan.cwd ? { pinnedCwd: plan.cwd } : {}) });
          return {};
        }
      }
    }
    await audit({ route, outcome: "allow" });
    return {};
  }

  if (store.isExactApproved(subject.actionHash)) {
    await audit({ route: "session_approval", outcome: "allow" });
    return {};
  }

  const askHuman = config.mode === "fallback" && ctx.hasUI === true;
  const cached = store.getCachedDecision(subject.actionHash);
  if (cached?.outcome === "allow") {
    store.recordNonDenial();
    await audit({ route: "classifier_cache", outcome: "allow", classifierDecision: cached });
    return {};
  }
  if (cached) {
    if (askHuman) {
      return handleHumanFallback(ctx, config, store, subject, { started, route: "classifier", classifierDecision: cached });
    }
    await audit({ route: "classifier_cache", outcome: "deny", classifierDecision: cached, reason: cached.rationale });
    return automaticDeny(ctx, config, store, classifierDenyReason(cached));
  }

  let classifierDecision: ReviewDecision;
  try {
    classifierDecision = await classifyAction(ctx, config, subject, options.classifierClient, { agentMessage: options.agentMessage });
    store.cacheDecision(subject.actionHash, classifierDecision);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (askHuman) {
      return handleHumanFallback(ctx, config, store, subject, { started, route: "classifier", failureReason: reason });
    }
    await audit({ route: "classifier", outcome: "deny", reason });
    return automaticDeny(ctx, config, store, failureDenyReason(reason));
  }

  if (classifierDecision.outcome === "allow") {
    store.recordNonDenial();
    await audit({ route: "classifier", outcome: "allow", classifierDecision });
    return {};
  }

  if (askHuman) {
    return handleHumanFallback(ctx, config, store, subject, { started, route: "classifier", classifierDecision });
  }
  await audit({ route: "classifier", outcome: "deny", classifierDecision, reason: classifierDecision.rationale });
  return automaticDeny(ctx, config, store, classifierDenyReason(classifierDecision));
}
