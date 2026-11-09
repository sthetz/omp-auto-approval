import type { AutoReviewConfig, ExtensionContextLike, ToolCallEventLike } from "./src/types.js";
import { configPath, DEFAULT_CONFIG, loadConfig, logPath, saveConfig } from "./src/extension-config.js";
import { evaluateToolCall, selectFastPath, type FastPathRoute } from "./src/decision.js";
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

const STATUS_KEY = "omp-auto-approval";

// Appended to the system prompt while auto-approval is on, so a blocked call
// is reported instead of retried in another form.
export const SYSTEM_PROMPT_NOTE = [
  "Tool calls in this session are reviewed by omp-auto-approval before they run.",
  "If a call is blocked, do not retry it in another form or route around the block",
  "(another tool, an encoded or rewritten command, a script that does the same thing).",
  "Tell the user what was blocked and why, and wait for their guidance.",
].join(" ");

const ROUTE_EXPLANATIONS: Record<FastPathRoute, string> = {
  blocked_command: "blocked: matches a blockCommands rule, never auto-approved or asked",
  local_state: "allowed without review: local session state (todo, wait)",
  ui_only: "allowed without review: interactive ask with no remote content",
  tool_allowlist: "allowed without review: tool is listed in reviewExemptTools",
  readonly: "allowed without review: read-only builtin tool, every target is a non-sensitive path in the workspace or readRoots",
  workspace_write: "allowed without review: write inside the workspace, outside protected entries",
  safe_command: "allowed without review: built-in or allowlisted read-only command",
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
  return `auto-approval:${config.mode}`;
}

function stateText(config: AutoReviewConfig): "off" | "fallback" | "auto" {
  return config.enabled ? config.mode : "off";
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
  { value: "explain", label: "explain", description: "Show how a tool call would be routed: explain <tool> <path | JSON | command>" },
];

function getAutoReviewArgumentCompletions(argumentPrefix: string): Array<{ value: string; label: string; description: string }> | null {
  const normalized = argumentPrefix.trimStart().toLowerCase();
  const filtered = COMMAND_ARGUMENTS.filter((item) => (
    item.value.startsWith(normalized) || item.label.includes(normalized)
  ));
  return filtered.length ? filtered : null;
}

export default function ompAutoApprovalExtension(omp: ExtensionAPI): void {
  let loadResult = loadConfig();
  let config = loadResult.config;
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
    if (ctx) {
      setStatus(ctx, config);
      if (loadResult.warning) {
        notify(ctx, loadResult.warning, "warning");
      }
      if (options.announce && loadResult.notice) {
        notify(ctx, loadResult.notice, "warning");
      }
    }
  }

  function explain(rest: string, ctx: ExtensionContextLike): void {
    const firstWord = rest.split(/\s+/, 1)[0] ?? "";
    if (!firstWord) {
      notify(ctx, "Usage: /auto-approval explain <tool> [path | JSON arguments | bash command], or a bash command", "warning");
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
    const route = selectFastPath(toolName, parsed.input, {
      cwd: ctx.cwd || process.cwd(),
      config,
      tools,
      hasUI: ctx.hasUI === true,
    });
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
    ].join("\n"));
  }

  function persist(next: AutoReviewConfig, ctx: ExtensionContextLike): void {
    const saved = saveConfig(next);
    if (!saved.success) {
      notify(ctx, `Failed to save omp-auto-approval config: ${saved.error ?? "unknown error"}`, "error");
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
        approvals.clear();
        notify(ctx, "omp-auto-approval state: off.");
        break;
      case "fallback":
        persist({ ...config, enabled: true, mode: "fallback" }, ctx);
        notify(ctx, "omp-auto-approval state: fallback.");
        break;
      case "auto":
        persist({ ...config, enabled: true, mode: "auto" }, ctx);
        notify(ctx, "omp-auto-approval state: auto.");
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
        notify(ctx, "Use /auto-approval model to select an approval classifier model.", "warning");
        break;
      }
      case "explain":
        explain(rest, ctx);
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
            ...(loadResult.notice ? [loadResult.notice] : []),
          ].join("\n"),
        );
        break;
    }
  }

  omp.registerCommand?.("auto-approval", {
    description: "args: status | off | fallback | auto | model | explain",
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
