import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { canonicalPath, relativePathWithin, resolvePathForCwd } from "../../src/common.js";
import { isReadTarget, isWorkspaceWriteFastPath, resolveReadRoots } from "../../src/tool-routing.js";
import { planSafeCommand } from "../../src/safe-command.js";
import { config, TEST_PATH } from "./helpers.js";

await test("boundary checks follow symlinks before parent components, just as filesystem reads do", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "actual", "deep"), { recursive: true });
  mkdirSync(join(outside, "deep"), { recursive: true });
  writeFileSync(join(workspace, "visible.txt"), "inside");
  writeFileSync(join(workspace, "actual", "visible.txt"), "inside target");
  writeFileSync(join(outside, "visible.txt"), "outside");
  symlinkSync(join(outside, "deep"), join(workspace, "absolute-link"));
  symlinkSync("../outside/deep", join(workspace, "relative-link"));
  symlinkSync("actual/deep", join(workspace, "inside-link"));
  // The target itself also contains a link followed by a parent component.
  symlinkSync("relative-link/..", join(workspace, "target-parent"));
  const roots = resolveReadRoots(workspace, []);
  for (const path of ["absolute-link/../visible.txt", "relative-link/../visible.txt", "target-parent/visible.txt"]) {
    const absolute = resolvePathForCwd(path, workspace);
    assert.equal(readFileSync(absolute, "utf8"), "outside", path);
    assert.equal(canonicalPath(path, workspace), join(outside, "visible.txt"), path);
    assert.equal(relativePathWithin(path, workspace), null, path);
    assert.equal(isReadTarget(absolute, roots), false, path);
    assert.equal(isWorkspaceWriteFastPath({ path: absolute, content: "changed" }, workspace), false, path);
  }
  const inside = `${workspace}/inside-link/../visible.txt`;
  assert.equal(readFileSync(inside, "utf8"), "inside target");
  assert.equal(canonicalPath(inside, workspace), join(workspace, "actual", "visible.txt"));
  assert.equal(relativePathWithin(inside, workspace), join("actual", "visible.txt"));
  assert.equal(isReadTarget(inside, roots), true);
  assert.equal(isWorkspaceWriteFastPath({ path: inside, content: "changed" }, workspace), true);
  const alias = join(root, "workspace-alias");
  symlinkSync(workspace, alias);
  assert.equal(relativePathWithin("inside-link/../visible.txt", alias), join("actual", "visible.txt"));
});

await test("dangling links are classified by the targets that filesystem writes create", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-dangling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  symlinkSync("../outside/new.txt", join(workspace, "outside-link.txt"));
  symlinkSync("inside.txt", join(workspace, "inside-link.txt"));
  symlinkSync(".env", join(workspace, "settings.txt"));
  symlinkSync("../outside/future", join(workspace, "missing-parent"));
  for (const [name, destination, allowed] of [
    ["outside-link.txt", join(outside, "new.txt"), false],
    ["inside-link.txt", join(workspace, "inside.txt"), true],
    ["settings.txt", join(workspace, ".env"), false],
    ["missing-parent/sub/new.txt", join(outside, "future", "sub", "new.txt"), false],
    ["new/parents/file.txt", join(workspace, "new", "parents", "file.txt"), true],
  ] as const) {
    const path = resolvePathForCwd(name, workspace);
    assert.equal(canonicalPath(path, workspace), destination, name);
    assert.equal(isWorkspaceWriteFastPath({ path, content: name }, workspace), allowed, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(path, name);
    assert.equal(readFileSync(destination, "utf8"), name);
  }
});

await test("unknown boundary resolution and symlink loops never qualify for a fast path", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-callgate-resolution-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "file.txt"), "data");
  symlinkSync("loop-b", join(workspace, "loop-a"));
  symlinkSync("loop-a", join(workspace, "loop-b"));
  const roots = resolveReadRoots(workspace, []);
  for (const path of ["loop-a", "loop-a/new.txt", "file.txt/child", "file.txt/../new.txt", "file.txt/", "bad\0path"]) {
    assert.equal(canonicalPath(path, workspace), null, path);
    assert.equal(relativePathWithin(path, workspace), null, path);
    assert.equal(isReadTarget(path, roots), false, path);
    assert.equal(isWorkspaceWriteFastPath({ path, content: "data" }, workspace), false, path);
  }
  assert.equal(
    isWorkspaceWriteFastPath({ path: "ordinary.txt", content: "data" }, workspace, ["loop-a"]),
    false,
    "an unresolved protected destination must not be silently ignored",
  );
  assert.equal(isReadTarget("file.txt", resolveReadRoots(join(workspace, "loop-a"), [])), false);
});

await test("bash operands, redirects, allow-rule arguments and glob prefixes retain filesystem path order", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-callgate-shell-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "actual", "deep"), { recursive: true });
  mkdirSync(join(outside, "deep"), { recursive: true });
  writeFileSync(join(workspace, "visible.txt"), "inside");
  writeFileSync(join(workspace, "actual", "visible.txt"), "inside target");
  writeFileSync(join(outside, "visible.txt"), "outside");
  symlinkSync("../outside/deep", join(workspace, "link"));
  symlinkSync("actual/deep", join(workspace, "inside-link"));
  const cfg = config({ allowRules: ["rg"] });
  for (const command of [
    "cat link/../visible.txt",
    "cat < link/../visible.txt",
    "rg needle link/../visible.txt",
    "cat link/../*.txt",
    "cd inside-link/.. && cat visible.txt",
  ]) {
    assert.equal(planSafeCommand(command, cfg, { workspace, searchPath: TEST_PATH }), null, command);
  }
  for (const command of [
    "cat inside-link/../visible.txt",
    "cat inside-link/../*.txt",
    "cd actual/deep/.. && cat visible.txt",
  ]) {
    assert.ok(planSafeCommand(command, cfg, { workspace, searchPath: TEST_PATH }), command);
  }
});
