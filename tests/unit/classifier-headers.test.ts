import assert from "node:assert/strict";
import { classifyAction } from "../../src/classifier.js";
import type { ClearanceConfig, ExtensionContextLike } from "../../src/types.js";
import { test } from "node:test";

const config: ClearanceConfig = {
  reviewer: "ai",
  classifierModel: "openrouter/some-model",
  approvalTimeoutSeconds: 30,
  classifierTimeoutSeconds: 30,
  maxConsecutiveDenials: 3,
  readRoots: [],
  reviewExemptTools: [],
  allow: [],
  deny: [],
  environment: "",
  audit: false,
};

const subject = {
  toolName: "bash",
  input: { command: "pwd" },
  cwd: "/tmp",
  actionSummary: "bash: pwd",
  actionHash: "x",
};

function ctx(headers?: Record<string, string>): ExtensionContextLike {
  return {
    cwd: "/tmp",
    hasUI: false,
    model: { provider: "current", id: "current" },
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      find: (provider, id) => ({
        id,
        api: "openai-completions",
        provider,
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "openrouter-key",
        ...(headers ? { headers } : {}),
      }),
    },
  };
}

await test("classifier requests carry only the model registry's headers", async () => {
  // The classifier request carries only the headers the model registry gives,
  // whatever the provider: no attribution headers of its own.
  let capturedOptions: Record<string, unknown> | undefined;
  const decision = await classifyAction(ctx(), config, subject, async (_model, _context, options) => {
    capturedOptions = options;
    return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
  });
  assert.equal(decision.outcome, "allow");
  assert.equal(Object.hasOwn(capturedOptions ?? {}, "headers"), false);

  await classifyAction(ctx({ "X-Custom": "registry" }), config, subject, async (_model, _context, options) => {
    capturedOptions = options;
    return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
  });
  assert.deepEqual(capturedOptions?.headers, { "X-Custom": "registry" });
});
