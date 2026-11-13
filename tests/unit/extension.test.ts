import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompCallgateExtension, { SYSTEM_PROMPT_NOTE } from "../../index.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/extension-config.js";
import { canonicalContext, canonicalToolCall, canonicalTools, evaluateToolCall } from "../../src/omp-host.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import { reviewerStatePath } from "../../src/reviewer-state.js";
import { type ExtensionContextLike } from "../../src/types.js";
import { test } from "node:test";
import { required, config, ctx, classifierDenyOptions, KUBE_RULES } from "./helpers.js";

await test("the OMP boundary validates events, contexts, tools, session data and registry results", async () => {
  assert.deepEqual(canonicalToolCall({ tool: { name: "bash" }, arguments: { command: "pwd" } }), {
    toolName: "bash",
    input: { command: "pwd" },
  });
  assert.deepEqual(canonicalToolCall(null), { toolName: null, input: {} });
  assert.deepEqual(canonicalTools(null), []);
  assert.equal(canonicalContext(null), null);

  const hostCtx = canonicalContext({
    cwd: 42,
    hasUI: true,
    ui: { select: async () => 42, notify: "not a function" },
    sessionManager: { getBranch: () => null, getSessionId: () => null },
    modelRegistry: {
      getAvailable: async () => null,
      getApiKeyAndHeaders: async () => ({ ok: "yes", headers: { good: "value", bad: 7 } }),
    },
  });
  assert.ok(hostCtx);
  assert.equal(hostCtx.cwd, undefined);
  assert.equal(hostCtx.hasUI, true);
  assert.equal(await hostCtx.ui?.select?.("question", []), undefined);
  assert.equal(hostCtx.ui?.notify, undefined);
  assert.deepEqual(hostCtx.sessionManager?.getBranch?.(), []);
  assert.equal(hostCtx.sessionManager.getSessionId?.(), "");
  assert.deepEqual(await hostCtx.modelRegistry?.getAvailable?.(), []);
  assert.deepEqual(await hostCtx.modelRegistry?.getApiKeyAndHeaders?.({}), { ok: false, headers: { good: "value" } });

  // A custom component's factory gets OMP's TUI objects checked the same way.
  const seen: string[] = [];
  const tuiHost = {
    requestRender() {
      seen.push(this === tuiHost ? "render" : "render without its object");
    },
  };
  const customCtx = canonicalContext({
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => {
        factory(tuiHost, { fg: () => 42 }, { matches: "not a function" }, () => undefined);
        return Promise.resolve("picked");
      },
    },
  });
  const picked = await customCtx?.ui?.custom?.<string>((tui, theme, keybindings) => {
    tui.requestRender?.();
    seen.push(theme.fg?.("accent", "text") ?? "no fg");
    seen.push(keybindings.matches === undefined ? "no matches" : "matches");
    return {};
  });
  assert.equal(picked, "picked");
  assert.deepEqual(seen, ["render", "text", "no matches"]);
  // A key match counts by truthiness; only no answer falls back to the built-in keys.
  for (const [answer, expected] of [
    [{ action: "confirm" }, true],
    [0, false],
    [null, undefined],
    [undefined, undefined],
  ] as const) {
    const keysCtx = canonicalContext({
      ui: {
        custom: (factory: (...args: unknown[]) => unknown) => {
          factory({}, {}, { matches: () => answer }, () => undefined);
          return Promise.resolve(undefined);
        },
      },
    });
    await keysCtx?.ui?.custom?.((_tui, _theme, keybindings) => {
      assert.equal(keybindings.matches?.("\t", "tui.select.confirm"), expected, JSON.stringify(answer));
      return {};
    });
  }

  const missingName = await evaluateToolCall(
    null,
    hostCtx,
    config({ reviewer: "ai" }),
    new SessionApprovalStore(),
    classifierDenyOptions(),
  );
  assert.equal("block" in missingName && missingName.block, true);
  assert.match("reason" in missingName ? missingName.reason : "", /no tool name/);

  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  ompCallgateExtension({
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  });
  const invalidContext: unknown = await handlers.get("tool_call")?.(
    { toolName: "bash", input: { command: "pwd" } },
    null,
  );
  assert.deepEqual(invalidContext, {
    block: true,
    reason: "Tool call was blocked because OMP supplied an invalid extension context.",
  });

  const throwingContext = new Proxy(
    {},
    {
      get: () => {
        throw new Error("host context getter failed");
      },
    },
  );
  const failedContext: unknown = await handlers.get("tool_call")?.(
    { toolName: "bash", input: { command: "pwd" } },
    throwingContext,
  );
  assert.deepEqual(failedContext, {
    block: true,
    reason:
      "omp-callgate failed to decide this tool call: host context getter failed. Do not retry; report this error to the user.",
  });

  const throwingHandlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  ompCallgateExtension({
    on: (event, handler) => {
      throwingHandlers.set(event, handler);
    },
    getAllTools: () => {
      throw new Error("host tools unavailable");
    },
  });
  const failed: unknown = await throwingHandlers.get("tool_call")?.(
    { toolName: "bash", input: { command: "pwd" } },
    ctx(),
  );
  assert.deepEqual(failed, {
    block: true,
    reason:
      "omp-callgate failed to decide this tool call: host tools unavailable. Do not retry; report this error to the user.",
  });
});

await test("reviewer commands reach another live extension instance and never rewrite config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-shared-reviewer-"));
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  process.env.CALLGATE_CONFIG_PATH = join(dir, "config.jsonc");
  const install = () => {
    const events = new Map<string, (event: unknown, context: unknown) => unknown>();
    let command: ((args: unknown, context: unknown) => Promise<void> | void) | undefined;
    ompCallgateExtension({
      on: (event, handler) => {
        events.set(event, handler);
      },
      registerCommand: (_name, definition) => {
        command = definition.handler;
      },
    });
    return { events, command };
  };
  const first = install();
  const second = install();
  const commandCtx = ctx({ model: undefined, ui: { notify: () => {}, setStatus: () => {} } });
  const call = () =>
    second.events.get("tool_call")?.({ toolName: "bash", input: { command: "make deploy" } }, commandCtx);
  try {
    const configBefore = readFileSync(process.env.CALLGATE_CONFIG_PATH, "utf8");
    assert.deepEqual(await call(), {});
    await first.command?.("ai", commandCtx);
    const reviewed: unknown = await call();
    assert.equal(typeof reviewed === "object" && reviewed !== null && "block" in reviewed && reviewed.block, true);
    await first.command?.("off", commandCtx);
    assert.deepEqual(await call(), {});

    writeFileSync(reviewerStatePath(), "{ broken");
    utimesSync(reviewerStatePath(), 50, 50);
    const invalid: unknown = await call();
    assert.equal(typeof invalid === "object" && invalid !== null && "block" in invalid && invalid.block, true);
    await first.command?.("off", commandCtx);
    assert.deepEqual(await call(), {});
    assert.equal(readFileSync(process.env.CALLGATE_CONFIG_PATH, "utf8"), configBefore);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.CALLGATE_CONFIG_PATH;
    } else {
      process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("extension registers one slash command and rejects unknown subcommands", async () => {
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  const configPath = join(tmpdir(), `omp-callgate-${Date.now()}.jsonc`);
  process.env.CALLGATE_CONFIG_PATH = configPath;
  const commands: string[] = [];
  let handler: ((args: string, ctx: ExtensionContextLike) => Promise<void> | void) | undefined;
  ompCallgateExtension({
    on: () => {},
    registerCommand: (name, definition) => {
      commands.push(name);
      handler = definition.handler;
    },
  });
  assert.deepEqual(commands, ["callgate"]);
  const messages: string[] = [];
  await handler?.(
    "unknown",
    ctx({
      ui: {
        notify: (message) => {
          messages.push(message);
        },
      },
    }),
  );
  assert.deepEqual(messages, [
    'Unknown /callgate subcommand "unknown". Use status, ai, manual, off, model, rules, or explain.',
  ]);
  rmSync(configPath, { force: true });
  if (previousConfigPath === undefined) {
    delete process.env.CALLGATE_CONFIG_PATH;
  } else {
    process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
  }
});

await test("callgate command provides argument completions", async () => {
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  const configPath = join(tmpdir(), `omp-callgate-${Date.now()}.jsonc`);
  process.env.CALLGATE_CONFIG_PATH = configPath;
  let getArgumentCompletions: ((argumentPrefix: string) => unknown[] | null | Promise<unknown[] | null>) | undefined;
  let description = "";
  ompCallgateExtension({
    on: () => {},
    registerCommand: (_name, definition) => {
      description = definition.description;
      getArgumentCompletions = definition.getArgumentCompletions;
    },
  });
  const completions = await getArgumentCompletions?.("");
  assert.equal(description, "args: status | ai | manual | off | model | rules | explain");
  assert.deepEqual(
    (completions ?? []).map((item) => (item as { value: string }).value),
    ["status", "ai", "manual", "off", "model", "model current", "rules", "explain"],
  );
  rmSync(configPath, { force: true });
  if (previousConfigPath === undefined) {
    delete process.env.CALLGATE_CONFIG_PATH;
  } else {
    process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
  }
});

await test("/callgate rules answers through the command, also when the rules are broken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-rules-command-"));
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  const previousRulesPath = process.env.CALLGATE_RULES_PATH;
  process.env.CALLGATE_CONFIG_PATH = join(dir, "config.jsonc");
  process.env.CALLGATE_RULES_PATH = join(dir, "rules.jsonc");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ reviewer: "ai" }));
  // A user entry for a program that is installed, so that explain can fast-path it.
  writeFileSync(
    join(dir, "rules.jsonc"),
    KUBE_RULES.replace('"programs": {', '"programs": { "whoami": { "opensNoFiles": true, "operands": "none" },'),
  );
  let handler: ((args: string, ctx: ExtensionContextLike) => Promise<void> | void) | undefined;
  ompCallgateExtension({
    on: () => {},
    getAllTools: () => [],
    registerCommand: (_name, definition) => {
      handler = definition.handler;
    },
  });
  const messages: string[] = [];
  const commandCtx = ctx({
    cwd: dir,
    ui: {
      notify: (message) => {
        messages.push(message);
      },
      setStatus: () => {},
    },
  });
  const say = async (args: string) => {
    messages.length = 0;
    await required(handler, "/callgate handler")(args, commandCtx);
    return messages.join("\n");
  };
  try {
    assert.match(await say("rules"), /kube-delete-all: block/);
    assert.match(
      await say("rules program:git status"),
      /^program:git status \(default\)\n  options: any, except --output --ext-diff --no-index --open-files-in-pager\n  operands: git-operands$/,
    );
    assert.match(await say("rules kube-secrets"), /^kube-secrets: review/);
    assert.match(await say("rules nothing"), /No program or rule named "nothing"/);
    assert.match(
      await say("explain bash kubectl delete --all pods"),
      /route: blocked[\s\S]*rule: kube-delete-all \(block, .*rules\.jsonc\)/,
    );
    assert.match(
      await say("explain bash whoami"),
      /allowed by: program:whoami \(.*rules\.jsonc\)\nnote: entries from your rules files are not checked by the program oracle/,
    );
    assert.match(await say("explain bash git status"), /allowed by: program:git status \(default\)$/);
    writeFileSync(join(dir, "rules.jsonc"), "{ broken");
    for (const args of ["rules", "rules git"]) {
      assert.match(
        await say(args),
        /omp-callgate: the command rules could not be loaded, so every bash call is blocked until the file is fixed: .*rules\.jsonc:\d+:\d+: expected a key.*Fixing the file is enough; rules reload automatically\.$/,
        args,
      );
      assert.equal(messages.length, 1);
    }
  } finally {
    for (const [name, previous] of [
      ["CALLGATE_CONFIG_PATH", previousConfigPath],
      ["CALLGATE_RULES_PATH", previousRulesPath],
    ] as const) {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("callgate explain reports the route a tool call would take", async () => {
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  const configFile = join(tmpdir(), `omp-callgate-explain-${Date.now()}.jsonc`);
  process.env.CALLGATE_CONFIG_PATH = configFile;
  writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, reviewer: "ai" }));
  let handler: ((args: string, ctx: ExtensionContextLike) => Promise<void> | void) | undefined;
  ompCallgateExtension({
    on: () => {},
    getAllTools: () => [
      { name: "read", sourceInfo: { source: "builtin" } },
      { name: "deploy", sourceInfo: { source: "extension" } },
    ],
    registerCommand: (_name, definition) => {
      handler = definition.handler;
    },
  });
  const messages: string[] = [];
  const commandCtx = ctx({
    ui: {
      notify: (message) => {
        messages.push(message);
      },
      setStatus: () => {},
    },
  });
  try {
    const routeFor = async (args: string): Promise<string> => {
      messages.length = 0;
      await handler?.(`explain ${args}`, commandCtx);
      return messages.join("\n");
    };
    assert.match(
      await routeFor("read src/a.ts"),
      /tool: read \(builtin\)[\s\S]*route: allowed without review: read-only builtin tool/,
    );
    assert.match(await routeFor("read ~/.ssh/id_ed25519"), /route: classifier review; a denial goes to the agent/);
    assert.match(await routeFor('read {"path":".env"}'), /arguments: \{"path":".env"\}[\s\S]*route: classifier review/);
    assert.match(
      await routeFor("bash git status --short"),
      /arguments: \{"command":"git status --short"\}[\s\S]*route: allowed without review: every command is read-only by the command rules\nruns as: .*\nallowed by: program:git status \(default\)/,
    );
    assert.match(await routeFor("bash git push"), /route: classifier review/);
    assert.match(await routeFor("deploy {}"), /tool: deploy \(extension\)[\s\S]*route: classifier review/);
    assert.match(
      await routeFor("ls -la"),
      /note: no tool named "ls" in this session; explained as a bash command[\s\S]*tool: bash\n[\s\S]*arguments: \{"command":"ls -la"\}/,
    );
    assert.match(
      await routeFor("git status"),
      /arguments: \{"command":"git status"\}[\s\S]*route: allowed without review: every command is read-only by the command rules\nruns as: .*\nallowed by: program:git status \(default\)/,
    );
    assert.match(
      await routeFor("git status 2>&1 && git log -1"),
      /route: allowed without review[\s\S]*runs as: \/\S+\/git status 2>&1 && \/\S+\/git log -1/,
    );
    assert.match(await routeFor(`bash cd ${tmpdir()} && git status`), /route: classifier review/);
    assert.match(await routeFor("read {bad"), /not valid JSON/);
    writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, reviewer: "manual" }));
    assert.match(await routeFor("read ~/.ssh/id_ed25519"), /route: blocked: manual review needs an interactive UI/);
    writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, reviewer: "ai" }));
    const rulesPath = required(process.env.CALLGATE_RULES_PATH, "CALLGATE_RULES_PATH");
    writeFileSync(rulesPath, '{ "rules": [{ "id": "no-apply", "match": "terraform apply", "outcome": "block" }] }');
    try {
      assert.match(
        await routeFor("bash terraform apply -auto-approve"),
        /route: blocked: matches a block command rule and never runs\nrule: no-apply \(block, .*no-rules\.jsonc\)/,
      );
      assert.match(
        await routeFor("bash git push origin --force"),
        /route: blocked: [^\n]*\nrule: force-push \(block, default\)\nwhy: A force push rewrites history/,
      );
    } finally {
      rmSync(rulesPath, { force: true });
    }
    assert.match(await routeFor(""), /Usage: \/callgate explain/);
  } finally {
    rmSync(configFile, { force: true });
    if (previousConfigPath === undefined) {
      delete process.env.CALLGATE_CONFIG_PATH;
    } else {
      process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
    }
  }
});

await test("system prompt denial guidance is appended in every reviewer mode", async () => {
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  const configFile = join(tmpdir(), `omp-callgate-prompt-${Date.now()}.jsonc`);
  process.env.CALLGATE_CONFIG_PATH = configFile;
  try {
    for (const reviewer of ["ai", "manual", "off"] as const) {
      writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, reviewer }));
      const handlers = new Map<string, (event: unknown, context?: unknown) => unknown>();
      ompCallgateExtension({
        on: (event, handler) => {
          handlers.set(event, handler);
        },
      });
      const beforeAgentStart = handlers.get("before_agent_start");
      assert.ok(beforeAgentStart);
      const fromArray = await beforeAgentStart({ type: "before_agent_start", systemPrompt: ["base"] });
      const fromString = await beforeAgentStart({ type: "before_agent_start", systemPrompt: "base" });
      assert.deepEqual(fromArray, { systemPrompt: ["base", SYSTEM_PROMPT_NOTE] });
      assert.deepEqual(fromString, { systemPrompt: `base\n\n${SYSTEM_PROMPT_NOTE}` });
      assert.match(SYSTEM_PROMPT_NOTE, /do not retry it in another form/);
    }
  } finally {
    rmSync(configFile, { force: true });
    if (previousConfigPath === undefined) {
      delete process.env.CALLGATE_CONFIG_PATH;
    } else {
      process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
    }
  }
});

await test("config notices and read warnings are reported once at session start, not on every tool call", async () => {
  const configFile = join(tmpdir(), `omp-callgate-keys-${Date.now()}.jsonc`);
  writeFileSync(
    configFile,
    JSON.stringify({ $schema: "./schemas/config.schema.json", safeCommandAllowList: ["make"], modes: "auto" }),
  );
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  process.env.CALLGATE_CONFIG_PATH = configFile;
  try {
    const loaded = loadConfig(configFile);
    assert.equal(loaded.warning, undefined);
    assert.match(loaded.notice ?? "", /unknown key\(s\) that are ignored: safeCommandAllowList, modes\./);
    const freshConfigFile = join(tmpdir(), `omp-callgate-fresh-${Date.now()}.jsonc`);
    try {
      assert.equal(loadConfig(freshConfigFile).notice, undefined);
    } finally {
      rmSync(freshConfigFile, { force: true });
    }

    const handlers = new Map<string, (event: unknown, context?: unknown) => unknown>();
    ompCallgateExtension({
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    });
    const notices: string[] = [];
    const sessionCtx = ctx({
      ui: {
        notify: (message) => {
          notices.push(message);
        },
        setStatus: () => {},
      },
    });
    await handlers.get("session_start")?.({}, sessionCtx);
    await handlers.get("tool_call")?.({ toolName: "read", input: { path: "a.ts" } }, sessionCtx);
    await handlers.get("tool_call")?.({ toolName: "read", input: { path: "b.ts" } }, sessionCtx);
    assert.equal(notices.filter((message) => message.includes("unknown key")).length, 1);

    writeFileSync(configFile, "{");
    const warningHandlers = new Map<string, (event: unknown, context: ExtensionContextLike) => unknown>();
    ompCallgateExtension({
      on: (event, handler) => {
        warningHandlers.set(event, handler);
      },
    });
    await warningHandlers.get("session_start")?.({}, sessionCtx);
    await warningHandlers.get("tool_call")?.({ toolName: "read", input: { path: "a.ts" } }, sessionCtx);
    await warningHandlers.get("tool_call")?.({ toolName: "read", input: { path: "b.ts" } }, sessionCtx);
    assert.equal(notices.filter((message) => message.includes("Failed to read omp-callgate config")).length, 1);

    writeFileSync(configFile, JSON.stringify({ reviewer: "ai" }));
    await warningHandlers.get("tool_call")?.({ toolName: "read", input: { path: "a.ts" } }, sessionCtx);
    assert.deepEqual(await warningHandlers.get("before_agent_start")?.({ systemPrompt: ["base"] }, sessionCtx), {
      systemPrompt: ["base", SYSTEM_PROMPT_NOTE],
    });
    assert.equal(notices.filter((message) => message.includes("Failed to read omp-callgate config")).length, 1);
  } finally {
    rmSync(configFile, { force: true });
    if (previousConfigPath === undefined) {
      delete process.env.CALLGATE_CONFIG_PATH;
    } else {
      process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
    }
  }
});

await test("audit logging does not throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-test-"));
  const previousLogsDir = process.env.CALLGATE_LOGS_DIR;
  process.env.CALLGATE_LOGS_DIR = dir;
  await evaluateToolCall(
    { toolName: "bash", input: { command: "git status" } },
    ctx(),
    config({ audit: true }),
    new SessionApprovalStore(),
  );
  rmSync(dir, { recursive: true, force: true });
  process.env.CALLGATE_LOGS_DIR = previousLogsDir;
});
