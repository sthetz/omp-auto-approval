// Shared setup for the unit tests. Importing it puts stub programs first on
// the PATH the tests use and points the config, rules and audit log at
// temporary files, never those of the checkout or of a real install.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/extension-config.js";
import { decide, type DecisionState } from "../../src/decision.js";
import { evaluateToolCall } from "../../src/omp-host.js";
import { planSafeCommand } from "../../src/safe-command.js";
import { defaultRules, loadCommandRules, type CommandRules } from "../../src/command-rules.js";
import { type ClearanceConfig, type ExtensionContextLike } from "../../src/types.js";
// Fast-pathed commands are pinned to a program found on OMP's startup PATH.
// Stub programs make the tests independent of what this machine has
// installed; the real PATH stays behind them.
export const STUB_PROGRAMS = [
  "basename",
  "cat",
  "cut",
  "date",
  "dd",
  "diff",
  "docker",
  "du",
  "echo",
  "fd",
  "find",
  "git",
  "grep",
  "head",
  "jq",
  "kubectl",
  "ls",
  "npm",
  "printf",
  "pwd",
  "python",
  "rg",
  "sed",
  "sleep",
  "sort",
  "stat",
  "tail",
  "tar",
  "timeout",
  "tr",
  "uname",
  "uniq",
  "wc",
  "which",
];
export const STUB_BIN = mkdtempSync(join(tmpdir(), "omp-clearance-bin-"));
for (const name of STUB_PROGRAMS) {
  writeFileSync(join(STUB_BIN, name), "#!/bin/sh\n");
  chmodSync(join(STUB_BIN, name), 0o755);
}
export const TEST_PATH = `${STUB_BIN}:${process.env.PATH ?? ""}`;
process.on("exit", () => rmSync(STUB_BIN, { recursive: true, force: true }));
// No user rules file unless a test names one, and the config and audit log
// in a temporary directory unless a test names others: never the files of the
// checkout or of a real install.
process.env.CLEARANCE_RULES_PATH = join(STUB_BIN, "no-rules.jsonc");
process.env.CLEARANCE_CONFIG_PATH = join(STUB_BIN, "config.jsonc");
process.env.CLEARANCE_LOGS_DIR = join(STUB_BIN, "logs");

export function isSafeReadOnlyCommand(command: string, cfg: TestConfig, cwd: string): boolean {
  return planSafeCommand(command, cfg, { workspace: cwd, searchPath: TEST_PATH, rules: cfg.rules }) !== null;
}

/** The command a fast-pathed command runs as, or null when it is reviewed. */
export function pinnedCommand(
  command: string,
  cfg: TestConfig,
  workspace: string,
  searchPath = TEST_PATH,
): string | null {
  return planSafeCommand(command, cfg, { workspace, searchPath, rules: cfg.rules })?.command ?? null;
}

/** `value`, which the test has set up to be there; fails the test if it isn't. */
export function required<T>(value: T | null | undefined, what: string): T {
  assert.ok(value !== null && value !== undefined, `${what} is missing`);
  return value;
}

/** The reason of a tool_call response, or "" when it has none. */
export function reasonOf(response: unknown): string {
  const reason: unknown =
    response && typeof response === "object" ? (response as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" ? reason : "";
}

// A config, and the command rules to use with it: the built-in ones, plus
// allow rules for `allowRules` prefixes and block rules for `blockRules` patterns.
export type TestConfig = ClearanceConfig & { rules: CommandRules };
export const RULES_DIR = mkdtempSync(join(tmpdir(), "omp-clearance-test-rules-"));
process.on("exit", () => rmSync(RULES_DIR, { recursive: true, force: true }));
let rulesFiles = 0;

export function testRules(allowRules: string[] = [], blockRules: string[] = []): CommandRules {
  if (!allowRules.length && !blockRules.length) {
    return defaultRules();
  }
  const file = join(RULES_DIR, `rules-${(rulesFiles += 1)}.jsonc`);
  writeFileSync(
    file,
    JSON.stringify({
      rules: [
        ...allowRules.map((prefix, index) => ({ id: `allow-${index}`, outcome: "allow", prefix })),
        ...blockRules.map((match, index) => ({ id: `block-${index}`, outcome: "block", match })),
      ],
    }),
  );
  const rules = loadCommandRules(file);
  if (rules.problem) {
    throw new Error(rules.problem);
  }
  return rules;
}

export function config(
  overrides: Partial<ClearanceConfig> & { allowRules?: string[]; blockRules?: string[] } = {},
): TestConfig {
  const { allowRules, blockRules, ...rest } = overrides;
  return { ...DEFAULT_CONFIG, reviewer: "ai", audit: false, ...rest, rules: testRules(allowRules, blockRules) };
}

export function ctx(overrides: Partial<ExtensionContextLike> = {}): ExtensionContextLike {
  return {
    cwd: "/tmp/workspace",
    hasUI: false,
    model: { id: "test", api: "test" },
    sessionManager: { getBranch: () => [] },
    ...overrides,
  };
}

export function staticRoute(
  toolName: string,
  input: unknown,
  options: Pick<DecisionState, "cwd" | "config" | "tools" | "hasUI"> &
    Partial<Pick<DecisionState, "rules" | "shellLatched">>,
): string | null {
  const decision = decide(
    { toolName, input },
    {
      ...options,
      reviewer: options.config.reviewer,
      canAsk: false,
      consecutiveDenials: 0,
      shellLatched: options.shellLatched ?? false,
      rules: options.rules ?? defaultRules(),
      exactApproved: false,
    },
  );
  return decision.staticVerdict?.outcome === "review" ? null : (decision.staticVerdict?.route ?? null);
}

export const CLASSIFIER_DENY_REASON =
  "The approval classifier rejected this action. Reason: needs review Do not retry the same action unless the user explicitly approves it.";

export function classifierDenyOptions(reason = "needs review"): {
  classifierClient: NonNullable<Parameters<typeof evaluateToolCall>[4]>["classifierClient"];
} {
  return {
    classifierClient: async () => ({
      content: [{ type: "text", text: `{"outcome":"deny","rationale":"${reason}"}` }],
    }),
  };
}

// The four kubectl rules from the design, over the example's kubectl table.
export const KUBE_RULES = `{
  "include": [],
  "programs": {
    "kubectl": {
      "subcommands": {
        "get describe": { "options": { "-n --namespace": "string", "-o --output": "string" }, "operands": "literals" },
        "exec": { "options": "any", "operands": "any" }
      }
    }
  },
  "rules": [
    { "id": "kube-secrets", "match": "kubectl get|describe secret|secrets|secret/*", "outcome": "review",
      "why": "Secret values must not reach the model unreviewed." },
    { "id": "kube-impersonate", "match": "kubectl --as|--as-group|--token|--raw", "outcome": "review" },
    { "id": "kube-interactive", "match": "kubectl exec|port-forward|cp|edit|apply|rollout", "outcome": "ask" },
    { "id": "kube-delete-all", "match": "kubectl delete --all", "outcome": "block" }
  ]
}`;
