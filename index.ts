import type { AutoReviewConfig, ExtensionContextLike, ToolCallEventLike } from "./src/types.js";
import { configPath, DEFAULT_CONFIG, loadConfig, logPath, saveConfig } from "./src/extension-config.js";
import { defaultRulesPath, loadCommandRules, userRulesPath, type CommandRules } from "./src/command-rules.js";
import { bashEscalation, evaluateToolCall, planBashCommand, selectFastPath, sessionKey, type FastPathRoute } from "./src/decision.js";
import { describeRule, rulesOverview } from "./src/rules-report.js";
import { toRecord } from "./src/common.js";
import { findToolDefinition } from "./src/tool-routing.js";
import { assistantText } from "./src/context-projection.js";
import { SessionApprovalStore } from "./src/session-approval-store.js";
import { selectClassifierModel } from "./src/model-selector.js";

type ExtensionAPI = {
  on(event: string, handler: (...args: any[]) => any): void;
  getAllTools?: () => unknown[];
  registerCommand?: (
    name: string,
    definition: {
      description: string;
      getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label?: string; description?: string }> | null | Promise<Array<{ value: string; label?: string; description?: string }> | null>;
      handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void;
    },
  ) => void;
};

const STATUS_KEY = "omp-clearance";

// Appended to the system prompt while omp-clearance is on, so a blocked call
// is reported instead of retried in another form.
export const SYSTEM_PROMPT_NOTE = [
  "Tool calls in this session are reviewed by omp-clearance before they run.",
  "If a call is blocked, do not retry it in another form or route around the block",
  "(another tool, an encoded or rewritten command, a script that does the same thing).",
  "Tell the user what was blocked and why, and wait for their guidance.",
].join(" ");

const ROUTE_EXPLANATIONS: Record<FastPathRoute, string> = {
  blocked_command: "blocked: matches a block command rule, never auto-approved or asked",
  ask_rule: "asks you directly, without the classifier: matches an ask command rule (denied in auto mode or without a UI)",
  local_state: "allowed without review: local session state (todo, wait)",
  ui_only: "allowed without review: interactive ask with no remote content",
  tool_allowlist: "allowed without review: tool is listed in reviewExemptTools",
  readonly: "allowed without review: read-only builtin tool, every target is a non-sensitive path in the workspace or readRoots",
  workspace_write: "allowed without review: write inside the workspace, outside protected entries",
  safe_command: "allowed without review: every command is read-only by the command rules",
  manual_only: "needs manual approval: this tool cannot be auto-approved",
};

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

function statusText(config: AutoReviewConfig): string | undefined {
  if (!config.enabled) {
    return undefined;
  }
  return `clearance:${config.mode}`;
}

function stateText(config: AutoReviewConfig): "off" | "fallback" | "auto" {
  return config.enabled ? config.mode : "off";
}

function rulesProblemText(rules: CommandRules): string {
  return `omp-clearance: the command rules could not be loaded, so every bash command asks you first (and is denied in auto mode): ${rules.problem}. Fix the file, then run /clearance status to reload it.`;
}

function rulesStatusText(rules: CommandRules): string[] {
  if (rules.problem) {
    return [rulesProblemText(rules)];
  }
  const [main, ...included] = rules.files;
  return [
    `command rules: ${defaultRulesPath()}`,
    main ? `user rules: ${main}${included.length ? ` (including ${included.join(", ")})` : ""}` : `user rules: none (${userRulesPath()} does not exist)`,
  ];
}

function notify(ctx: ExtensionContextLike, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui?.notify?.(message, type);
}

function setStatus(ctx: ExtensionContextLike, config: AutoReviewConfig): void {
  ctx.ui?.setStatus?.(STATUS_KEY, statusText(config));
}

function parseCommand(args: string): string {
  return args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
}

function parseCommandRest(args: string): string {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace).trim();
}

function classifierModelText(config: AutoReviewConfig): string {
  return config.classifierModel ?? "current";
}

const COMMAND_ARGUMENTS = [
  { value: "status", label: "status", description: "Show current state and approval model" },
  { value: "off", label: "off", description: "Disable automatic approval" },
  { value: "fallback", label: "fallback", description: "AI review, then human approval on failure or denial" },
  { value: "auto", label: "auto", description: "AI review only; fail closed on failure or denial" },
  { value: "model", label: "model", description: "Select approval classifier model" },
  { value: "model current", label: "model current", description: "Use the active OMP session model for approval" },
  { value: "rules", label: "rules", description: "Show the command rules in use: rules [program | rule id]" },
  { value: "explain", label: "explain", description: "Show how a tool call would be routed: explain <tool> <path | JSON | command>" },
];

function getAutoReviewArgumentCompletions(argumentPrefix: string): Array<{ value: string; label: string; description: string }> | null {
  const normalized = argumentPrefix.trimStart().toLowerCase();
  const filtered = COMMAND_ARGUMENTS.filter((item) => (
    item.value.startsWith(normalized) || item.label.includes(normalized)
  ));
  return filtered.length ? filtered : null;
}

export default function ompClearanceExtension(omp: ExtensionAPI): void {
  let loadResult = loadConfig();
  let config = loadResult.config;
  // The command rules for this session: re-read at session start and on any
  // /clearance command.
  let rules = loadCommandRules();
  const approvals = new SessionApprovalStore();
  let lastContext: ExtensionContextLike | null = null;
  // Latest assistant text in the current agent run, for the classifier.
  let agentMessage: string | undefined;

  function refresh(ctx?: ExtensionContextLike, options: { announce?: boolean } = {}): void {
    if (ctx) {
      lastContext = ctx;
    }
    loadResult = loadConfig();
    config = loadResult.config;
    rules = loadCommandRules();
    if (ctx) {
      setStatus(ctx, config);
      if (loadResult.warning) {
        notify(ctx, loadResult.warning, "warning");
      }
      if (options.announce && loadResult.notice) {
        notify(ctx, loadResult.notice, "warning");
      }
      if (options.announce && rules.problem) {
        notify(ctx, rulesProblemText(rules), "error");
      }
    }
  }

  function explain(rest: string, ctx: ExtensionContextLike): void {
    const firstWord = rest.split(/\s+/, 1)[0] ?? "";
    if (!firstWord) {
      notify(ctx, "Usage: /clearance explain <tool> [path | JSON arguments | bash command], or a bash command", "warning");
      return;
    }
    const tools = omp.getAllTools?.() ?? [];
    // `explain ls -la` means the shell command: no session tool has that name.
    const asCommand = firstWord !== "bash" && tools.length > 0 && findToolDefinition(firstWord, tools) === undefined;
    const toolName = asCommand ? "bash" : firstWord;
    const parsed = parseExplainInput(toolName, asCommand ? rest : rest.slice(firstWord.length).trim());
    if ("error" in parsed) {
      notify(ctx, parsed.error, "warning");
      return;
    }
    const source = toRecord(toRecord(findToolDefinition(toolName, tools)).sourceInfo).source;
    const escalation = bashEscalation(toolName, parsed.input, config, rules);
    const route = selectFastPath(toolName, parsed.input, {
      escalation,
      cwd: ctx.cwd || process.cwd(),
      config,
      tools,
      hasUI: ctx.hasUI === true,
      shellLatched: approvals.shellLatch(sessionKey(ctx)) !== null,
      rules,
    });
    const plan = route === "safe_command" ? planBashCommand(toolName, parsed.input, ctx.cwd || process.cwd(), config, rules) : null;
    const review = config.mode === "fallback"
      ? "classifier review; you decide if it denies or fails"
      : "classifier review; blocked if it denies or fails";
    const outcome = route === "manual_only" && config.mode === "auto"
      ? "blocked: this tool cannot be auto-approved and auto mode never asks"
      : route
        ? ROUTE_EXPLANATIONS[route]
        : review;
    notify(ctx, [
      ...(asCommand ? [`note: no tool named "${firstWord}" in this session; explained as a bash command`] : []),
      `state: ${stateText(config)}${config.enabled ? "" : " (nothing is reviewed while off)"}`,
      `tool: ${toolName}${typeof source === "string" ? ` (${source})` : ""}`,
      `arguments: ${JSON.stringify(parsed.input)}`,
      `route: ${outcome}`,
      ...(plan && plan.command !== toRecord(parsed.input).command ? [`runs as: ${plan.command}`] : []),
      ...(plan?.cwd ? [`runs in: ${plan.cwd}`] : []),
      ...(plan ? [`allowed by: ${plan.rules.map((used) => `${used.id} (${used.source})`).join(", ")}`] : []),
      ...(plan?.rules.some((used) => used.source !== "default" && used.source !== "config.jsonc")
        ? ["note: entries from your rules files are not checked by the program oracle, as the built-in ones are"]
        : []),
      ...(escalation ? [
        `rule: ${escalation.rule.id} (${escalation.rule.outcome}, ${escalation.rule.source})${escalation.textOnly ? `; matched only quoted text, so reviewed instead` : ""}`,
        ...(escalation.rule.why ? [`why: ${escalation.rule.why}`] : []),
      ] : []),
      ...(toolName === "bash" && rules.problem ? [rulesProblemText(rules)] : []),
      ...(toolName === "bash" && approvals.shellLatch(sessionKey(ctx)) ? [`note: the bash fast path is off for this session: an approved command used ${approvals.shellLatch(sessionKey(ctx))}`] : []),
    ].join("\n"));
  }

  function persist(next: AutoReviewConfig, ctx: ExtensionContextLike): void {
    const saved = saveConfig(next);
    if (!saved.success) {
      notify(ctx, `Failed to save omp-clearance config: ${saved.error ?? "unknown error"}`, "error");
      return;
    }
    config = next;
    setStatus(ctx, config);
  }

  async function runCommand(command: string, rest: string, ctx: ExtensionContextLike): Promise<void> {
    lastContext = ctx;
    refresh(ctx);
    switch (command) {
      case "off":
        persist({ ...config, enabled: false }, ctx);
        // The shell keeps whatever earlier commands set up, so its latch stays.
        approvals.clear();
        notify(ctx, "omp-clearance state: off.");
        break;
      case "fallback":
        persist({ ...config, enabled: true, mode: "fallback" }, ctx);
        notify(ctx, "omp-clearance state: fallback.");
        break;
      case "auto":
        persist({ ...config, enabled: true, mode: "auto" }, ctx);
        notify(ctx, "omp-clearance state: auto.");
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
          notify(ctx, rulesProblemText(rules), "warning");
        } else if (rest) {
          notify(ctx, describeRule(rules, rest) ?? `No program or rule named "${rest}". /clearance rules lists them.`, "info");
        } else {
          notify(ctx, rulesOverview(rules));
        }
        break;
      case "status":
      default:
        notify(
          ctx,
          [
            `state: ${stateText(config)}`,
            `approval classifier model: ${classifierModelText(config)}`,
            `config: ${configPath()}`,
            `audit log: ${logPath()}`,
            ...rulesStatusText(rules),
            ...(approvals.shellLatch(sessionKey(ctx)) ? [`bash fast path: off for this session (an approved command used ${approvals.shellLatch(sessionKey(ctx))})`] : []),
            ...(loadResult.notice ? [loadResult.notice] : []),
          ].join("\n"),
        );
        break;
    }
  }

  omp.registerCommand?.("clearance", {
    description: "args: status | off | fallback | auto | model | rules | explain",
    getArgumentCompletions: getAutoReviewArgumentCompletions,
    handler: async (args, ctx) => {
      await runCommand(parseCommand(args), parseCommandRest(args), ctx);
    },
  });

  omp.on("session_start", async (_event: unknown, ctx: ExtensionContextLike) => {
    approvals.clear();
    agentMessage = undefined;
    refresh(ctx, { announce: true });
  });

  // OMP passes the system prompt as an array of sections, Pi as one string.
  omp.on("before_agent_start", async (event: unknown) => {
    agentMessage = undefined;
    if (!config.enabled) {
      return undefined;
    }
    const systemPrompt = toRecord(event).systemPrompt;
    if (Array.isArray(systemPrompt)) {
      return { systemPrompt: [...systemPrompt, SYSTEM_PROMPT_NOTE] };
    }
    if (typeof systemPrompt === "string") {
      return { systemPrompt: `${systemPrompt}\n\n${SYSTEM_PROMPT_NOTE}` };
    }
    return undefined;
  });

  omp.on("resources_discover", async (_event: unknown, ctx: ExtensionContextLike) => {
    refresh(ctx ?? lastContext ?? undefined);
  });

  omp.on("session_shutdown", async () => {
    approvals.clear();
    lastContext?.ui?.setStatus?.(STATUS_KEY, undefined);
    lastContext = null;
  });

  omp.on("tool_call", async (event: ToolCallEventLike, ctx: ExtensionContextLike) => {
    lastContext = ctx;
    if (loadResult.created || loadResult.warning) {
      refresh(ctx);
    }
    return evaluateToolCall(event, ctx, config, approvals, {
      tools: omp.getAllTools?.() ?? [],
      agentMessage,
      rules,
    });
  });

  // OMP fires tool_call while the assistant message that issued it is still
  // streaming (before message_end), so track its text from message_update.
  // A message with only tool calls keeps the previous text.
  const trackAgentMessage = async (event: unknown) => {
    const message = toRecord(toRecord(event).message);
    if (message.role === "assistant") {
      agentMessage = assistantText(message.content) ?? agentMessage;
    }
  };
  omp.on("message_update", trackAgentMessage);
  omp.on("message_end", trackAgentMessage);
}

export { DEFAULT_CONFIG };
