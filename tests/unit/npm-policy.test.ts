import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultRules, escalateCommand, loadCommandRules } from "../../src/command-rules.js";
import { evaluateToolCall } from "../../src/omp-host.js";
import { planSafeCommand } from "../../src/safe-command.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import { config, ctx, required, TEST_PATH } from "./helpers.js";

const INSTALL_COMMANDS = `
  install i in ins inst insta instal isnt isnta isntal isntall add
  ci ic clean-install install-clean isntall-clean install-cl
  it install-test installTest cit si sit install-ci-test installCiTest cleanInstallTest
  up update upgrade ud udpate uninstall un unlink remove rem rm r
  rebuild reb rb dedupe ded dd ddp prune pru link lin ln shrinkwrap shr
`
  .trim()
  .split(/\s+/);
const EXEC_COMMANDS = `
  exec exe x init ini innit inn create cr
  run run-script runScript rum ur urn test tes t ts tst start stop sto restart res
  pack pa version vers verison veri edit ed explore explo build
  help help-search hlep hl docs home hom bugs b issues iss repo rep fund
`
  .trim()
  .split(/\s+/);

await test("npm dependency changes and code execution ask, including aliases and wrapped invocations", () => {
  const rules = defaultRules();
  assert.equal(rules.problem, null);
  const cases: [string, string][] = [
    ...INSTALL_COMMANDS.map((command): [string, string] => [`npm ${command}`, "npm-install"]),
    ...EXEC_COMMANDS.map((command): [string, string] => [`npm ${command}`, "npm-exec"]),
    ["npm install --ignore-scripts --offline --dry-run --package-lock-only", "npm-install"],
    ["npm --prefix /tmp/disposable install --ignore-scripts helper", "npm-install"],
    ["npm --global install helper", "npm-install"],
    ["npm audit fix --ignore-scripts", "npm-install"],
    ["npm aud fix", "npm-install"],
    ["npm installCi helper", "npm-install"],
    ["npm install-ciT helper", "npm-install"],
    ["npm cleanInstallT", "npm-install"],
    ["npm runS build", "npm-exec"],
    ["npm help-se", "npm-exec"],
    ["npm fun helper", "npm-exec"],
    ["npm config edit", "npm-exec"],
    ["npm c edit", "npm-exec"],
    ["npm con edit", "npm-exec"],
    ["npx --yes helper", "npm-exec"],
    ["npx --no-install helper", "npm-exec"],
    ["npx --version", "npm-exec"],
    ["/usr/bin/npm i helper", "npm-install"],
    ["env npm run build", "npm-exec"],
    ["cd repo && npm ci", "npm-install"],
    ["bash -lc 'npm exec helper'", "npm-exec"],
    ["for dir in a b; do npm --prefix $dir install; done", "npm-install"],
  ];
  for (const [command, id] of cases) {
    const result = required(escalateCommand(command, rules), command);
    assert.equal(result.outcome, "ask", command);
    assert.equal(result.rule.id, id, command);
    assert.equal(
      planSafeCommand(command, config(), { workspace: "/tmp/workspace", searchPath: TEST_PATH }),
      null,
      command,
    );
  }
  assert.equal(escalateCommand("git commit -m 'document npm install helper'", rules)?.outcome, "review");
  assert.equal(escalateCommand("printf '%s' 'npm run build'", rules)?.outcome, "review");
  assert.equal(escalateCommand("which npx", rules), null);
});

await test("exact npm version flags fast-path; unrelated informational calls and extra arguments stay reviewed", () => {
  for (const command of ["npm --version", "npm -v", "npm '--version' | cat"]) {
    const plan = required(
      planSafeCommand(command, config(), { workspace: "/tmp/workspace", searchPath: TEST_PATH }),
      command,
    );
    assert.match(plan.command, /^\//);
    assert.equal(escalateCommand(command, defaultRules()), null, command);
  }
  for (const command of [
    "npm",
    "npm ls",
    "npm list --json",
    "npm info helper",
    "npm info package",
    "npm info crypto",
    "npm info update-notifier",
    "npm view helper",
    "npm explain helper",
    "npm config get registry",
    "npm --help",
    "npm --versions",
    "npm --version --timing",
    "npm --version --userconfig=/tmp/config",
    "npm --version --logfile=/tmp/log",
    "npm --version=true",
    "npm --version=false",
    "npm --version --version",
    "npm -v --version",
    "npm -vv",
    "npm -- --version",
    "npm --version extra",
  ]) {
    assert.equal(escalateCommand(command, defaultRules()), null, command);
    assert.equal(
      planSafeCommand(command, config(), { workspace: "/tmp/workspace", searchPath: TEST_PATH }),
      null,
      command,
    );
  }
  for (const command of ["npm --version install helper", "npm --version run build"]) {
    assert.equal(escalateCommand(command, defaultRules())?.outcome, "ask", command);
    assert.equal(
      planSafeCommand(command, config(), { workspace: "/tmp/workspace", searchPath: TEST_PATH }),
      null,
      command,
    );
  }
});

await test("local npm queries pin a checked project, including from a subdirectory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "callgate-npm-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project with spaces");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "local-probe", version: "1.0.0" }));
  for (const command of [
    "npm prefix",
    "npm root",
    "npm pkg get",
    "npm pkg get name version",
    "npm pkg get version install",
    "npm pkg get version && npm pkg get install",
    "npm pkg get 'scripts.*'",
    "cd src && npm pkg get name",
    "timeout 5 npm root | cat",
  ]) {
    const plan = required(planSafeCommand(command, config(), { workspace, searchPath: TEST_PATH }), command);
    assert.match(plan.command, /^\//, command);
    assert.ok(plan.command.includes(`'--prefix=${workspace}'`), command);
    assert.equal(escalateCommand(command, defaultRules()), null, command);
  }
  for (const command of [
    "npm prefix -g",
    "npm root --global",
    "npm --prefix=.. pkg get name",
    "npm pkg get name --prefix=..",
    "npm pkg get name --workspace=..",
    "npm pkg get name --workspaces",
    "npm pkg get name --userconfig=../config",
    "npm pkg get name --cache=../cache",
    "npm pkg get name --timing",
    "npm pkg get -- name",
    "npm pkg get scripts.*",
    "npm pkg get $FIELD",
    "npm pkg set name=changed",
    "npm pkg delete name",
    "npm pkg fix",
    "npm pre",
    "npm roo",
  ]) {
    assert.equal(planSafeCommand(command, config(), { workspace, searchPath: TEST_PATH }), null, command);
  }
  for (const command of [
    "npm pkg get version && npm install helper",
    "npm pkg get install; npm run build",
    "npm pkg get name | npm version patch",
    "bash -lc 'npm pkg get version; npm install helper'",
  ]) {
    assert.equal(escalateCommand(command, defaultRules())?.outcome, "ask", command);
  }
  const own = config({ blockRules: ["npm version"] }).rules;
  assert.equal(escalateCommand("npm pkg get version", own)?.outcome, "block", "user rules retain precedence");
  const disabled = join(root, "rules.jsonc");
  writeFileSync(disabled, '{"disable":["program:npm"]}');
  assert.equal(
    planSafeCommand("npm root", config(), { workspace, searchPath: TEST_PATH, rules: loadCommandRules(disabled) }),
    null,
  );
});

await test("npm queries review escaping or credential-like manifests and ambiguous workspace discovery", (t) => {
  const root = mkdtempSync(join(tmpdir(), "callgate-npm-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const manifest = join(workspace, "package.json");
  const outside = join(root, "private.json");
  const secret = join(workspace, ".env");
  writeFileSync(outside, '{"name":"outside"}');
  writeFileSync(secret, '{"name":"secret"}');
  for (const target of [outside, secret, join(root, "missing.json")]) {
    symlinkSync(target, manifest);
    for (const command of ["npm prefix", "npm root", "npm pkg get name"]) {
      assert.equal(planSafeCommand(command, config(), { workspace, searchPath: TEST_PATH }), null, target);
    }
    rmSync(manifest);
  }
  writeFileSync(manifest, '{"name":"local"}');
  writeFileSync(join(root, "package.json"), '{"workspaces":["project"]}');
  assert.equal(planSafeCommand("npm root", config(), { workspace, searchPath: TEST_PATH }), null);
  assert.equal(
    planSafeCommand("npm pkg get name", config(), { workspace: root, cwd: workspace, searchPath: TEST_PATH }),
    null,
  );
  // Querying the workspace root itself does not infer or visit its members.
  assert.ok(planSafeCommand("npm pkg get name", config(), { workspace: root, searchPath: TEST_PATH }));
});

await test("npm asks override reviewer modes, bash exemptions and allow prefixes", async () => {
  for (const reviewer of ["off", "ai", "manual"] as const) {
    const cfg = config({ reviewer, reviewExemptTools: ["bash"], allowRules: ["npm install", "npm run"] });
    for (const command of ["npm install --ignore-scripts helper", "npm run build", "npx helper"]) {
      const event = { toolName: "bash", input: { command } };
      const options = {
        rules: cfg.rules,
        classifierClient: async () => {
          throw new Error("npm asks must not reach the classifier");
        },
      };
      const denied = await evaluateToolCall(event, ctx(), cfg, new SessionApprovalStore(), options);
      assert.equal("block" in denied && denied.block, true, `${reviewer}: ${command}`);
      let prompts = 0;
      const allowed = await evaluateToolCall(
        event,
        ctx({
          hasUI: true,
          ui: {
            select: async () => {
              prompts += 1;
              return "Allow Once";
            },
          },
        }),
        cfg,
        new SessionApprovalStore(),
        options,
      );
      assert.deepEqual(allowed, {}, `${reviewer}: ${command}`);
      assert.equal(prompts, 1);
    }
  }
});

await test("users can explicitly disable npm approval defaults and retain their own script allow rules", (t) => {
  const root = mkdtempSync(join(tmpdir(), "callgate-npm-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "rules.jsonc");
  writeFileSync(
    file,
    JSON.stringify({
      disable: ["npm-install", "npm-exec"],
      rules: [{ id: "trusted-tests", prefix: "npm test", outcome: "allow" }],
    }),
  );
  const rules = loadCommandRules(file);
  assert.equal(rules.problem, null);
  assert.equal(escalateCommand("npm install helper", rules), null);
  assert.equal(escalateCommand("npm exec helper", rules), null);
  assert.ok(planSafeCommand("npm test", config(), { workspace: root, searchPath: TEST_PATH, rules }));
});
