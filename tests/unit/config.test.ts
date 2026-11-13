import { group, itemAt } from "../../src/common.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  DEFAULT_CONFIG,
  extensionRoot,
  loadConfig,
  logsDir,
  normalizeConfig,
  saveConfig,
} from "../../src/extension-config.js";
import { loadReviewerState, saveReviewerState } from "../../src/reviewer-state.js";
import { test } from "node:test";
import { config } from "./helpers.js";

await test("itemAt and group return what is there and throw on anything else", () => {
  assert.equal(itemAt(["a", "b"], 1), "b");
  assert.equal(itemAt([undefined, "b"], 0), undefined);
  for (const index of [-1, 2, 0.5, Number.NaN]) {
    assert.throws(() => itemAt(["a", "b"], index), /internal error: index .* is outside a list of 2/, String(index));
  }
  const match = /^(a)(x)?$/.exec("a");
  assert.ok(match);
  assert.equal(group(match, 1), "a");
  const long = `a${"b".repeat(100)}`;
  const longMatch = /^(a)(x)?/.exec(long);
  assert.ok(longMatch);
  assert.throws(
    () => group(longMatch, 2),
    (error: unknown) => error instanceof Error && error.message.length < 120 && !error.message.includes("b".repeat(50)),
  );
});

await test("normalizeConfig defaults to off and reads reviewer as the starting value", () => {
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
  assert.equal(normalizeConfig({ reviewer: "ai" }).reviewer, "ai");
  assert.equal(normalizeConfig({ reviewer: "manual" }).reviewer, "manual");
  assert.equal(normalizeConfig({ reviewer: "bad", enabled: true, mode: "auto" }).reviewer, "off");
  const legacyDir = mkdtempSync(join(tmpdir(), "omp-callgate-legacy-config-"));
  const legacyPath = join(legacyDir, "config.jsonc");
  try {
    writeFileSync(legacyPath, JSON.stringify({ enabled: true, mode: "auto" }));
    const legacy = loadConfig(legacyPath);
    assert.equal(legacy.config.reviewer, "off");
    assert.match(legacy.notice ?? "", /enabled is no longer read/);
    assert.match(legacy.notice ?? "", /mode is no longer read/);
    for (const notAnObject of ["null", "[]", "5", '"ai"']) {
      writeFileSync(legacyPath, notAnObject);
      const loaded = loadConfig(legacyPath);
      assert.deepEqual(loaded.config, DEFAULT_CONFIG, notAnObject);
      assert.match(loaded.warning ?? "", /expected an object of settings; using defaults/, notAnObject);
    }
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

await test("reviewer state uses config only when missing, reloads on mtime, and fails closed as manual", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-reviewer-state-"));
  const path = join(dir, "reviewer-state.json");
  const cfg = config({ reviewer: "manual" });
  try {
    const missing = loadReviewerState(cfg, false, undefined, path);
    assert.equal(missing.reviewer, "off");
    assert.equal(missing.source, "default");
    const fromConfig = loadReviewerState(cfg, true, undefined, path);
    assert.equal(fromConfig.reviewer, "manual");
    assert.equal(fromConfig.source, "config.jsonc");

    assert.deepEqual(saveReviewerState("ai", path), { success: true });
    const ai = loadReviewerState(cfg, true, undefined, path);
    assert.equal(ai.reviewer, "ai");
    assert.equal(ai.source, "state file");

    assert.deepEqual(saveReviewerState("off", path), { success: true });
    utimesSync(path, 10, 10);
    const off = loadReviewerState(cfg, true, ai, path);
    assert.equal(off.reviewer, "off");

    writeFileSync(path, "{ broken");
    utimesSync(path, 20, 20);
    const invalid = loadReviewerState(cfg, true, off, path);
    assert.equal(invalid.reviewer, "manual");
    assert.equal(invalid.source, "invalid state file");
    assert.match(invalid.problem ?? "", /using manual/);

    assert.deepEqual(saveReviewerState("ai", path), { success: true });
    utimesSync(path, 30, 30);
    const recovered = loadReviewerState(cfg, true, invalid, path);
    assert.equal(recovered.reviewer, "ai");
    assert.equal(recovered.problem, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("config paths come from CALLGATE env vars, else the extension directory", () => {
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  const previousLogsDir = process.env.CALLGATE_LOGS_DIR;
  try {
    delete process.env.CALLGATE_CONFIG_PATH;
    delete process.env.CALLGATE_LOGS_DIR;
    assert.equal(configPath(), join(extensionRoot(), "config.jsonc"));
    assert.equal(logsDir(), join(extensionRoot(), "logs"));

    process.env.CALLGATE_CONFIG_PATH = "/tmp/callgate-config.jsonc";
    process.env.CALLGATE_LOGS_DIR = "/tmp/callgate-logs";
    assert.equal(configPath(), "/tmp/callgate-config.jsonc");
    assert.equal(logsDir(), "/tmp/callgate-logs");
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.CALLGATE_CONFIG_PATH;
    } else {
      process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
    }
    if (previousLogsDir === undefined) {
      delete process.env.CALLGATE_LOGS_DIR;
    } else {
      process.env.CALLGATE_LOGS_DIR = previousLogsDir;
    }
  }
});

await test("config saves only non-default values", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-config-"));
  const file = join(dir, "config.jsonc");
  try {
    const created = loadConfig(file);
    assert.equal(created.created, true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
    assert.equal(created.config.classifierTimeoutSeconds, 25);

    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, readRoots: undefined, allow: undefined }));
    const full = loadConfig(file);
    assert.equal(full.notice, undefined);

    saveConfig({ ...full.config, reviewer: "ai", readRoots: ["/nix/store"] }, file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { reviewer: "ai", readRoots: ["/nix/store"] });

    writeFileSync(file, JSON.stringify({ classifierTimeoutSeconds: 45 }));
    const slow = loadConfig(file);
    assert.equal(slow.config.classifierTimeoutSeconds, 45);
    assert.match(slow.notice ?? "", /extensionHandlers\.toolCallTimeoutMs \(30s by default\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("safeCommandAllowlist and blockCommands are no longer read, and say so", () => {
  for (const [raw, expected] of [
    [
      { safeCommandAllowlist: ["rg"] },
      "safeCommandAllowlist is no longer read and its 1 entry is ignored: write them as allow rules in rules.jsonc",
    ],
    [
      { blockCommands: ["git push --force", "x"] },
      "blockCommands is no longer read and its 2 entries are ignored: write them as block rules in rules.jsonc",
    ],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "omp-callgate-moved-"));
    try {
      writeFileSync(join(dir, "config.jsonc"), JSON.stringify(raw));
      const loaded = loadConfig(join(dir, "config.jsonc"));
      assert.ok((loaded.notice ?? "").includes(expected), loaded.notice);
      assert.ok(!(loaded.notice ?? "").includes("unknown key"), loaded.notice);
      assert.equal("safeCommandAllowlist" in loaded.config || "blockCommands" in loaded.config, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-moved-"));
  try {
    writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ safeCommandAllowlist: [], blockCommands: [] }));
    assert.equal(loadConfig(join(dir, "config.jsonc")).notice, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
