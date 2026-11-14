import assert from "node:assert/strict";
import { test } from "node:test";
import { toRecord } from "../../src/common.js";
import { requestHumanApproval } from "../../src/human-approval.js";
import { createReviewSubject } from "../../src/tool-routing.js";
import { evaluateToolCall } from "../../src/omp-host.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import type { ReviewSubject } from "../../src/types.js";
import { config, ctx, required } from "./helpers.js";

async function approvalPrompt(
  subject: ReviewSubject,
  options: Partial<Parameters<typeof requestHumanApproval>[2]> = {},
): Promise<string> {
  let prompt = "";
  const result = await requestHumanApproval(
    ctx({
      hasUI: true,
      ui: {
        select: async (title) => {
          prompt = title;
          return "Reject";
        },
      },
    }),
    subject,
    { timeoutSeconds: 30, ...options },
  );
  assert.deepEqual(result, { approved: false, state: "reject" });
  return prompt;
}

function field(prompt: string, label: string): string {
  const line = required(
    prompt.split("\n").find((line) => line.startsWith(`${label}: `)),
    label,
  );
  return line.slice(label.length + 2);
}

function assertSafePrompt(prompt: string): void {
  // Only the dialog's own line breaks may remain as controls.
  assert.doesNotMatch(prompt.replaceAll("\n", ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
}

await test("approval filenames expose terminal, Unicode and whitespace controls instead of executing them", async () => {
  const controls =
    Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") +
    Array.from({ length: 33 }, (_, code) => String.fromCharCode(0x7f + code)).join("");
  const path = `résumé/文件-😀${controls}\u2028\u2029\u202e\u2066\u200b\u{e0001}\\u001b".txt`;
  const subject = createReviewSubject("read", { path }, "/tmp/workspace");
  const prompt = await approvalPrompt(subject);
  assertSafePrompt(prompt);
  const action = field(prompt, "Action");
  assert.ok(action.startsWith('"résumé/文件-😀'));
  for (const escaped of [
    "\\u0000",
    "\\t",
    "\\n",
    "\\r",
    "\\u001b",
    "\\u007f",
    "\\u0085",
    "\\u009b",
    "\\u2028",
    "\\u2029",
    "\\u202e",
    "\\u2066",
    "\\u200b",
    "\\u{e0001}",
    "\\\\u001b",
    '\\"',
  ]) {
    assert.ok(action.includes(escaped), `missing visible ${escaped}`);
  }
  assert.ok(!action.includes("[truncated]"));
});

await test("approval commands retain visible command boundaries and literal escape distinctions", async () => {
  const command = 'printf "before"\nlogger\t"after"\r\u001b[2J';
  const prompt = await approvalPrompt(createReviewSubject("bash", { command }, "/tmp/workspace"));
  assertSafePrompt(prompt);
  assert.equal(field(prompt, "Action"), JSON.stringify(command));
  const literal = await approvalPrompt(
    createReviewSubject("bash", { command: String.raw`printf "before"\nlogger\t"after"\r\u001b[2J` }, "/tmp/workspace"),
  );
  assert.notEqual(field(literal, "Action"), field(prompt, "Action"));
});

await test("every supplied approval field is quoted and cannot inject prompt lines or terminal links", async () => {
  const attack = 'evil"\nTool: safe\r\u001b]8;;https://evil.test\u0007link\u009c\u202e';
  const prompt = await approvalPrompt(createReviewSubject(attack, { argument: attack }, "/tmp/workspace"), {
    title: attack,
    failureReason: attack,
    classifierDecision: { outcome: "deny", risk_level: "high", user_authorization: "low", rationale: attack },
    rule: { id: attack, source: attack, why: attack, outcome: "ask", prefix: null, match: [], patterns: [] },
  });
  assertSafePrompt(prompt);
  assert.ok(prompt.startsWith('"evil\\"\\nTool: safe\\r\\u001b]8;'));
  for (const label of ["Tool", "Rule", "Why", "Failure", "Reason"]) {
    assert.ok(field(prompt, label).includes('"evil\\"\\nTool: safe\\r\\u001b]8;'), label);
  }
  // The fallback JSON arguments also contain Unicode format controls, which
  // JSON.stringify alone does not escape.
  assert.ok(field(prompt, "Action").includes("\\u202e"));
  assert.equal(prompt.split("\n").filter((line) => line.startsWith("Tool: ")).length, 1);
});

await test("oversized approval fields truncate visibly without breaking quotes, escapes or code points", async () => {
  const oversized = '"\\\n😀\u001b'.repeat(2000);
  const subject = createReviewSubject(oversized, { command: oversized }, "/tmp/workspace");
  const before = structuredClone(subject);
  const prompt = await approvalPrompt(subject, {
    title: oversized,
    failureReason: oversized,
    classifierDecision: { outcome: "deny", rationale: oversized },
    rule: { id: oversized, source: oversized, why: oversized, outcome: "ask", prefix: null, match: [], patterns: [] },
  });
  assertSafePrompt(prompt);
  for (const [value, limit] of [
    [required(prompt.split("\n")[0], "title"), 120],
    [field(prompt, "Tool"), 240],
    [field(prompt, "Action"), 512],
    [field(prompt, "Why"), 512],
    [field(prompt, "Failure"), 512],
    [field(prompt, "Reason"), 512],
  ] as const) {
    assert.ok(value.endsWith('" [truncated]'));
    assert.ok(value.length <= limit + '"" [truncated]'.length);
    const decoded: unknown = JSON.parse(value.slice(0, -" [truncated]".length));
    assert.ok(typeof decoded === "string");
    assert.doesNotMatch(decoded, /\p{Cs}/u);
  }
  assert.ok(field(prompt, "Rule").length < 800);
  assert.deepEqual(subject, before);
});

await test("display escaping leaves classifier arguments and exact-action approvals distinct", async () => {
  const path = 'release\n\u001b[2J\u202e".txt';
  const input = { path, content: "original bytes" };
  const original = structuredClone(input);
  const store = new SessionApprovalStore();
  let prompts = 0;
  const reviewed: unknown[] = [];
  const options = {
    classifierClient: async (_model: unknown, request: unknown) => {
      const messages: unknown = toRecord(request).messages;
      assert.ok(Array.isArray(messages));
      const content = toRecord(messages[0]).content;
      assert.ok(typeof content === "string");
      reviewed.push(JSON.parse(required(content.split("\n").at(-1), "pending action JSON")));
      return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"needs approval"}' }] };
    },
  };
  const context = ctx({
    hasUI: true,
    ui: {
      select: async (prompt) => {
        prompts += 1;
        assertSafePrompt(prompt);
        return "Allow Always This Exact Action";
      },
    },
  });
  const cfg = config({ reviewer: "ai", maxConsecutiveDenials: 1 });
  const run = (args: typeof input) =>
    evaluateToolCall({ toolName: "deploy", input: args }, context, cfg, store, options);
  assert.deepEqual(await run(input), {});
  assert.deepEqual(await run(input), {});
  assert.equal(prompts, 1);
  assert.deepEqual(input, original);
  assert.deepEqual(toRecord(reviewed[0]).input, original);
  // Literal escape text is a different destination, not an approval alias.
  const literal = { ...input, path: String.raw`release\n\u001b[2J\u202e".txt` };
  assert.deepEqual(await run(literal), {});
  assert.equal(prompts, 2);
  assert.equal(reviewed.length, 2);
  assert.deepEqual(toRecord(reviewed[1]).input, literal);
});
