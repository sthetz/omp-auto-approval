import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { logPath } from "../../src/extension-config.js";
import { evaluateToolCall } from "../../src/omp-host.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import { classifierDenyOptions, config, ctx, reasonOf } from "./helpers.js";

const REPORT = { toolName: "write", input: { path: "xd://report_issue", content: "read: unexpected result" } };
const BUILTIN_WRITE = { name: "write", sourceInfo: { source: "builtin" } };
const BLOCKED_COMMAND = { toolName: "bash", input: { command: "git push --force origin main" } };

await test("optional report denials stay blocked and audited without prompting or changing the denial streak", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-report-audit-"));
  const previousLogsDir = process.env.CALLGATE_LOGS_DIR;
  process.env.CALLGATE_LOGS_DIR = dir;
  t.after(() => {
    if (previousLogsDir === undefined) delete process.env.CALLGATE_LOGS_DIR;
    else process.env.CALLGATE_LOGS_DIR = previousLogsDir;
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new SessionApprovalStore();
  let aborts = 0;
  let prompts = 0;
  let classifierCalls = 0;
  const context = ctx({
    hasUI: true,
    abort: () => {
      aborts += 1;
    },
    ui: {
      select: async () => {
        prompts += 1;
        return "Allow Once";
      },
    },
  });
  const cfg = config({ audit: true, maxConsecutiveDenials: 2 });
  const options = {
    tools: [BUILTIN_WRITE],
    classifierClient: async () => {
      classifierCalls += 1;
      return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"telemetry not authorized"}' }] };
    },
  };
  await evaluateToolCall(BLOCKED_COMMAND, context, cfg, store, options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await evaluateToolCall(REPORT, context, cfg, store, options);
    assert.equal("block" in result && result.block, true);
    assert.match(reasonOf(result), /report was not submitted/);
    assert.match(reasonOf(result), /telemetry not authorized/);
    assert.match(reasonOf(result), /Continue the user's task/);
    assert.match(reasonOf(result), /unless the user explicitly authorizes/);
    assert.match(reasonOf(result), /final response/);
    assert.equal(store.consecutiveDenialCount, 1);
  }
  assert.equal(aborts, 0);
  assert.equal(prompts, 0, "an optional report must not escalate to a threshold override prompt");
  assert.equal(classifierCalls, 1, "cached report denials must retain the same handling");
  const audit = readFileSync(logPath(), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { toolName: string; route: string; outcome: string; reason: string });
  const reports = audit.filter((entry) => entry.toolName === "write");
  assert.deepEqual(
    reports.map(({ route, outcome, reason }) => ({ route, outcome, reason })),
    [
      { route: "classifier", outcome: "deny", reason: "telemetry not authorized" },
      { route: "classifier_cache", outcome: "deny", reason: "telemetry not authorized" },
      { route: "classifier_cache", outcome: "deny", reason: "telemetry not authorized" },
    ],
  );
  await evaluateToolCall(BLOCKED_COMMAND, context, cfg, store, options);
  assert.equal(aborts, 1, "reporting must not clear the streak protecting ordinary calls");
});

await test("failed or unanswered report reviews are non-blocking, including explicit Reject", async () => {
  for (const review of ["unavailable", "timeout", "reject", "failure"] as const) {
    const store = new SessionApprovalStore();
    store.recordDenial();
    let aborts = 0;
    const context = ctx({
      hasUI: review === "timeout" || review === "reject",
      abort: () => {
        aborts += 1;
      },
      ui: { select: async () => (review === "reject" ? "Reject" : undefined) },
    });
    const result = await evaluateToolCall(
      REPORT,
      context,
      config({ reviewer: review === "failure" ? "ai" : "manual", maxConsecutiveDenials: 2 }),
      store,
      {
        tools: [BUILTIN_WRITE],
        classifierClient: async () => {
          throw new Error("classifier unavailable");
        },
      },
    );
    assert.equal("block" in result && result.block, true, review);
    assert.match(reasonOf(result), /Continue the user's task/, review);
    assert.equal(store.consecutiveDenialCount, 1, review);
    assert.equal(aborts, 0, review);
  }
});

await test("an explicit Reject and Stop still ends the turn for optional reporting", async () => {
  const store = new SessionApprovalStore();
  store.recordDenial();
  let aborts = 0;
  const result = await evaluateToolCall(
    REPORT,
    ctx({
      hasUI: true,
      abort: () => {
        aborts += 1;
      },
      ui: { select: async () => "Reject and Stop the Turn" },
    }),
    config({ reviewer: "manual" }),
    store,
    { tools: [BUILTIN_WRITE] },
  );
  assert.equal("block" in result && result.block, true);
  assert.match(reasonOf(result), /user rejected this action and stopped the turn/);
  assert.doesNotMatch(reasonOf(result), /Continue/);
  assert.equal(aborts, 1);
  assert.equal(store.consecutiveDenialCount, 0);
});

await test("allowed optional reports preserve the denial streak across reviewer and approval routes", async () => {
  for (const route of ["off", "ai", "once", "exact", "exempt"] as const) {
    const store = new SessionApprovalStore();
    store.recordDenial();
    let aborts = 0;
    const context = ctx({
      hasUI: true,
      abort: () => {
        aborts += 1;
      },
      ui: { select: async () => (route === "exact" ? "Allow Always This Exact Action" : "Allow Once") },
    });
    const cfg = config({
      reviewer: route === "off" ? "off" : route === "once" || route === "exact" ? "manual" : "ai",
      maxConsecutiveDenials: 2,
      reviewExemptTools: route === "exempt" ? ["write"] : [],
    });
    const options = {
      tools: [BUILTIN_WRITE],
      classifierClient: async () => ({ content: [{ type: "text", text: '{"outcome":"allow"}' }] }),
    };
    assert.deepEqual(await evaluateToolCall(REPORT, context, cfg, store, options), {}, route);
    assert.deepEqual(await evaluateToolCall(REPORT, context, cfg, store, options), {}, route);
    assert.equal(store.consecutiveDenialCount, 1, route);
    await evaluateToolCall(BLOCKED_COMMAND, context, cfg, store, options);
    assert.equal(aborts, 1, route);
  }
});

await test("the optional reporting exception excludes lookalike tools and non-exact targets", async () => {
  const cases = [
    ...["extension", "sdk", "mcp"].map((source) => ({
      event: REPORT,
      tools: [{ name: "write", sourceInfo: { source } }],
    })),
    { event: REPORT, tools: [{ name: "bash", sourceInfo: { source: "builtin" } }] },
    ...["xd://report_issue/", "xd://report_issue?x=1", "XD://report_issue", "xd://other"].map((path) => ({
      event: { toolName: "write", input: { path, content: "read: unexpected result" } },
      tools: [BUILTIN_WRITE],
    })),
    {
      event: { toolName: "write", input: { file_path: "xd://report_issue", content: "read: unexpected result" } },
      tools: [BUILTIN_WRITE],
    },
    ...["read", "edit"].map((toolName) => ({
      event: { ...REPORT, toolName },
      tools: [{ name: toolName, sourceInfo: { source: "builtin" } }],
    })),
  ];
  for (const { event, tools } of cases) {
    let aborts = 0;
    const result = await evaluateToolCall(
      event,
      ctx({
        abort: () => {
          aborts += 1;
        },
      }),
      config({ maxConsecutiveDenials: 1 }),
      new SessionApprovalStore(),
      { tools, ...classifierDenyOptions() },
    );
    assert.equal("block" in result && result.block, true, JSON.stringify({ event, tools }));
    assert.equal(aborts, 1, JSON.stringify({ event, tools }));
    assert.match(reasonOf(result), /stopped the turn/);
    assert.doesNotMatch(reasonOf(result), /Continue the user's task/);
  }
});
