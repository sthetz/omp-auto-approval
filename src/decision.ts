import type { AutoReviewConfig, ExtensionContextLike, ReviewDecision, ReviewSubject, RouteName } from "./types.js";
import { classifyAction, type ClassifierClient } from "./classifier.js";
import { writeAudit } from "./logging.js";
import { planSafeCommand, type SafeCommandPlan } from "./safe-command.js";
import { defaultRules, escalateCommand, RULES_PROBLEM_ID, userRulesPath, type CommandRules, type Escalation } from "./command-rules.js";
import { configPath } from "./extension-config.js";
import { SessionApprovalStore } from "./session-approval-store.js";
import {
  createReviewSubject,
  findToolDefinition,
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
import { requestHumanApproval, type HumanDecision } from "./human-approval.js";

/** The host-independent form of a tool call. */
export interface CanonicalToolCall {
  toolName: string | null;
  input: unknown;
}

export type DecisionOutcome = "allow" | "deny" | "review" | "ask";
export type DecidingEvaluator = "static" | "session" | "classifier" | "human";
type StaticRoute = RouteName | "review";

/** The policy verdict before session approvals, a classifier, or a human. */
export interface StaticVerdict {
  evaluator: "static";
  outcome: "allow" | "review" | "ask" | "block";
  route: StaticRoute;
  escalation: Escalation | null;
  plan: SafeCommandPlan | null;
}

export type ClassifierVerdict =
  | { evaluator: "classifier"; outcome: "allow" | "deny"; decision: ReviewDecision; cached: boolean }
  | { evaluator: "classifier"; outcome: "failure"; reason: string; cached: false };

export interface HumanVerdict {
  evaluator: "human";
  decision: HumanDecision;
}

/** All session inputs to a decision. Evaluator verdicts are added by apply(). */
export interface DecisionState {
  config: AutoReviewConfig;
  cwd: string;
  tools: unknown[];
  hasUI: boolean;
  shellLatched: boolean;
  shellLatchEffect?: { session: string; reason: string };
  rules: CommandRules;
  exactApproved: boolean;
  subject?: ReviewSubject;
  staticVerdict?: StaticVerdict;
  classifier?: ClassifierVerdict;
  human?: HumanVerdict;
}

export interface Decision {
  call: CanonicalToolCall;
  state: DecisionState;
  subject: ReviewSubject | null;
  staticVerdict: StaticVerdict | null;
  classifierVerdict?: ClassifierVerdict;
  humanVerdict?: HumanVerdict;
  route: RouteName | "invalid";
  outcome: DecisionOutcome;
  evaluator: DecidingEvaluator;
  plan: SafeCommandPlan | null;
  reason?: string;
  auditReason?: string;
  failureReason?: string;
  automaticDenial?: { baseReason: string };
}

export interface DecisionOptions {
  tools?: unknown[];
  classifierClient?: ClassifierClient;
  // Text of the assistant message that issued this call, if known.
  agentMessage?: string;
  // The session's command rules (see loadCommandRules); the built-in ones if absent.
  rules?: CommandRules;
}

interface ApplyOptions {
  classifierClient?: ClassifierClient;
  agentMessage?: string;
  started?: number;
}

function classifierDenyReason(decision: ReviewDecision): string {
  return [
    "The approval classifier rejected this action.",
    decision.rationale ? `Reason: ${decision.rationale}` : null,
    "Do not retry the same action unless the user explicitly approves it.",
  ].filter(Boolean).join(" ");
}

const MANUAL_ONLY_FAILURE = "This tool requires explicit user interaction and cannot be auto-approved.";

function failureDenyReason(reason: string): string {
  return `The approval classifier could not approve this action: ${reason}`;
}

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

/** How a bash call that skips review runs (see planSafeCommand), or null. */
function planBashCommand(call: CanonicalToolCall & { toolName: string }, state: DecisionState): SafeCommandPlan | null {
  const command = bashCommand(call.toolName, call.input);
  if (!command || !hasOnlyPlainBashFields(call.input)) {
    return null;
  }
  const requested = getString(toRecord(call.input).cwd);
  const workingDirectory = requested ? resolvePathForCwd(requested, state.cwd) : state.cwd;
  if (relativePathWithin(workingDirectory, state.cwd) === null) {
    return null;
  }
  return planSafeCommand(command, state.config, { workspace: state.cwd, cwd: workingDirectory, rules: state.rules });
}

/** Run the static policy evaluator once, including at most one bash plan. */
function evaluateStatic(call: CanonicalToolCall & { toolName: string }, state: DecisionState): StaticVerdict {
  const { config, tools, hasUI, rules } = state;
  const toolDefinition = findToolDefinition(call.toolName, tools);
  const builtin = isBuiltinTool(toolDefinition, tools.length > 0);
  const normalizedToolName = call.toolName.trim().toLowerCase();
  const command = bashCommand(call.toolName, call.input);
  const escalation = command ? escalateCommand(command, rules) : null;
  const verdict = (outcome: StaticVerdict["outcome"], route: StaticRoute, plan: SafeCommandPlan | null = null): StaticVerdict => ({
    evaluator: "static",
    outcome,
    route,
    escalation,
    plan,
  });

  // The most restrictive outcome wins: block, then ask, then review, then
  // any fast path.
  if (escalation?.outcome === "block") {
    return verdict("block", "blocked_command");
  }
  if (escalation?.outcome === "ask") {
    return verdict("ask", "ask_rule");
  }
  // A bash command a review rule matches is reviewed even when bash is in
  // reviewExemptTools.
  const reviewBash = command !== undefined && escalation?.outcome === "review";
  if (builtin && isLocalStateTool(call.toolName)) {
    return verdict("allow", "local_state");
  }
  if (builtin && isInteractiveUiOnlyTool(call.toolName, call.input, hasUI)) {
    return verdict("allow", "ui_only");
  }
  if (!reviewBash && config.reviewExemptTools.some((name) => name.trim().toLowerCase() === normalizedToolName)) {
    return verdict("allow", "tool_allowlist");
  }
  if (builtin && isReadOnlyTool(call.toolName) && isWorkspaceReadFastPath(call.input, resolveReadRoots(state.cwd, config.readRoots))) {
    return verdict("allow", "readonly");
  }
  if (builtin && (call.toolName === "write" || call.toolName === "edit") && isWorkspaceWriteFastPath(call.input, state.cwd, [configPath(), userRulesPath(), ...rules.files])) {
    return verdict("allow", "workspace_write");
  }
  if (isManualOnlyTool(call.toolName, toolDefinition)) {
    return verdict("ask", "manual_only");
  }
  const plan = !reviewBash && !state.shellLatched ? planBashCommand(call, state) : null;
  return plan ? verdict("allow", "safe_command", plan) : verdict("review", "review");
}

function automaticDenial(baseReason: string): Pick<Decision, "outcome" | "reason" | "automaticDenial"> {
  return { outcome: "deny", reason: baseReason, automaticDenial: { baseReason } };
}

function baseDecision(call: CanonicalToolCall, state: DecisionState, subject: ReviewSubject | null, staticVerdict: StaticVerdict | null): Decision {
  return {
    call,
    state,
    subject,
    staticVerdict,
    humanVerdict: state.human,
    route: staticVerdict?.route === "review" ? "classifier" : staticVerdict?.route ?? "invalid",
    outcome: "review",
    evaluator: "static",
    plan: staticVerdict?.plan ?? null,
  };
}

function humanDecision(call: CanonicalToolCall, state: DecisionState, subject: ReviewSubject, staticVerdict: StaticVerdict): Decision {
  const base = {
    ...baseDecision(call, state, subject, staticVerdict),
    classifierVerdict: staticVerdict.route === "review" ? state.classifier : undefined,
  };
  const human = state.human?.decision;
  if (!human) {
    return { ...base, route: "human", outcome: "ask", evaluator: "human" };
  }
  if (human.approved) {
    return { ...base, route: "human", outcome: "allow", evaluator: "human" };
  }
  const rule = staticVerdict.escalation?.rule;
  const classifier = state.classifier;
  const reason = human.state === "stop"
    ? "The user rejected this action and stopped the turn. Wait for the user's next message."
    : human.reason
      ?? (staticVerdict.route === "ask_rule" ? `The user rejected this action, which the command rule "${rule?.id}" asks them to approve.` : undefined)
      ?? (classifier && classifier.outcome !== "failure" ? classifier.decision.rationale : undefined)
      ?? (classifier?.outcome === "failure" ? classifier.reason : undefined)
      ?? (staticVerdict.route === "manual_only" ? MANUAL_ONLY_FAILURE : undefined)
      ?? "Manual approval was rejected.";
  return { ...base, route: "human", outcome: "deny", evaluator: "human", reason };
}

/**
 * Combine a canonical call, session state, and any evaluator verdicts without
 * session effects. Static planning is deterministic for a given filesystem,
 * PATH, and session state. `review` and `ask` outcomes request the corresponding
 * evaluator from apply; `allow` and `deny` are final.
 */
export function decide(call: CanonicalToolCall, state: DecisionState): Decision {
  if (!state.config.enabled) {
    const subject = call.toolName ? createReviewSubject(call.toolName, call.input, state.cwd) : null;
    return { ...baseDecision(call, state, subject, null), route: "disabled", outcome: "allow" };
  }
  if (!call.toolName) {
    return {
      ...baseDecision(call, state, null, null),
      route: "invalid",
      outcome: "deny",
      reason: "Tool call was blocked because no tool name was provided.",
    };
  }

  const staticVerdict = state.staticVerdict ?? evaluateStatic({ ...call, toolName: call.toolName }, state);
  const subject = state.subject ?? createReviewSubject(call.toolName, call.input, state.cwd);
  const base = baseDecision(call, state, subject, staticVerdict);
  const rule = staticVerdict.escalation?.rule;

  if (staticVerdict.outcome === "block") {
    const reason = `This command matches the command rule "${rule?.id}" (block) and is never auto-approved.${rule?.why ? ` Why: ${rule.why}` : ""} Do not retry it in another form; tell the user what you wanted to run and why.`;
    return { ...base, route: "blocked_command", ...automaticDenial(reason) };
  }

  if (staticVerdict.route === "ask_rule") {
    if (state.human) {
      return humanDecision(call, state, subject, staticVerdict);
    }
    // A human gave an exact approval; a classifier's never stands in for one.
    if (state.exactApproved) {
      return { ...base, route: "session_approval", outcome: "allow", evaluator: "session" };
    }
    if (state.config.mode === "fallback" && state.hasUI) {
      return humanDecision(call, state, subject, staticVerdict);
    }
    const unasked = state.config.mode === "auto" ? " in auto mode" : " without an interactive UI";
    const reason = rule?.id === RULES_PROBLEM_ID
      ? `The command rules could not be loaded, so every bash command needs the user's approval, and the user cannot be asked${unasked}. Problem: ${rule.why}. Do not retry; tell the user to fix the rules file.`
      : `This command matches the command rule "${rule?.id}", which asks the user to approve it, and the user cannot be asked${unasked}.${rule?.why ? ` Why: ${rule.why}` : ""} Do not retry it in another form; tell the user what you wanted to run and why.`;
    return { ...base, route: "ask_rule", ...automaticDenial(reason) };
  }

  if (staticVerdict.route === "manual_only") {
    if (state.config.mode === "fallback" && state.hasUI) {
      return { ...humanDecision(call, state, subject, staticVerdict), failureReason: MANUAL_ONLY_FAILURE };
    }
    return {
      ...base,
      route: "manual_only",
      outcome: "deny",
      reason: "This tool requires explicit user approval and cannot be auto-approved.",
      auditReason: "Manual-only tool cannot be auto-approved.",
    };
  }

  if (staticVerdict.outcome === "allow") {
    return { ...base, outcome: "allow", evaluator: "static" };
  }

  if (state.human) {
    return humanDecision(call, state, subject, staticVerdict);
  }

  if (state.exactApproved) {
    return { ...base, route: "session_approval", outcome: "allow", evaluator: "session" };
  }

  const classifier = state.classifier;
  if (!classifier) {
    return { ...base, route: "classifier", outcome: "review", evaluator: "classifier" };
  }
  const route = classifier.cached ? "classifier_cache" : "classifier";
  const withClassifier = { ...base, classifierVerdict: classifier, evaluator: "classifier" as const };
  if (classifier.outcome === "allow") {
    return { ...withClassifier, route, outcome: "allow", evaluator: "classifier" };
  }
  if (state.config.mode === "fallback" && state.hasUI) {
    return humanDecision(call, state, subject, staticVerdict);
  }
  if (classifier.outcome === "failure") {
    return {
      ...withClassifier,
      route,
      ...automaticDenial(failureDenyReason(classifier.reason)),
      auditReason: classifier.reason,
    };
  }
  return {
    ...withClassifier,
    route,
    ...automaticDenial(classifierDenyReason(classifier.decision)),
    auditReason: classifier.decision.rationale,
  };
}

/** Snapshot the session-owned inputs to decide(). */
export function snapshotDecisionState(
  call: CanonicalToolCall,
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  options: DecisionOptions = {},
): DecisionState {
  const subject = call.toolName ? createReviewSubject(call.toolName, call.input, ctx.cwd || process.cwd()) : null;
  const cached = subject ? store.getCachedDecision(subject.actionHash) : undefined;
  return {
    config,
    cwd: ctx.cwd || process.cwd(),
    tools: options.tools ?? [],
    hasUI: ctx.hasUI === true,
    shellLatched: store.shellLatch(sessionKey(ctx)) !== null,
    rules: options.rules ?? defaultRules(),
    exactApproved: subject ? store.isExactApproved(subject.actionHash) : false,
    ...(subject ? { subject } : {}),
    ...(cached ? { classifier: { evaluator: "classifier", outcome: cached.outcome, decision: cached, cached: true } } : {}),
  };
}

async function auditDecision(decision: Decision, started: number, pinnedInputChanged: boolean): Promise<void> {
  const { subject, state } = decision;
  if (!subject || decision.route === "disabled" || decision.route === "invalid" || (decision.outcome !== "allow" && decision.outcome !== "deny")) {
    return;
  }
  const classifier = decision.classifierVerdict;
  const human = decision.humanVerdict?.decision;
  const rule = decision.staticVerdict?.escalation?.rule ?? undefined;
  const pinned = decision.outcome === "allow" && decision.staticVerdict?.route === "safe_command" ? decision.plan : null;
  await writeAudit(state.config, {
    event: "decision",
    route: decision.route,
    mode: state.config.mode,
    toolName: subject.toolName,
    actionSummary: subject.actionSummary,
    actionHash: subject.actionHash,
    outcome: decision.outcome,
    ...(classifier && classifier.outcome !== "failure" ? { classifierDecision: classifier.decision } : {}),
    ...(human ? { humanDecision: human.approved ? human.persistence : human.state } : {}),
    ...(decision.auditReason ?? decision.reason ? { reason: decision.auditReason ?? decision.reason } : {}),
    ...(pinned && pinnedInputChanged ? {
      pinnedCommand: pinned.command,
      ...(pinned.cwd ? { pinnedCwd: pinned.cwd } : {}),
    } : {}),
    ...(pinned ? { ruleIds: pinned.rules.map((used) => used.id) } : {}),
    ...(rule ? { ruleId: rule.id, ruleSource: rule.source } : {}),
    durationMs: Date.now() - started,
  });
}

/** Apply a final decision's audit, counter, and pinned-input effects. */
async function applyFinal(decision: Decision, ctx: ExtensionContextLike, store: SessionApprovalStore, started: number): Promise<Decision> {
  const { state } = decision;
  const pinnedInputChanged = decision.outcome === "allow" && decision.plan !== null
    && (decision.plan.command !== toRecord(decision.call.input).command || Boolean(decision.plan.cwd));
  if (decision.outcome === "allow" && decision.staticVerdict?.route === "safe_command" && decision.plan) {
    store.recordNonDenial();
    const record = toRecord(decision.call.input);
    if (decision.plan.command !== record.command || decision.plan.cwd) {
      Object.assign(record, { command: decision.plan.command, ...(decision.plan.cwd ? { cwd: decision.plan.cwd } : {}) });
    }
  } else if (decision.outcome === "allow" && decision.classifierVerdict?.outcome === "allow") {
    store.recordNonDenial();
  }

  const automatic = decision.automaticDenial;
  if (automatic) {
    const denials = store.recordDenial();
    const stopped = denials >= state.config.maxConsecutiveDenials;
    decision = {
      ...decision,
      auditReason: decision.auditReason ?? automatic.baseReason,
      reason: !stopped
        ? automatic.baseReason
        : ctx.abort
          ? `${automatic.baseReason} omp-clearance rejected ${denials} actions in a row and stopped the turn. Wait for the user's next message.`
          : `${automatic.baseReason} omp-clearance rejected ${denials} actions in a row; stop and ask the user for guidance.`,
    };
    if (stopped) {
      store.recordNonDenial();
      if (ctx.abort) {
        // The agent never sees this reason once the turn ends; tell the user why.
        ctx.ui?.notify?.(`omp-clearance stopped the turn after ${denials} rejected actions in a row. Last: ${automatic.baseReason}`, "warning");
        ctx.abort();
      }
    }
  } else if (decision.route === "human" && decision.outcome === "deny" && decision.humanVerdict?.decision.approved === false) {
    if (decision.humanVerdict.decision.state === "stop") {
      // The user ended the turn; the next one starts with a clean count.
      store.recordNonDenial();
      ctx.abort?.();
    } else {
      store.recordDenial();
    }
  }

  await auditDecision(decision, started, pinnedInputChanged);
  const latch = state.shellLatchEffect;
  // A fast-pathed command runs only pinned programs, which cannot change the shell.
  if (latch && (decision.outcome === "deny" || decision.staticVerdict?.route === "safe_command")) {
    store.unlatchShell(latch.session);
  } else if (latch && decision.subject) {
    await writeAudit(state.config, {
      event: "shell_latch",
      mode: state.config.mode,
      toolName: decision.subject.toolName,
      actionSummary: decision.subject.actionSummary,
      actionHash: decision.subject.actionHash,
      reason: latch.reason,
    });
    if (state.config.enabled) {
      ctx.ui?.notify?.(`omp-clearance: an approved bash command used ${latch.reason}, which can make the shell run code before later commands. Bash commands are reviewed for the rest of this session.`, "warning");
    }
  }
  return decision;
}

/**
 * Perform evaluator requests and effects for a decision. A review or ask is
 * fed back through decide() with the new verdict; nothing else re-plans policy.
 */
export async function apply(
  decision: Decision,
  ctx: ExtensionContextLike,
  store: SessionApprovalStore,
  options: ApplyOptions = {},
): Promise<Decision> {
  const started = options.started ?? Date.now();
  if (decision.outcome === "review") {
    if (!decision.subject) {
      throw new Error("A classifier review needs a review subject.");
    }
    let classifier: ClassifierVerdict;
    try {
      const verdict = await classifyAction(ctx, decision.state.config, decision.subject, options.classifierClient, {
        agentMessage: options.agentMessage,
        rule: decision.staticVerdict?.escalation?.rule ?? undefined,
        ruleTextOnly: decision.staticVerdict?.escalation?.textOnly,
      });
      store.cacheDecision(decision.subject.actionHash, verdict);
      classifier = { evaluator: "classifier", outcome: verdict.outcome, decision: verdict, cached: false };
    } catch (error) {
      classifier = {
        evaluator: "classifier",
        outcome: "failure",
        reason: error instanceof Error ? error.message : String(error),
        cached: false,
      };
    }
    return apply(decide(decision.call, { ...decision.state, staticVerdict: decision.staticVerdict ?? undefined, classifier, human: undefined }), ctx, store, { ...options, started });
  }

  if (decision.outcome === "ask") {
    if (!decision.subject) {
      throw new Error("A human review needs a review subject.");
    }
    const classifier = decision.classifierVerdict;
    const human = await requestHumanApproval(ctx, decision.subject, {
      classifierDecision: classifier && classifier.outcome !== "failure" ? classifier.decision : undefined,
      failureReason: classifier?.outcome === "failure" ? classifier.reason : decision.failureReason,
      rule: decision.staticVerdict?.escalation?.rule ?? undefined,
      timeoutSeconds: decision.state.config.approvalTimeoutSeconds,
    });
    if (human.approved) {
      if (human.persistence === "exact") {
        store.approveExact(decision.subject.actionHash);
      } else {
        store.recordNonDenial();
      }
    }
    return apply(decide(decision.call, {
      ...decision.state,
      staticVerdict: decision.staticVerdict ?? undefined,
      exactApproved: decision.state.exactApproved || (human.approved && human.persistence === "exact"),
      human: { evaluator: "human", decision: human },
    }), ctx, store, { ...options, started });
  }

  return applyFinal(decision, ctx, store, started);
}

/** The session a tool call belongs to, which owns one persistent shell. */
export function sessionKey(ctx: ExtensionContextLike): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

/**
 * Decide and apply a canonical tool call. A bash command that runs (by any
 * route, or with the extension off) and may leave a hook in the persistent
 * shell turns the bash fast path off for the rest of the session.
 */
export async function runDecision(
  call: CanonicalToolCall,
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  options: DecisionOptions = {},
): Promise<Decision> {
  const command = call.toolName ? bashCommand(call.toolName, call.input) : undefined;
  const requested = getString(toRecord(call.input).cwd);
  const cwd = ctx.cwd || process.cwd();
  const directory = requested ? resolvePathForCwd(requested, cwd) : cwd;
  const session = sessionKey(ctx);
  const latchedBefore = store.shellLatch(session) !== null;
  // Latch before deciding, so that a call decided while this one waits for
  // review is not fast-pathed; undo it if this one does not run.
  const reason = command && !latchedBefore ? shellHook(command, directory) : null;
  const latched = reason !== null && store.latchShell(session, reason);
  const state = {
    ...snapshotDecisionState(call, ctx, config, store, options),
    shellLatched: latchedBefore,
    ...(latched && reason ? { shellLatchEffect: { session, reason } } : {}),
  };
  return apply(decide(call, state), ctx, store, { ...options, started: Date.now() });
}
