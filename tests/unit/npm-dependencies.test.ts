import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { defaultRules, escalateCommand } from "../../src/command-rules.js";
import { planSafeCommand } from "../../src/safe-command.js";
import { config, required, TEST_PATH } from "./helpers.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "callgate-npm-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "work");
  const write = (path: string, data: unknown) => {
    const file = join(workspace, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  write("package.json", { name: "project", version: "1.0.0", dependencies: { alpha: "^1" } });
  write("node_modules/alpha/package.json", { name: "alpha", version: "1.0.0" });
  const plan = (command: string) => planSafeCommand(command, config(), { workspace, searchPath: TEST_PATH });
  return { root, workspace, write, plan };
}

await test("npm dependency queries accept literal filters and only known display options", (t) => {
  const { plan } = fixture(t);
  for (const command of [
    "npm ls",
    "npm list --json --all",
    "npm ls --depth=0 --long --parseable",
    "npm list --omit dev --include=optional -a -l -p --link --no-unicode",
    "npm ls alpha '@scope/package@^1' --depth 2",
    "npm explain alpha --json",
    "npm explain node_modules/alpha",
    "npm ls install version",
    "npm explain version",
    "npm list --json | cat",
  ]) {
    assert.match(required(plan(command), command).command, /^\//, command);
    assert.equal(escalateCommand(command, defaultRules()), null, command);
  }
  for (const command of [
    "npm explain",
    "npm ls -g",
    "npm --json ls",
    "npm ls --global",
    "npm ls --prefix=..",
    "npm ls --workspace=outside",
    "npm ls --workspaces",
    "npm ls --package-lock-only",
    "npm ls --cache=../cache",
    "npm ls --timing",
    "npm ls --depth=-1",
    "npm ls --depth",
    "npm ls --omit=anything",
    "npm ls --depth=1 --userconfig=../config",
    "npm ls --dep=0",
    "npm ls -al",
    "npm ls -- alpha",
    "npm ls $NAME",
    "npm ls a*",
    "npm explain --all alpha",
  ]) {
    assert.equal(plan(command), null, command);
  }
  assert.equal(escalateCommand("npm ls version; npm version patch", defaultRules())?.outcome, "ask");
  assert.equal(escalateCommand("npm explain install && npm install alpha", defaultRules())?.outcome, "ask");
  assert.equal(escalateCommand("npm ls version", config({ blockRules: ["npm version"] }).rules)?.outcome, "block");
});

await test("dependency links inside the workspace include hoisted dependencies and terminate on cycles", (t) => {
  const { workspace, write, plan } = fixture(t);
  write("local/beta/package.json", { name: "beta", version: "1.0.0", dependencies: { alpha: "^1" } });
  symlinkSync("../local/beta", join(workspace, "node_modules/beta"));
  mkdirSync(join(workspace, "local/beta/node_modules"));
  symlinkSync("..", join(workspace, "local/beta/node_modules/cycle"));
  assert.ok(plan("npm explain beta --json"));
  assert.ok(plan("npm ls --depth=0"));
});

await test("dependency reads reject escaping, sensitive and dangling links even at depth zero", (t) => {
  const { root, workspace, write, plan } = fixture(t);
  write("../outside/package.json", { name: "outside", version: "1.0.0" });
  write("secrets/hidden/package.json", { name: "secret", version: "1.0.0" });
  for (const target of [join(root, "outside"), join(workspace, "secrets/hidden"), join(root, "missing")]) {
    symlinkSync(target, join(workspace, "node_modules/beta"));
    assert.equal(plan("npm ls --depth=0"), null, target);
    assert.equal(plan("npm explain alpha"), null, target);
    rmSync(join(workspace, "node_modules/beta"));
  }
  rmSync(join(workspace, "node_modules/alpha/package.json"));
  write(".env", { name: "private", version: "1.0.0" });
  symlinkSync("../../.env", join(workspace, "node_modules/alpha/package.json"));
  assert.equal(plan("npm list --json"), null);
});

await test("scope, nested node_modules and inferred bin-directory reads stay bounded", (t) => {
  const { root, workspace, write, plan } = fixture(t);
  write("../outside/package.json", { name: "outside", version: "1.0.0" });
  for (const link of ["node_modules/@scope", "node_modules/alpha/node_modules"]) {
    symlinkSync(join(root, "outside"), join(workspace, link));
    assert.equal(plan("npm ls"), null, link);
    rmSync(join(workspace, link));
  }
  write("node_modules/alpha/package.json", { name: "alpha", version: "1.0.0", directories: { bin: "tools" } });
  symlinkSync(join(root, "outside"), join(workspace, "node_modules/alpha/tools"));
  assert.equal(plan("npm ls --json --long"), null);
});

await test("ordinary and hidden lockfiles cannot redirect metadata reads outside the workspace", (t) => {
  const { root, workspace, write, plan } = fixture(t);
  write("../outside.json", { secret: "private" });
  for (const path of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "node_modules/.package-lock.json"]) {
    symlinkSync(join(root, "outside.json"), join(workspace, path));
    assert.equal(plan("npm ls"), null, path);
    rmSync(join(workspace, path));
  }
  write("node_modules/.package-lock.json", {
    lockfileVersion: 3,
    packages: { "node_modules/alpha": { version: "1.0.0" } },
  });
  assert.ok(plan("npm ls --json"));
  write("node_modules/.package-lock.json", {
    lockfileVersion: 3,
    packages: { "node_modules/beta": { link: true, resolved: "../outside" } },
  });
  assert.equal(plan("npm ls"), null);
  write("node_modules/.package-lock.json", { packages: { "../../escape": { version: "1.0.0" } } });
  assert.equal(plan("npm explain alpha"), null);
});

await test("root workspace declarations and metadata exceeding the read budget require review", (t) => {
  const { workspace, write, plan } = fixture(t);
  write("package.json", { name: "project", workspaces: ["../outside"] });
  assert.equal(plan("npm ls"), null);
  write("package.json", { name: "project" });
  writeFileSync(join(workspace, "node_modules/alpha/package.json"), " ".repeat(16 * 1024 * 1024 + 1));
  assert.equal(plan("npm ls --depth=0"), null);
});
