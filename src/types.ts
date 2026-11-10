export type ClearanceMode = "fallback" | "auto";

export interface AuthResolution {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  error?: string;
}

export interface ClearanceConfig {
  enabled: boolean;
  mode: ClearanceMode;
  classifierModel: string | null;
  approvalTimeoutSeconds: number;
  classifierTimeoutSeconds: number;
  maxConsecutiveDenials: number;
  readRoots: string[];
  reviewExemptTools: string[];
  allow: string[];
  deny: string[];
  environment: string;
  audit: boolean;
}

export interface ClassifierDecision {
  risk_level?: "low" | "medium" | "high" | "critical";
  user_authorization?: "unknown" | "low" | "medium" | "high";
  outcome: "allow" | "deny";
  rationale?: string;
}

export interface ExtensionContextLike {
  cwd?: string;
  mode?: "tui" | "rpc" | "print" | string;
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[], optionsOverride?: unknown) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string, optionsOverride?: unknown) => Promise<string | undefined>;
    custom?: <T>(
      factory: (
        tui: any,
        theme: any,
        keybindings: any,
        done: (result: T) => void,
      ) => unknown | Promise<unknown>,
      optionsOverride?: unknown,
    ) => Promise<T>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, value: string | undefined) => void;
  };
  // Ends the current OMP agent turn.
  abort?: () => void;
  model?: unknown;
  modelRegistry?: {
    refresh?: () => unknown;
    getError?: () => string | undefined;
    find?: (provider: string, id: string) => unknown;
    getAvailable?: () => unknown[] | Promise<unknown[]>;
    // Resolves request auth (apiKey/headers/env) for a model the way pi's
    // normal model calls do, reading keys/headers from ~/.pi/agent/models.json,
    // auth storage, and provider env. The classifier must inject this into its
    // completeSimple call so custom providers (e.g. a `my-proxy` provider whose
    // apiKey lives in models.json, or an OAuth-backed provider) actually send
    // auth — otherwise the compat completeSimple path only checks the known
    // provider env-var map and bypasses models.json entirely.
    getApiKeyAndHeaders?: (model: unknown) => Promise<AuthResolution>;
  };
  sessionManager?: {
    getEntries?: () => unknown[];
    getBranch?: () => unknown[];
    // OMP: the session header; a subagent's names its parent session file.
    getHeader?: () => unknown;
    getSessionId?: () => string;
  };
}

export interface ReviewSubject {
  toolName: string;
  input: unknown;
  cwd: string;
  actionSummary: string;
  actionHash: string;
}

export type RouteName =
  | "disabled"
  | "local_state"
  | "ui_only"
  | "tool_allowlist"
  | "readonly"
  | "workspace_write"
  | "safe_command"
  | "session_approval"
  | "classifier_cache"
  | "classifier"
  | "human"
  | "manual_only"
  | "blocked_command"
  | "ask_rule";

export interface AuditEntry {
  event: string;
  route: RouteName;
  mode: ClearanceMode;
  toolName: string;
  actionSummary: string;
  actionHash: string;
  outcome: "allow" | "deny";
  classifierDecision?: ClassifierDecision;
  humanDecision?: string;
  reason?: string;
  // The command that ran instead, for a bash command pinned to its program's path.
  pinnedCommand?: string;
  // The directory a leading `cd` in the command moved the call to.
  pinnedCwd?: string;
  // For a fast-pathed bash command: the rules that let each part through.
  ruleIds?: string[];
  // The command rule that decided (block, ask, or review), and its file.
  ruleId?: string;
  ruleSource?: string;
  durationMs?: number;
}

/** An approved bash command turned the session's bash fast path off (see shellHook). */
export interface ShellLatchEntry {
  event: "shell_latch";
  mode: ClearanceMode;
  toolName: string;
  actionSummary: string;
  actionHash: string;
  reason: string;
}
