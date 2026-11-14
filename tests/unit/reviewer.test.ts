import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompCallgateExtension from "../../index.js";
import { logPath } from "../../src/extension-config.js";
import { evaluateToolCall, type ToolCallDecision } from "../../src/omp-host.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import { test } from "node:test";
import { required, config, ctx, staticRoute, CLASSIFIER_DENY_REASON, classifierDenyOptions } from "./helpers.js";

await test("off runs review without a classifier but still enforces block and ask", async () => {
  let classifierCalled = false;
  const classifierClient = async () => {
    classifierCalled = true;
    throw new Error("off must not call the classifier");
  };
  const store = new SessionApprovalStore();
  assert.deepEqual(
    await evaluateToolCall(
      { toolName: "bash", input: { command: "make build" } },
      ctx(),
      config({ reviewer: "off" }),
      store,
      { classifierClient },
    ),
    {},
  );
  assert.equal(
    "block" in
      (await evaluateToolCall(
        { toolName: "bash", input: { command: "git push --force origin main" } },
        ctx(),
        config({ reviewer: "off" }),
        store,
        { classifierClient },
      )),
    true,
  );
  assert.equal(
    "block" in
      (await evaluateToolCall(
        { toolName: "bash", input: { command: "sudo -n true" } },
        ctx(),
        config({ reviewer: "off" }),
        store,
        { classifierClient },
      )),
    true,
  );
  assert.equal(classifierCalled, false);
});

await test("switching reviewer off preserves the consecutive denial count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-off-counter-"));
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  process.env.CALLGATE_CONFIG_PATH = join(dir, "config.jsonc");
  writeFileSync(process.env.CALLGATE_CONFIG_PATH, JSON.stringify({ reviewer: "ai", maxConsecutiveDenials: 2 }));
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
  let aborts = 0;
  const context = ctx({
    abort: () => {
      aborts += 1;
    },
    ui: { notify: () => {}, setStatus: () => {} },
  });
  const call = (commandText: string) =>
    events.get("tool_call")?.({ toolName: "bash", input: { command: commandText } }, context);
  try {
    await call("git push --force origin main");
    await command?.("off", context);
    const second: unknown = await call("git push -f origin main");
    assert.equal(aborts, 1);
    assert.match(
      typeof second === "object" && second !== null && "reason" in second ? String(second.reason) : "",
      /rejected 2 actions in a row and stopped the turn/,
    );
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.CALLGATE_CONFIG_PATH;
    } else {
      process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("ai denies to the agent first, then asks at the threshold with the classifier reason", async () => {
  const store = new SessionApprovalStore();
  let prompt = "";
  const ui = {
    select: async (title: string) => {
      prompt = title;
      return "Allow Always This Exact Action";
    },
  };
  const cfg = config({ reviewer: "ai", maxConsecutiveDenials: 2 });
  const first = await evaluateToolCall(
    { toolName: "bash", input: { command: "make first" } },
    ctx({ hasUI: true, ui }),
    cfg,
    store,
    classifierDenyOptions(),
  );
  assert.equal("block" in first && first.block, true);
  assert.equal(prompt, "");

  const second = await evaluateToolCall(
    { toolName: "bash", input: { command: "make second" } },
    ctx({ hasUI: true, ui }),
    cfg,
    store,
    classifierDenyOptions(),
  );
  assert.deepEqual(second, {});
  assert.ok(prompt.includes(JSON.stringify("needs review")));

  const exact = await evaluateToolCall({ toolName: "bash", input: { command: "make second" } }, ctx(), cfg, store, {
    classifierClient: async () => {
      throw new Error("exact approval should not call the classifier");
    },
  });
  assert.deepEqual(exact, {});

  // The approval is for that exact text: other whitespace can be another command.
  let reviewed = false;
  await evaluateToolCall({ toolName: "bash", input: { command: "make second\nmake third" } }, ctx(), cfg, store, {
    classifierClient: async () => {
      reviewed = true;
      return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"x"}' }] };
    },
  });
  assert.equal(reviewed, true);
});

await test("exact session approval audits do not repeat an earlier classifier denial", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-exact-audit-"));
  const previousLogsDir = process.env.CALLGATE_LOGS_DIR;
  process.env.CALLGATE_LOGS_DIR = dir;
  const store = new SessionApprovalStore();
  const event = { toolName: "bash", input: { command: "make deploy" } };
  try {
    await evaluateToolCall(
      event,
      ctx({ hasUI: true, ui: { select: async () => "Allow Always This Exact Action" } }),
      config({ reviewer: "ai", maxConsecutiveDenials: 1, audit: true }),
      store,
      classifierDenyOptions(),
    );
    await evaluateToolCall(event, ctx(), config({ reviewer: "ai", audit: true }), store, classifierDenyOptions());
    const entries = readFileSync(logPath(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.route, "human");
    assert.equal(entries[1]?.route, "session_approval");
    assert.equal(entries[1].classifierDecision, undefined);
  } finally {
    if (previousLogsDir === undefined) {
      delete process.env.CALLGATE_LOGS_DIR;
    } else {
      process.env.CALLGATE_LOGS_DIR = previousLogsDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("manual review does not reuse an ai cache verdict", async () => {
  const store = new SessionApprovalStore();
  let classifierCalls = 0;
  const client = async () => {
    classifierCalls += 1;
    return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
  };
  const event = { toolName: "bash", input: { command: "make deploy" } };
  assert.deepEqual(
    await evaluateToolCall(event, ctx(), config({ reviewer: "ai" }), store, { classifierClient: client }),
    {},
  );
  let prompted = false;
  const manual = await evaluateToolCall(
    event,
    ctx({
      hasUI: true,
      ui: {
        select: async () => {
          prompted = true;
          return "Allow Once";
        },
      },
    }),
    config({ reviewer: "manual" }),
    store,
    { classifierClient: client },
  );
  assert.deepEqual(manual, {});
  assert.equal(prompted, true);
  assert.equal(classifierCalls, 1);
});

await test("a classifier verdict cannot be discarded by a later static re-plan", async () => {
  const input: { command: string; pty?: boolean } = { command: "git status", pty: true };
  assert.equal(staticRoute("bash", input, { cwd: "/tmp/workspace", config: config(), tools: [], hasUI: false }), null);
  const result = await evaluateToolCall(
    { toolName: "bash", input },
    ctx(),
    config({ reviewer: "ai" }),
    new SessionApprovalStore(),
    {
      classifierClient: async () => {
        delete input.pty;
        return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"needs review"}' }] };
      },
    },
  );
  assert.deepEqual(result, { block: true, reason: CLASSIFIER_DENY_REASON });
});

await test("the classifier and its cache see the command exactly as bash will run it", async () => {
  const store = new SessionApprovalStore();
  const seen: string[] = [];
  let verdict = "allow";
  const client = async (_model: unknown, request: unknown) => {
    seen.push(JSON.stringify(request));
    return { content: [{ type: "text", text: `{"outcome":"${verdict}","rationale":"x"}` }] };
  };
  const run = (command: string) =>
    evaluateToolCall({ toolName: "bash", input: { command } }, ctx(), config({ reviewer: "ai" }), store, {
      classifierClient: client,
    });
  // A harmless-looking one-liner is allowed and cached...
  assert.deepEqual(await run("logger checking rm -rf demo-target"), {});
  // ...and the same words split by a newline, which run `rm`, are reviewed again.
  verdict = "deny";
  assert.equal("block" in (await run("logger checking\nrm -rf demo-target")), true);
  assert.equal(seen.length, 2);
  // The reviewer saw the newline (escaped once per JSON layer), not a space.
  const reviewed = required(seen[1], "second reviewed action");
  assert.match(reviewed, /logger checking\\+nrm -rf demo-target/);
  assert.ok(!reviewed.includes("logger checking rm"));
});

await test("an approved command that may hook the shell turns the bash fast path off for the session", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-callgate-latch-"));
  const store = new SessionApprovalStore();
  const notices: string[] = [];
  let classifierCalls = 0;
  const allow = async () => {
    classifierCalls += 1;
    return { content: [{ type: "text", text: '{"outcome":"allow","rationale":"ok"}' }] };
  };
  let session = "s1";
  const sessionCtx = () =>
    ctx({
      cwd: workspace,
      ui: {
        notify: (message) => {
          notices.push(message);
        },
      },
      sessionManager: { getBranch: () => [], getSessionId: () => session },
    });
  const run = (command: string, cfg = config({ reviewer: "ai" })) =>
    evaluateToolCall({ toolName: "bash", input: { command } }, sessionCtx(), cfg, store, { classifierClient: allow });
  try {
    assert.deepEqual(await run("git status"), {});
    assert.equal(classifierCalls, 0);
    // A fast-pathed command never latches, whatever its words.
    assert.deepEqual(await run("git log --grep=PS4"), {});
    assert.equal(store.shellLatch(session), null);

    assert.deepEqual(await run("trap 'echo hi' DEBUG"), {});
    assert.equal(store.shellLatch(session), "`trap`");
    assert.match(notices.join("\n"), /used `trap`.*reviewed for the rest of this session/);
    const before = classifierCalls;
    assert.deepEqual(await run("git status"), {});
    assert.equal(classifierCalls, before + 1);

    // /callgate off clears approvals but not the shell's latch; another session has its own.
    store.clear();
    assert.equal(store.shellLatch("s1"), "`trap`");
    session = "s2";
    assert.equal(store.shellLatch(session), null);
    assert.deepEqual(await run("git status"), {});
    assert.equal(classifierCalls, before + 1);

    // Commands run while the extension is off count too.
    assert.deepEqual(await run("source missing.sh", config({ reviewer: "off" })), {});
    assert.equal(store.shellLatch(session), "`source` of a file that could not be read");
    assert.match(notices.at(-1) ?? "", /Safe-command fast paths are off for the rest of this session/);

    // While a hooking command waits for review, other calls are already reviewed.
    session = "s4";
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = evaluateToolCall(
      { toolName: "bash", input: { command: "trap x DEBUG" } },
      sessionCtx(),
      config({ reviewer: "ai" }),
      store,
      {
        classifierClient: async () => {
          await slow;
          return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"no"}' }] };
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const callsBefore = classifierCalls;
    assert.deepEqual(await run("git status"), {});
    assert.equal(classifierCalls, callsBefore + 1);
    release();
    assert.equal("block" in (await pending), true);
    // Denied, so it never ran: the latch is undone.
    assert.equal(store.shellLatch(session), null);

    // A blocked command never ran, so it latches nothing.
    session = "s3";
    await evaluateToolCall(
      { toolName: "bash", input: { command: "trap x DEBUG" } },
      sessionCtx(),
      config({ reviewer: "ai" }),
      store,
      classifierDenyOptions(),
    );
    assert.equal(store.shellLatch(session), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("ai reviewer stops the turn after maxConsecutiveDenials automatic denials", async () => {
  const store = new SessionApprovalStore();
  let aborts = 0;
  const reasons: string[] = [];
  for (const command of ["make a", "make b", "make c", "make d"]) {
    const result = await evaluateToolCall(
      { toolName: "bash", input: { command } },
      ctx({
        abort: () => {
          aborts += 1;
        },
      }),
      config({ reviewer: "ai", maxConsecutiveDenials: 3 }),
      store,
      classifierDenyOptions(),
    );
    reasons.push((result as { reason: string }).reason);
  }
  assert.equal(aborts, 1);
  assert.equal(reasons[1], CLASSIFIER_DENY_REASON);
  assert.match(required(reasons[2], "third reason"), /rejected 3 actions in a row and stopped the turn/);
  assert.equal(reasons[3], CLASSIFIER_DENY_REASON);

  const withoutAbort = new SessionApprovalStore();
  let last = "";
  for (const command of ["make a", "make b"]) {
    last = (
      (await evaluateToolCall(
        { toolName: "bash", input: { command } },
        ctx(),
        config({ reviewer: "ai", maxConsecutiveDenials: 2 }),
        withoutAbort,
        classifierDenyOptions(),
      )) as { reason: string }
    ).reason;
  }
  assert.match(last, /rejected 2 actions in a row; stop and ask the user for guidance/);
});

await test("readonly, safe, off, classifier, cache, human, and exact allows all reset the denial count", async () => {
  const store = new SessionApprovalStore();
  let aborts = 0;
  let classifierCalls = 0;
  const context = ctx({
    hasUI: true,
    abort: () => {
      aborts += 1;
    },
    ui: { select: async () => "Allow Always This Exact Action" },
  });
  const cfg = config({ reviewer: "ai", maxConsecutiveDenials: 2 });
  const deny = () =>
    evaluateToolCall({ toolName: "bash", input: { command: "git push --force origin main" } }, context, cfg, store);
  const allowClassifier = async () => {
    classifierCalls += 1;
    return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
  };

  await deny();
  assert.deepEqual(await evaluateToolCall({ toolName: "read", input: { path: "a.ts" } }, context, cfg, store), {});
  await deny();
  assert.deepEqual(
    await evaluateToolCall({ toolName: "bash", input: { command: "git status" } }, context, cfg, store),
    {},
  );
  await deny();
  assert.deepEqual(
    await evaluateToolCall(
      { toolName: "bash", input: { command: "make deploy" } },
      context,
      config({ reviewer: "off", maxConsecutiveDenials: 2 }),
      store,
    ),
    {},
  );
  await deny();
  assert.deepEqual(
    await evaluateToolCall({ toolName: "bash", input: { command: "make deploy" } }, context, cfg, store, {
      classifierClient: allowClassifier,
    }),
    {},
  );
  await deny();
  assert.deepEqual(
    await evaluateToolCall({ toolName: "bash", input: { command: "make deploy" } }, context, cfg, store, {
      classifierClient: allowClassifier,
    }),
    {},
  );
  await deny();
  assert.deepEqual(
    await evaluateToolCall(
      { toolName: "bash", input: { command: "make deploy" } },
      context,
      config({ reviewer: "manual", maxConsecutiveDenials: 2 }),
      store,
    ),
    {},
  );
  await deny();
  assert.deepEqual(
    await evaluateToolCall({ toolName: "bash", input: { command: "make deploy" } }, context, cfg, store),
    {},
  );
  await deny();
  assert.equal(aborts, 0);
  assert.equal(classifierCalls, 1);
});

await test("denial-threshold audits keep the base reason for block and unanswered ask", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-threshold-audit-"));
  const previousLogsDir = process.env.CALLGATE_LOGS_DIR;
  try {
    for (const testCase of [
      { route: "blocked_command", commands: ["make a", "make b"], blockRules: ["make"] },
      { route: "ask_rule", commands: ["git reset --hard HEAD~1", "git reset --hard HEAD~2"], blockRules: [] },
    ]) {
      process.env.CALLGATE_LOGS_DIR = join(root, testCase.route);
      const cfg = config({ reviewer: "ai", audit: true, maxConsecutiveDenials: 2, blockRules: testCase.blockRules });
      const store = new SessionApprovalStore();
      let second: ToolCallDecision = {};
      for (const command of testCase.commands) {
        second = await evaluateToolCall({ toolName: "bash", input: { command } }, ctx(), cfg, store, {
          rules: cfg.rules,
        });
      }
      assert.match("reason" in second ? second.reason : "", /rejected 2 actions in a row/);
      const entries = readFileSync(logPath(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(entries.length, 2);
      assert.equal(entries[1]?.route, testCase.route);
      assert.equal(entries[1].reason, entries[0]?.reason);
      assert.doesNotMatch(String(entries[1].reason), /rejected 2 actions in a row/);
    }
  } finally {
    if (previousLogsDir === undefined) {
      delete process.env.CALLGATE_LOGS_DIR;
    } else {
      process.env.CALLGATE_LOGS_DIR = previousLogsDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

await test("concurrent classifier denials return the committed threshold reason", async () => {
  const store = new SessionApprovalStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = async () => {
    await gate;
    return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"needs review"}' }] };
  };
  let aborts = 0;
  const context = ctx({
    abort: () => {
      aborts += 1;
    },
  });
  const first = evaluateToolCall(
    { toolName: "bash", input: { command: "make a" } },
    context,
    config({ reviewer: "ai", maxConsecutiveDenials: 2 }),
    store,
    { classifierClient: client },
  );
  const second = evaluateToolCall(
    { toolName: "bash", input: { command: "make b" } },
    context,
    config({ reviewer: "ai", maxConsecutiveDenials: 2 }),
    store,
    { classifierClient: client },
  );
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], { block: true, reason: CLASSIFIER_DENY_REASON });
  assert.match("reason" in results[1] ? results[1].reason : "", /rejected 2 actions in a row and stopped the turn/);
  assert.equal(aborts, 1);
});

await test("concurrent classifier denials recheck the committed count before skipping the threshold prompt", async () => {
  const store = new SessionApprovalStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = async () => {
    await gate;
    return { content: [{ type: "text", text: '{"outcome":"deny","rationale":"needs review"}' }] };
  };
  let prompts = 0;
  let aborts = 0;
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
  const cfg = config({ reviewer: "ai", maxConsecutiveDenials: 2 });
  const first = evaluateToolCall({ toolName: "bash", input: { command: "make a" } }, context, cfg, store, {
    classifierClient: client,
  });
  const second = evaluateToolCall({ toolName: "bash", input: { command: "make b" } }, context, cfg, store, {
    classifierClient: client,
  });
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => "block" in result).length, 1);
  assert.equal(results.filter((result) => !("block" in result)).length, 1);
  assert.equal(prompts, 1);
  assert.equal(aborts, 0);
});

await test("manual review offers Reject and Stop, which ends the turn", async () => {
  let aborts = 0;
  let offered: string[] = [];
  const result = await evaluateToolCall(
    { toolName: "bash", input: { command: "make deploy" } },
    ctx({
      hasUI: true,
      abort: () => {
        aborts += 1;
      },
      ui: {
        select: async (_title, options) => {
          offered = options;
          return "Reject and Stop the Turn";
        },
      },
    }),
    config({ reviewer: "manual" }),
    new SessionApprovalStore(),
    classifierDenyOptions(),
  );
  assert.ok(offered.includes("Reject and Stop the Turn"));
  assert.equal(aborts, 1);
  assert.deepEqual(result, {
    block: true,
    reason: "The user rejected this action and stopped the turn. Wait for the user's next message.",
  });

  await evaluateToolCall(
    { toolName: "bash", input: { command: "make deploy" } },
    ctx({
      hasUI: true,
      ui: {
        select: async (_title, options) => {
          offered = options;
          return "Reject";
        },
      },
    }),
    config({ reviewer: "manual" }),
    new SessionApprovalStore(),
    classifierDenyOptions(),
  );
  assert.ok(!offered.includes("Reject and Stop the Turn"));
});

await test("manual-only tools preserve their rejection reason", async () => {
  const result = await evaluateToolCall(
    { toolName: "computer", input: {} },
    ctx({
      hasUI: true,
      ui: {
        select: async () => "Reject",
      },
    }),
    config({ reviewer: "manual" }),
    new SessionApprovalStore(),
    {
      classifierClient: async () => {
        throw new Error("manual-only tools must not reach the classifier");
      },
    },
  );
  assert.deepEqual(result, {
    block: true,
    reason: "This tool requires explicit user interaction and cannot be auto-approved.",
  });
});

await test("human rejections count once toward consecutive denials", async () => {
  const store = new SessionApprovalStore();
  await evaluateToolCall(
    { toolName: "bash", input: { command: "make deploy" } },
    ctx({ hasUI: true, ui: { select: async () => "Reject" } }),
    config({ reviewer: "manual" }),
    store,
    classifierDenyOptions(),
  );
  assert.equal(store.recordDenial(), 2);
});

await test("plain human rejections count without stopping and advance the next ai prompt", async () => {
  const store = new SessionApprovalStore();
  let aborts = 0;
  let prompts = 0;
  let answer = "Reject";
  const context = ctx({
    hasUI: true,
    abort: () => {
      aborts += 1;
    },
    ui: {
      select: async () => {
        prompts += 1;
        return answer;
      },
    },
  });
  const cfg = config({ reviewer: "manual", maxConsecutiveDenials: 2 });
  await evaluateToolCall({ toolName: "bash", input: { command: "make first" } }, context, cfg, store);
  const second = await evaluateToolCall({ toolName: "bash", input: { command: "make second" } }, context, cfg, store);
  assert.equal(aborts, 0);
  assert.doesNotMatch("reason" in second ? second.reason : "", /rejected 2 actions in a row/);

  answer = "Allow Once";
  const third = await evaluateToolCall(
    { toolName: "bash", input: { command: "make third" } },
    context,
    config({ reviewer: "ai", maxConsecutiveDenials: 2 }),
    store,
    classifierDenyOptions(),
  );
  assert.deepEqual(third, {});
  assert.equal(prompts, 3);
  assert.equal(aborts, 0);
});

await test("timeout and unavailable human approval stop at the shared threshold", async () => {
  for (const unavailable of [false, true]) {
    const store = new SessionApprovalStore();
    let aborts = 0;
    const context = ctx({
      hasUI: !unavailable,
      abort: () => {
        aborts += 1;
      },
      ui: { select: async () => undefined },
    });
    const cfg = config({ reviewer: "manual", maxConsecutiveDenials: 2 });
    await evaluateToolCall({ toolName: "bash", input: { command: "make first" } }, context, cfg, store);
    const second = await evaluateToolCall({ toolName: "bash", input: { command: "make second" } }, context, cfg, store);
    assert.equal(aborts, 1, unavailable ? "unavailable" : "timeout");
    assert.match("reason" in second ? second.reason : "", /rejected 2 actions in a row and stopped the turn/);
  }
});
