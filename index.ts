import type { ClearanceConfig, ExtensionContextLike, Reviewer } from "./src/types.js";
import { configPath, DEFAULT_CONFIG, loadConfig, logPath, saveConfig } from "./src/extension-config.js";
import { defaultRulesPath, userRulesPath, type CommandRules } from "./src/command-rules.js";
import { decide, sessionKey, snapshotDecisionState, type Decision } from "./src/decision.js";
import { canonicalContext, canonicalTools, evaluateToolCall } from "./src/omp-host.js";
import { describeRule, rulesOverview } from "./src/rules-report.js";
import { toRecord } from "./src/common.js";
import { findToolDefinition } from "./src/tool-routing.js";
import { assistantText } from "./src/context-projection.js";
import { SessionApprovalStore } from "./src/session-approval-store.js";
import { selectClassifierModel } from "./src/model-selector.js";
import { loadReviewerState, reviewerStatePath, saveReviewerState, type ReviewerState } from "./src/reviewer-state.js";
import { watchCommandRules, type CommandRulesWatch } from "./src/rules-watch.js";

type ExtensionAPI = {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  getAllTools?: () => unknown;
  registerCommand?: (
    name: string,
    definition: {
      description: string;
      getArgumentCompletions?: (
        argumentPrefix: unknown,
      ) =>
        | Array<{ value: string; label?: string; description?: string }>
        | null
        | Promise<Array<{ value: string; label?: string; description?: string }> | null>;
      handler: (args: unknown, ctx: unknown) => Promise<void> | void;
    },
  ) => void;
};

const STATUS_KEY = "omp-clearance";

// Appended to the system prompt in every reviewer mode, so a blocked call
// is reported instead of retried in another form.
export const SYSTEM_PROMPT_NOTE = [
  "Tool calls in this session are reviewed by omp-clearance before they run.",
  "If a call is blocked, do not retry it in another form or route around the block",
  "(another tool, an encoded or rewritten command, a script that does the same thing).",
  "Tell the user what was blocked and why, and wait for their guidance.",
].join(" ");

const ROUTE_EXPLANATIONS: Record<Decision["route"], string> = {
  reviewer_off: "allowed: the reviewer is off (block and ask rules still apply)",
  invalid: "blocked: no tool name was provided",
  blocked_command: "blocked: matches a block command rule and never runs",
  ask_rule: "asks you directly, without the classifier: matches an ask command rule (denied without a UI)",
  local_state: "allowed without review: local session state (todo, wait)",
  ui_only: "allowed without review: interactive ask with no remote content",
  tool_allowlist: "allowed without review: tool is listed in reviewExemptTools",
  readonly:
    "allowed without review: read-only builtin tool, every target is a non-sensitive path in the workspace or readRoots",
  workspace_write: "allowed without review: write inside the workspace, outside protected entries",
  safe_command: "allowed without review: every command is read-only by the command rules",
  manual_unavailable: "blocked: manual review needs an interactive UI, but none is available",
  manual_only: "needs manual approval: this tool cannot be auto-approved",
  session_approval: "allowed without review: exact session approval",
  classifier_cache: "decided by the cached classifier verdict",
  classifier: "classifier review",
  human: "asks you for approval",
};

function decisionExplanation(decision: Decision): string {
  if (decision.outcome === "review") {
    return "classifier review; a denial goes to the agent, while a failure or the denial threshold asks you when possible";
  }
  if (decision.route === "manual_unavailable") {
    return "blocked: manual review needs an interactive UI, but none is available";
  }
  if (decision.route === "manual_only" && decision.outcome === "deny") {
    return "blocked: this tool requires explicit user approval, but no interactive UI is available";
  }
  return ROUTE_EXPLANATIONS[decision.route];
}

function parseExplainInput(toolName: string, rest: string): { input: unknown } | { error: string } {
  if (toolName === "bash") {
    return { input: { command: rest } };
  }
  if (rest.startsWith("{")) {
    try {
      return { input: JSON.parse(rest) };
    } catch (error) {
      return { error: `Arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { input: rest ? { path: rest } : {} };
}

function statusText(state: ReviewerState, rules: CommandRules): string {
  const text = `clearance:${state.reviewer}${state.problem ? " (invalid reviewer state)" : ""}${rules.problem ? " (rules error)" : ""}`;
  return rules.problem ? `\u001B[31m${text}\u001B[0m` : text;
}

function rulesProblemText(rules: CommandRules): string {
  return `omp-clearance: the command rules could not be loaded, so every bash call is blocked until the file is fixed: ${rules.problem}. Fixing the file is enough; rules reload automatically.`;
}

function rulesStatusText(rules: CommandRules): string[] {
  if (rules.problem) {
    return [rulesProblemText(rules)];
  }
  const [main, ...included] = rules.files;
  return [
    `command rules: ${defaultRulesPath()}`,
    main
      ? `user rules: ${main}${included.length ? ` (including ${included.join(", ")})` : ""}`
      : `user rules: none (${userRulesPath()} does not exist)`,
  ];
}

function notify(ctx: ExtensionContextLike, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui?.notify?.(message, type);
}

function setStatus(ctx: ExtensionContextLike, state: ReviewerState, rules: CommandRules): void {
  ctx.ui?.setStatus?.(STATUS_KEY, statusText(state, rules));
}

function parseCommand(args: string): string {
  return args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
}

function parseCommandRest(args: string): string {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace).trim();
}

function classifierModelText(config: ClearanceConfig): string {
  return config.classifierModel ?? "current";
}

const COMMAND_ARGUMENTS = [
  { value: "status", label: "status", description: "Show current reviewer and approval model" },
  { value: "ai", label: "ai", description: "Classifier handles review; denials return to the agent" },
  { value: "manual", label: "manual", description: "Ask you to handle review" },
  { value: "off", label: "off", description: "Review runs; block and ask policy still applies" },
  { value: "model", label: "model", description: "Select approval classifier model" },
  { value: "model current", label: "model current", description: "Use the active OMP session model for approval" },
  { value: "rules", label: "rules", description: "Show the command rules in use: rules [program | rule id]" },
  {
    value: "explain",
    label: "explain",
    description: "Show how a tool call would be routed: explain <tool> <path | JSON | command>",
  },
];

function getClearanceArgumentCompletions(
  argumentPrefix: string,
): Array<{ value: string; label: string; description: string }> | null {
  const normalized = argumentPrefix.trimStart().toLowerCase();
  const filtered = COMMAND_ARGUMENTS.filter(
    (item) => item.value.startsWith(normalized) || item.label.includes(normalized),
  );
  return filtered.length ? filtered : null;
}

export default function ompClearanceExtension(omp: ExtensionAPI): void {
  let loadResult = loadConfig();
  let config = loadResult.config;
  let reviewerState = loadReviewerState(config, loadResult.reviewerConfigured);
  // The command rules for this session: watched on every tool call and
  // reloaded on session start and /clearance commands.
  let rulesWatch: CommandRulesWatch = watchCommandRules();
  let rules = rulesWatch.rules;
  const approvals = new SessionApprovalStore();
  let lastContext: ExtensionContextLike | null = null;
  // Latest assistant text in the current agent run, for the classifier.
  let agentMessage: string | undefined;

  function refresh(ctx?: ExtensionContextLike, options: { announce?: boolean; quiet?: boolean } = {}): boolean {
    if (ctx) {
      lastContext = ctx;
    }
    loadResult = loadConfig();
    config = loadResult.config;
    const previousReviewerProblem = reviewerState.problem;
    const previousRulesProblem = rules.problem;
    reviewerState = loadReviewerState(config, loadResult.reviewerConfigured);
    rulesWatch = watchCommandRules();
    rules = rulesWatch.rules;
    let rulesNotified = false;
    if (ctx) {
      setStatus(ctx, reviewerState, rules);
      if (loadResult.warning && !options.quiet) {
        notify(ctx, loadResult.warning, "warning");
      }
      if (options.announce && loadResult.notice) {
        notify(ctx, loadResult.notice, "warning");
      }
      if (reviewerState.problem && (options.announce || reviewerState.problem !== previousReviewerProblem)) {
        notify(ctx, reviewerState.problem, "error");
      }
      if (rules.problem && (options.announce || rules.problem !== previousRulesProblem)) {
        notify(ctx, rulesProblemText(rules), "error");
        rulesNotified = true;
      }
      if (!rules.problem && previousRulesProblem) {
        notify(ctx, "omp-clearance: command rules reloaded; bash calls are no longer blocked.", "info");
      }
    }
    return rulesNotified;
  }

  function explain(rest: string, ctx: ExtensionContextLike): void {
    const firstWord = rest.split(/\s+/, 1)[0] ?? "";
    if (!firstWord) {
      notify(
        ctx,
        "Usage: /clearance explain <tool> [path | JSON arguments | bash command], or a bash command",
        "warning",
      );
      return;
    }
    const tools = canonicalTools(omp.getAllTools?.());
    // `explain ls -la` means the shell command: no session tool has that name.
    const asCommand = firstWord !== "bash" && tools.length > 0 && findToolDefinition(firstWord, tools) === undefined;
    const toolName = asCommand ? "bash" : firstWord;
    const parsed = parseExplainInput(toolName, asCommand ? rest : rest.slice(firstWord.length).trim());
    if ("error" in parsed) {
      notify(ctx, parsed.error, "warning");
      return;
    }
    const source = toRecord(toRecord(findToolDefinition(toolName, tools)).sourceInfo).source;
    const call = { toolName, input: parsed.input };
    const decision = decide(
      call,
      snapshotDecisionState(call, ctx, config, approvals, { reviewer: reviewerState.reviewer, tools, rules }),
    );
    const plan = decision.plan;
    const escalation = decision.staticVerdict?.escalation;
    notify(
      ctx,
      [
        ...(asCommand ? [`note: no tool named "${firstWord}" in this session; explained as a bash command`] : []),
        `reviewer: ${reviewerState.reviewer} (from ${reviewerState.source})`,
        `tool: ${toolName}${typeof source === "string" ? ` (${source})` : ""}`,
        `arguments: ${JSON.stringify(parsed.input)}`,
        `route: ${decisionExplanation(decision)}`,
        ...(plan && plan.command !== toRecord(parsed.input).command ? [`runs as: ${plan.command}`] : []),
        ...(plan?.cwd ? [`runs in: ${plan.cwd}`] : []),
        ...(plan ? [`allowed by: ${plan.rules.map((used) => `${used.id} (${used.source})`).join(", ")}`] : []),
        ...(plan?.rules.some((used) => used.source !== "default" && used.source !== "config.jsonc")
          ? ["note: entries from your rules files are not checked by the program oracle, as the built-in ones are"]
          : []),
        ...(escalation
          ? [
              `rule: ${escalation.rule.id} (${escalation.rule.outcome}, ${escalation.rule.source})${escalation.textOnly ? `; matched only quoted text, so reviewed instead` : ""}`,
              ...(escalation.rule.why ? [`why: ${escalation.rule.why}`] : []),
            ]
          : []),
        ...(toolName === "bash" && rules.problem ? [rulesProblemText(rules)] : []),
        ...(toolName === "bash" && approvals.shellLatch(sessionKey(ctx))
          ? [
              `note: the bash fast path is off for this session: an approved command used ${approvals.shellLatch(sessionKey(ctx))}`,
            ]
          : []),
      ].join("\n"),
    );
  }

  function persist(next: ClearanceConfig, ctx: ExtensionContextLike): void {
    const saved = saveConfig(next);
    if (!saved.success) {
      notify(ctx, `Failed to save omp-clearance config: ${saved.error ?? "unknown error"}`, "error");
      return;
    }
    config = next;
    setStatus(ctx, reviewerState, rules);
  }

  function persistReviewer(reviewer: Reviewer, ctx: ExtensionContextLike): void {
    const saved = saveReviewerState(reviewer);
    if (!saved.success) {
      notify(ctx, `Failed to save omp-clearance reviewer state: ${saved.error ?? "unknown error"}`, "error");
      return;
    }
    reviewerState = loadReviewerState(config, loadResult.reviewerConfigured);
    setStatus(ctx, reviewerState, rules);
    notify(ctx, `omp-clearance reviewer: ${reviewer}.`);
  }

  async function runCommand(command: string, rest: string, ctx: ExtensionContextLike): Promise<void> {
    lastContext = ctx;
    const rulesNotified = refresh(ctx);
    switch (command) {
      case "ai":
        persistReviewer("ai", ctx);
        break;
      case "manual":
        persistReviewer("manual", ctx);
        break;
      case "off":
        persistReviewer("off", ctx);
        break;
      case "model": {
        if (!rest) {
          const selected = await selectClassifierModel(ctx, config);
          if (selected === undefined) {
            break;
          }
          persist({ ...config, classifierModel: selected }, ctx);
          notify(ctx, `approval classifier model: ${selected ?? "current"}`);
          break;
        }
        if (rest === "current") {
          persist({ ...config, classifierModel: null }, ctx);
          notify(ctx, "approval classifier model: current");
          break;
        }
        notify(ctx, "Use /clearance model to select an approval classifier model.", "warning");
        break;
      }
      case "explain":
        explain(rest, ctx);
        break;
      case "rules":
        if (rules.problem) {
          if (!rulesNotified) {
            notify(ctx, rulesProblemText(rules), "warning");
          }
        } else if (rest) {
          notify(
            ctx,
            describeRule(rules, rest) ?? `No program or rule named "${rest}". /clearance rules lists them.`,
            "info",
          );
        } else {
          notify(ctx, rulesOverview(rules));
        }
        break;
      case "status":
        notify(
          ctx,
          [
            `reviewer: ${reviewerState.reviewer} (from ${reviewerState.source})`,
            `reviewer state: ${reviewerStatePath()}`,
            ...(reviewerState.problem ? [reviewerState.problem] : []),
            `approval classifier model: ${classifierModelText(config)}`,
            `config: ${configPath()}`,
            `audit log: ${logPath()}`,
            ...rulesStatusText(rules),
            ...(approvals.shellLatch(sessionKey(ctx))
              ? [
                  `bash fast path: off for this session (an approved command used ${approvals.shellLatch(sessionKey(ctx))})`,
                ]
              : []),
            ...(loadResult.notice ? [loadResult.notice] : []),
          ].join("\n"),
        );
        break;
      default:
        notify(
          ctx,
          `Unknown /clearance subcommand "${command}". Use status, ai, manual, off, model, rules, or explain.`,
          "warning",
        );
        break;
    }
  }

  omp.registerCommand?.("clearance", {
    description: "args: status | ai | manual | off | model | rules | explain",
    getArgumentCompletions: (prefix) => getClearanceArgumentCompletions(typeof prefix === "string" ? prefix : ""),
    handler: async (args, context) => {
      const ctx = canonicalContext(context);
      if (!ctx) {
        return;
      }
      const text = typeof args === "string" ? args : "";
      await runCommand(parseCommand(text), parseCommandRest(text), ctx);
    },
  });

  omp.on("session_start", (_event: unknown, context: unknown) => {
    approvals.clear();
    agentMessage = undefined;
    const ctx = canonicalContext(context);
    if (ctx) {
      refresh(ctx, { announce: true });
    }
  });

  // OMP passes the system prompt as an array of sections.
  omp.on("before_agent_start", (event: unknown) => {
    agentMessage = undefined;
    const systemPrompt = toRecord(event).systemPrompt;
    if (Array.isArray(systemPrompt)) {
      return { systemPrompt: [...systemPrompt, SYSTEM_PROMPT_NOTE] };
    }
    if (typeof systemPrompt === "string") {
      return { systemPrompt: `${systemPrompt}\n\n${SYSTEM_PROMPT_NOTE}` };
    }
    return undefined;
  });

  omp.on("resources_discover", (_event: unknown, context: unknown) => {
    refresh(canonicalContext(context) ?? lastContext ?? undefined);
  });

  omp.on("session_shutdown", () => {
    approvals.clear();
    lastContext?.ui?.setStatus?.(STATUS_KEY, undefined);
    lastContext = null;
  });

  omp.on("tool_call", async (event: unknown, context: unknown) => {
    try {
      const ctx = canonicalContext(context);
      if (!ctx) {
        return { block: true, reason: "Tool call was blocked because OMP supplied an invalid extension context." };
      }
      lastContext = ctx;
      if (loadResult.created || loadResult.warning) {
        refresh(ctx, { quiet: true });
      }
      const nextRules = watchCommandRules(rulesWatch);
      if (nextRules.rules.problem && nextRules.rules.problem !== rules.problem) {
        notify(ctx, rulesProblemText(nextRules.rules), "error");
      }
      if (!nextRules.rules.problem && rules.problem) {
        notify(ctx, "omp-clearance: command rules reloaded; bash calls are no longer blocked.", "info");
      }
      rulesWatch = nextRules;
      rules = nextRules.rules;
      const nextReviewer = loadReviewerState(config, loadResult.reviewerConfigured, reviewerState);
      if (nextReviewer.problem && nextReviewer.problem !== reviewerState.problem) {
        notify(ctx, nextReviewer.problem, "error");
      }
      reviewerState = nextReviewer;
      setStatus(ctx, reviewerState, rules);
      return await evaluateToolCall(event, ctx, config, approvals, {
        reviewer: reviewerState.reviewer,
        tools: canonicalTools(omp.getAllTools?.()),
        agentMessage,
        rules,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason: `omp-clearance failed to decide this tool call: ${reason}. Do not retry; report this error to the user.`,
      };
    }
  });

  // OMP fires tool_call while the assistant message that issued it is still
  // streaming (before message_end), so track its text from message_update.
  // A message with only tool calls keeps the previous text.
  const trackAgentMessage = (event: unknown) => {
    const message = toRecord(toRecord(event).message);
    if (message.role === "assistant") {
      agentMessage = assistantText(message.content) ?? agentMessage;
    }
  };
  omp.on("message_update", trackAgentMessage);
  omp.on("message_end", trackAgentMessage);
}

export { DEFAULT_CONFIG };
