import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../src/extension-config.js";
import { itemAt } from "../../src/common.js";
import { runClassifierEval } from "../classifier-eval/run.js";
import { adaptTsBenchCase, type TsBenchExpectedOutcome } from "../classifier-eval/ts-bench.js";

function fixture(caseId: string, expectedOutcome: TsBenchExpectedOutcome, configuration = "alpha", tags = ["shared"]) {
  return adaptTsBenchCase({
    caseId,
    expectedOutcome,
    source: { configuration },
    tags,
    selectionRationale: "fixture",
    originalRecord: {
      instruction: "Read the report",
      history: "",
      current_action: '(1) Thought: Read it.\n(2) Action: terminal\n(3) Action Input: {"command":"cat report"}',
      env_info: "",
    },
  });
}

const model = { id: "fake", provider: "fake" };
const config = { ...DEFAULT_CONFIG, classifierModel: null };

await test("scores raw and final outcomes, missing fields, latency, and group membership", async () => {
  const cases = [
    fixture("fa", "deny", "alpha", ["shared", "risk"]),
    fixture("fd", "allow", "beta"),
    fixture("policy", "deny", "beta", ["risk"]),
    fixture("ok", "allow", "alpha"),
  ];
  const replies: Record<string, unknown> = {
    fa: { content: '{"outcome":"allow"}' },
    fd: { content: '{"outcome":"deny","risk_level":"low","user_authorization":"high","rationale":"no"}' },
    policy: { content: '{"outcome":"allow","risk_level":"high","user_authorization":"low"}' },
    ok: { content: '{"outcome":"allow"}' },
  };
  const times = [0, 10, 20, 60, 70, 90, 100, 130];
  let tick = 0;
  const { results, summary } = await runClassifierEval(cases, config, {
    model,
    clientForCase: (input) => async () => replies[input.caseId],
    clock: () => itemAt(times, tick++),
  });
  assert.deepEqual(summary.falseAllows, ["fa"]);
  assert.deepEqual(summary.falseDenies, ["fd"]);
  assert.deepEqual(summary.rawFalseAllows, ["fa", "policy"]);
  assert.deepEqual(summary.correctDenies, ["policy"]);
  assert.deepEqual(summary.correctAllows, ["ok"]);
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(summary.missing, { risk_level: 2, user_authorization: 2, rationale: 3 });
  assert.equal(results[2]?.rawDecision?.outcome, "allow");
  assert.equal(results[2].finalDecision?.outcome, "deny");
  assert.deepEqual(summary.latencyMs, { median: 25, p90: 40 });
  assert.deepEqual(summary.bySourceConfiguration.alpha?.caseIds, ["fa", "ok"]);
  assert.deepEqual(summary.bySourceConfiguration.beta?.falseDenies, ["fd"]);
  assert.deepEqual(summary.byTag.risk?.caseIds, ["fa", "policy"]);
  assert.deepEqual(summary.byTag.shared?.caseIds, ["fa", "fd", "ok"]);
});

await test("response shapes use production extraction", async () => {
  const cases = [fixture("string", "deny"), fixture("content", "deny"), fixture("output", "deny")];
  const replies: Record<string, unknown> = {
    string: { content: '{"outcome":"deny"}' },
    content: { content: [{ text: '{"outcome":' }, { text: '"deny"}' }] },
    output: { output: [{ text: '{"outcome":' }, { text: '"deny"}' }] },
  };
  const { results, summary } = await runClassifierEval(cases, config, {
    model,
    clientForCase: (input) => async () => replies[input.caseId],
    clock: () => 0,
  });
  assert.deepEqual(
    results.map((item) => item.rawDecision?.outcome),
    ["deny", "deny", "deny"],
  );
  assert.deepEqual(summary.correctDenies, ["string", "content", "output"]);
});

await test("malformed output, provider errors, thrown errors and timeouts stay local", async () => {
  const cases = [
    fixture("bad", "deny"),
    fixture("throw", "allow"),
    fixture("provider", "deny"),
    fixture("timeout", "deny"),
    fixture("later", "allow"),
  ];
  const { results, summary } = await runClassifierEval(
    cases,
    { ...config, classifierTimeoutSeconds: 0.01 },
    {
      model,
      clock: () => 0,
      clientForCase: (input) => async () => {
        if (input.caseId === "bad") return { content: "not json" };
        if (input.caseId === "throw") throw new Error("client broke");
        if (input.caseId === "provider") return { errorMessage: "provider broke" };
        if (input.caseId === "timeout") return await new Promise(() => {});
        return { content: '{"outcome":"allow"}' };
      },
    },
  );
  assert.deepEqual(summary.failures, ["bad", "throw", "provider", "timeout"]);
  assert.deepEqual(summary.falseAllows, []);
  assert.deepEqual(summary.falseDenies, []);
  assert.deepEqual(summary.correctAllows, ["later"]);
  assert.equal(results[0]?.rawResponseText, "not json");
  assert.match(results[1]?.failure ?? "", /client broke/);
  assert.match(results[2]?.failure ?? "", /provider broke/);
  assert.match(results[3]?.failure ?? "", /timed out/);
});
