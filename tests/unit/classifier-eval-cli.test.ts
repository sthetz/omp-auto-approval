import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../src/extension-config.js";
import { buildSystemPrompt } from "../../src/prompt.js";
import { executeEval, parseArgs, USAGE } from "../classifier-eval/cli.js";

await test("argument validation and help do not need a model", async () => {
  assert.equal(parseArgs(["--help"]), null);
  for (const args of [[], ["--cases"], ["--cases", "x"], ["--wat", "x"], ["--cases", "a", "--cases", "b"]]) {
    assert.throws(() => parseArgs(args));
  }
  const output: string[] = [];
  await executeEval(["--help"], { model: undefined, client: async () => null }, { print: (s) => output.push(s) });
  assert.deepEqual(output, [USAGE]);
});

await test("writes ordered measurements and safe reproducibility metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "classifier-cli-"));
  try {
    const casesPath = join(dir, "cases.jsonl");
    const outputPath = join(dir, "results", "run.json");
    const record = (id: string, expected: string) => ({
      case_id: id,
      expected_outcome: expected,
      source: { configuration: "fixture", revision: "rev123", apiKey: "source-secret" },
      tags: ["risk"],
      selection_rationale: "fixture",
      original_record: {
        instruction: "Read report",
        history: "",
        current_action: '(1) Thought: Read it.\n(2) Action: terminal\n(3) Action Input: {"command":"cat report"}',
        env_info: "",
      },
    });
    const data =
      [
        record("false-allow", "deny"),
        record("failure", "allow"),
        record("correct", "allow"),
        record("false-deny", "allow"),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n";
    writeFileSync(casesPath, data);
    const marker = "API-SECRET-MARKER";
    const header = "HEADER-SECRET-MARKER";
    const env = "ENV-SECRET-MARKER";
    const model = { provider: "fake", id: "test", apiKey: "MODEL-SECRET-MARKER" };
    const registry = {
      apiKey: marker,
      find: () => model,
      async getApiKeyAndHeaders() {
        return {
          ok: true,
          apiKey: this.apiKey,
          headers: { Authorization: header },
          env: { TOKEN: env },
        };
      },
    };
    let calls = 0;
    const output: string[] = [];
    let tick = 0;
    await executeEval(
      ["--cases", casesPath, "--output", outputPath, "--model", "fake/test"],
      {
        model,
        modelRegistry: registry,
        client: async (_model, _context, options) => {
          assert.equal(options.apiKey, marker);
          if (++calls === 2) throw new Error(`provider failure ${marker} ${header} ${env}`);
          return { content: calls === 4 ? '{"outcome":"deny"}' : '{"outcome":"allow"}' };
        },
      },
      { now: () => new Date("2026-01-02T03:04:05Z"), clock: () => tick++ * 10, print: (s) => output.push(s) },
    );
    const raw = readFileSync(outputPath, "utf8");
    for (const secret of [marker, header, env, "MODEL-SECRET-MARKER", "source-secret"]) {
      assert.ok(!raw.includes(secret));
      assert.ok(!output.join("\n").includes(secret));
    }
    const artifact = JSON.parse(raw) as {
      metadata: Record<string, unknown>;
      results: Array<{ caseId: string; rawResponseText?: string; failure?: string }>;
      summary: { falseAllows: string[]; failures: string[]; latencyMs: { median: number; p90: number } };
    };
    assert.deepEqual(
      artifact.results.map((r) => r.caseId),
      ["false-allow", "failure", "correct", "false-deny"],
    );
    assert.equal(artifact.results[0]?.rawResponseText, '{"outcome":"allow"}');
    assert.match(artifact.results[1]?.failure ?? "", /provider failure \[REDACTED\]/);
    assert.deepEqual(artifact.summary.falseAllows, ["false-allow"]);
    assert.deepEqual(artifact.summary.failures, ["failure"]);
    assert.deepEqual(artifact.summary.latencyMs, { median: 10, p90: 10 });
    assert.equal(artifact.metadata.datasetSha256, createHash("sha256").update(data).digest("hex"));
    assert.equal(
      artifact.metadata.systemPromptSha256,
      createHash("sha256").update(buildSystemPrompt(DEFAULT_CONFIG)).digest("hex"),
    );
    assert.deepEqual(artifact.metadata.sourceRevisions, ["rev123"]);
    assert.equal(
      artifact.metadata.codeRevision,
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
    assert.equal(typeof artifact.metadata.treeDirty, "boolean");
    assert.equal(artifact.metadata.model, "fake/test");
    assert.equal(artifact.metadata.temperature, 0);
    assert.equal(artifact.metadata.timeoutSeconds, DEFAULT_CONFIG.classifierTimeoutSeconds);
    assert.equal(artifact.metadata.timestamp, "2026-01-02T03:04:05.000Z");
    assert.deepEqual(artifact.metadata.inferenceSettings, { temperature: 0, timeoutSeconds: 25 });
    assert.match(output[0] ?? "", /raw false allows 1 \[false-allow\]; final false allows 1 \[false-allow\]/);
    assert.match(output[0] ?? "", /false denies 1 \[false-deny\]/);
    assert.match(output[0] ?? "", /failures 1 \[failure\]/);
    assert.match(output[0] ?? "", /Source configuration:[\s\S]*fixture:[\s\S]*Tags:[\s\S]*risk:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
