import type { AuditEntry, AutoReviewConfig, ExtensionContextLike, ReviewDecision, ToolCallEventLike } from "./types.js";
import { classifyAction, type ClassifierClient } from "./classifier.js";
import { writeAudit } from "./logging.js";
import { planSafeCommand, type SafeCommandPlan } from "./safe-command.js";
import { defaultRules, escalateCommand, userRulesPath, type CommandRule, type CommandRules, type Escalation } from "./command-rules.js";
import { configPath } from "./extension-config.js";
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
import { shellHook } from "./shell-hooks.js";
import { requestHumanApproval } from "./human-approval.js";

export type ToolCallDecision = {} | { block: true; reason: string };

/** The audit fields naming the command rule that decided, if any. */
function ruleFields(rule: CommandRule | undefined): Pick<AuditEntry, "ruleId" | "ruleSource"> {
  return rule ? { ruleId: rule.id, ruleSource: rule.source } : {};
}

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
  auditBase: { started: number; route: "classifier" | "manual_only" | "ask_rule"; classifierDecision?: ReviewDecision; failureReason?: string; rule?: CommandRule },
): Promise<ToolCallDecision> {
  const human = await requestHumanApproval(ctx, subject, {
    classifierDecision: auditBase.classifierDecision,
    failureReason: auditBase.failureReason,
    rule: auditBase.rule,
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
      ...ruleFields(auditBase.rule),
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
      ?? (auditBase.route === "ask_rule" ? `The user rejected this action, which the command rule "${auditBase.rule?.id}" asks them to approve.` : undefined)
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
    ...ruleFields(auditBase.rule),
    durationMs: Date.now() - auditBase.started,
  });
  return deny(reason);
}

export type FastPathRoute =
  | "blocked_command"
  | "ask_rule"
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

// Bash tool fields a fast-pathed call may carry. Others change how or where
// it runs: `pty` gives it a terminal on stdin, `async`, `name` and the
// service fields (`ready`, `log`, `port`, `host`) run it in the background or
// as a service, and some hosts honour an `env` that can set PATH or
// LD_PRELOAD. A field this list does not know is reviewed too.
const PLAIN_BASH_FIELDS = new Set(["command", "cwd", "timeout", "description"]);
const OFF_BY_DEFAULT_BASH_FIELDS = new Set(["pty", "async"]);

function hasOnlyPlainBashFields(input: unknown): boolean {
  return Object.entries(toRecord(input)).every(([key, value]) => (
    PLAIN_BASH_FIELDS.has(key) || value === undefined || value === null || (OFF_BY_DEFAULT_BASH_FIELDS.has(key) && value === false)
  ));
}

/**
 * How a bash call that skips review runs (see planSafeCommand), or null. OMP's
 * bash tool accepts a `cwd`; relative paths are resolved from it, and a
 * directory outside the workspace gets no fast path.
 */
export function planBashCommand(toolName: string, input: unknown, cwd: string, config: AutoReviewConfig, rules?: CommandRules): SafeCommandPlan | null {
  const command = bashCommand(toolName, input);
  if (!command || !hasOnlyPlainBashFields(input)) {
    return null;
  }
  const requested = getString(toRecord(input).cwd);
  const workingDirectory = requested ? resolvePathForCwd(requested, cwd) : cwd;
  if (relativePathWithin(workingDirectory, cwd) === null) {
    return null;
  }
  return planSafeCommand(command, config, { workspace: cwd, cwd: workingDirectory, rules });
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
/**
 * What the command rules and blockCommands call for, for a bash call; null
 * for other tools and for commands no rule matches.
 */
export function bashEscalation(toolName: string, input: unknown, config: AutoReviewConfig, rules: CommandRules = defaultRules()): Escalation | null {
  const command = bashCommand(toolName, input);
  return command ? escalateCommand(command, rules, config.blockCommands) : null;
}

export function selectFastPath(
  toolName: string,
  input: unknown,
  options: {
    cwd: string;
    config: AutoReviewConfig;
    tools: unknown[];
    hasUI: boolean;
    shellLatched?: boolean;
    rules?: CommandRules;
    // As bashEscalation gives it; computed when absent.
    escalation?: Escalation | null;
  },
): FastPathRoute | null {
  const { cwd, config, tools, hasUI } = options;
  const rules = options.rules ?? defaultRules();
  const toolDefinition = findToolDefinition(toolName, tools);
  const builtin = isBuiltinTool(toolDefinition, tools.length > 0);
  const normalizedToolName = toolName.trim().toLowerCase();
  const command = bashCommand(toolName, input);
  const escalation = options.escalation === undefined ? bashEscalation(toolName, input, config, rules) : options.escalation;

  // The most restrictive outcome wins: block, then ask, then review, then
  // any fast path.
  if (escalation?.outcome === "block") {
    return "blocked_command";
  }
  if (escalation?.outcome === "ask") {
    return "ask_rule";
  }
  // A bash command a review rule matches, or any bash command while the
  // rules cannot be read (they might have held a block), is reviewed even
  // when bash is in reviewExemptTools.
  const reviewBash = command !== undefined && (escalation?.outcome === "review" || rules.problem !== null);
  if (builtin && isLocalStateTool(toolName)) {
    return "local_state";
  }
  if (builtin && isInteractiveUiOnlyTool(toolName, input, hasUI)) {
    return "ui_only";
  }
  if (!reviewBash && config.reviewExemptTools.some((name) => name.trim().toLowerCase() === normalizedToolName)) {
    return "tool_allowlist";
  }
  if (builtin && isReadOnlyTool(toolName) && isWorkspaceReadFastPath(input, resolveReadRoots(cwd, config.readRoots))) {
    return "readonly";
  }
  if (builtin && (toolName === "write" || toolName === "edit") && isWorkspaceWriteFastPath(input, cwd, [configPath(), userRulesPath(), ...rules.files])) {
    return "workspace_write";
  }
  if (isManualOnlyTool(toolName, toolDefinition)) {
    return "manual_only";
  }
  if (!reviewBash && !options.shellLatched && planBashCommand(toolName, input, cwd, config, rules) !== null) {
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

/** The session a tool call belongs to, which owns one persistent shell. */
export function sessionKey(ctx: ExtensionContextLike): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

type EvaluateOptions = {
  tools?: unknown[];
  classifierClient?: ClassifierClient;
  // Text of the assistant message that issued this call, if known.
  agentMessage?: string;
  // The session's command rules (see loadCommandRules); the built-in ones if absent.
  rules?: CommandRules;
};

/**
 * Decide a tool call. A bash command that runs (by any route, or with the
 * extension off) and may leave a hook in the persistent shell turns the bash
 * fast path off for the rest of the session: see shellHook.
 */
export async function evaluateToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  options: EvaluateOptions = {},
): Promise<ToolCallDecision> {
  const toolName = getToolName(event);
  const input = getToolInput(event);
  const command = toolName ? bashCommand(toolName, input) : undefined;
  const requested = getString(toRecord(input).cwd);
  const cwd = ctx.cwd || process.cwd();
  const directory = requested ? resolvePathForCwd(requested, cwd) : cwd;
  const session = sessionKey(ctx);
  const latchedBefore = store.shellLatch(session) !== null;
  // Latch before deciding, so that a call decided while this one waits for
  // review is not fast-pathed; undo it if this one does not run.
  const reason = command && !latchedBefore ? shellHook(command, directory) : null;
  const latched = reason !== null && store.latchShell(session, reason);
  const outcome = { fastPathed: false };
  const decision = await decideToolCall(event, ctx, config, store, options, outcome, latchedBefore);
  // A fast-pathed command runs only pinned programs, which cannot change the shell.
  if (latched && ("block" in decision || outcome.fastPathed)) {
    store.unlatchShell(session);
  } else if (latched && reason) {
    const subject = createReviewSubject(toolName!, input, cwd);
    await writeAudit(config, {
      event: "shell_latch",
      mode: config.mode,
      toolName: toolName!,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      reason,
    });
    if (config.enabled) {
      ctx.ui?.notify?.(`omp-auto-approval: an approved bash command used ${reason}, which can make the shell run code before later commands. Bash commands are reviewed for the rest of this session.`, "warning");
    }
  }
  return decision;
}

async function decideToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  options: EvaluateOptions,
  outcome: { fastPathed: boolean },
  shellLatched: boolean,
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
  // Decided once, so that the route and the reasons below agree.
  const escalation = bashEscalation(toolName, input, config, options.rules);
  const rule = escalation?.rule ?? undefined;
  let route = selectFastPath(toolName, input, {
    cwd,
    config,
    tools: options.tools ?? [],
    hasUI: ctx.hasUI === true,
    shellLatched,
    rules: options.rules,
    escalation,
  });
  // The command a safe_command call runs as. Planned again with the same
  // inputs, so it agrees with the route; if not, the call is reviewed rather
  // than run as written.
  const plan = route === "safe_command" ? planBashCommand(toolName, input, cwd, config, options.rules) : null;
  if (route === "safe_command" && !plan) {
    route = null;
  }
  const audit = (entry: Omit<AuditEntry, "event" | "mode" | "toolName" | "actionSummary" | "actionHash" | "durationMs">) => writeAudit(config, {
    event: "decision",
    mode: config.mode,
    toolName,
    actionSummary: subject.actionSummary,
    actionHash: subject.actionHash,
    durationMs: Date.now() - started,
    ...ruleFields(rule),
    ...entry,
  });

  if (route === "blocked_command") {
    const reason = rule
      ? `This command matches the command rule "${rule.id}" (block) and is never auto-approved.${rule.why ? ` Why: ${rule.why}` : ""} Do not retry it in another form; tell the user what you wanted to run and why.`
      : `This command matches the blockCommands rule "${escalation?.blockPattern}" and is never auto-approved. Do not retry it in another form; tell the user what you wanted to run and why.`;
    await audit({ route, outcome: "deny", reason });
    return automaticDeny(ctx, config, store, reason);
  }

  if (route === "ask_rule") {
    // A human gave an exact approval; a classifier's never stands in for one.
    if (store.isExactApproved(subject.actionHash)) {
      await audit({ route: "session_approval", outcome: "allow" });
      return {};
    }
    if (config.mode === "fallback" && ctx.hasUI) {
      return handleHumanFallback(ctx, config, store, subject, { started, route: "ask_rule", rule });
    }
    const reason = `This command matches the command rule "${rule?.id}", which asks the user to approve it, and the user cannot be asked${config.mode === "auto" ? " in auto mode" : " without an interactive UI"}.${rule?.why ? ` Why: ${rule.why}` : ""} Do not retry it in another form; tell the user what you wanted to run and why.`;
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
      outcome.fastPathed = true;
      store.recordNonDenial();
      // OMP runs the call with the input as the tool_call handlers leave it.
      const record = toRecord(input);
      if (plan && (plan.command !== record.command || plan.cwd)) {
        Object.assign(record, plannedInput(input, plan));
        await audit({ route, outcome: "allow", pinnedCommand: plan.command, ...(plan.cwd ? { pinnedCwd: plan.cwd } : {}), ruleIds: plan.rules.map((used) => used.id) });
        return {};
      }
    }
    await audit({ route, outcome: "allow", ...(plan ? { ruleIds: plan.rules.map((used) => used.id) } : {}) });
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
      return handleHumanFallback(ctx, config, store, subject, { started, route: "classifier", classifierDecision: cached, rule });
    }
    await audit({ route: "classifier_cache", outcome: "deny", classifierDecision: cached, reason: cached.rationale });
    return automaticDeny(ctx, config, store, classifierDenyReason(cached));
  }

  let classifierDecision: ReviewDecision;
  try {
    classifierDecision = await classifyAction(ctx, config, subject, options.classifierClient, { agentMessage: options.agentMessage, rule });
    store.cacheDecision(subject.actionHash, classifierDecision);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (askHuman) {
      return handleHumanFallback(ctx, config, store, subject, { started, route: "classifier", failureReason: reason, rule });
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
    return handleHumanFallback(ctx, config, store, subject, { started, route: "classifier", classifierDecision, rule });
  }
  await audit({ route: "classifier", outcome: "deny", classifierDecision, reason: classifierDecision.rationale });
  return automaticDeny(ctx, config, store, classifierDenyReason(classifierDecision));
}
