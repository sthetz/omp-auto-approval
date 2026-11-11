import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateToolCall } from "../../src/omp-host.js";
import { planSafeCommand } from "../../src/safe-command.js";
import { isSafeSedScript } from "../../src/program-rules.js";
import { compileRules, escalateCommand, loadCommandRules } from "../../src/command-rules.js";
import { SessionApprovalStore } from "../../src/session-approval-store.js";
import { test } from "node:test";
import {
  STUB_BIN,
  TEST_PATH,
  isSafeReadOnlyCommand,
  pinnedCommand,
  config,
  ctx,
  CLASSIFIER_DENY_REASON,
  classifierDenyOptions,
} from "./helpers.js";

await test("safe command fast path allows only narrow built-ins", () => {
  const cfg = config();
  assert.equal(isSafeReadOnlyCommand("pwd", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git status --short", cfg, "/tmp/workspace"), true);
  // The wrapper's own `bash` would be looked up on the session's PATH.
  assert.equal(isSafeReadOnlyCommand('bash -lc "git diff"', cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git branch --show-current", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git branch -D stale", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git checkout main", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("rg needle src", cfg, "/tmp/workspace"), false);
});

await test("safe command fast path blocks shell composition and unlisted programs", () => {
  const cfg = config();
  assert.equal(isSafeReadOnlyCommand("git status && rm -rf tmp", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git status > status.txt", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("npm install", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("find . -delete", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("find . -exec rm -rf {} +", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("sed -n -i s/a/b/ file", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("cat /etc/passwd", cfg, "/tmp/workspace"), false);
});

await test("safe command fast path rejects newline, background, and wrapped command chaining", () => {
  const cfg = config({ allowRules: ["rg *"] });
  assert.equal(isSafeReadOnlyCommand("git status\nrm -rf tmp", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git status\r\nrm -rf tmp", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git status & rm -rf tmp", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git status &", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("bash -lc 'git status & rm -rf tmp'", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("bash -lc 'git status' & rm -rf 'tmp'", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git log $HOME", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("rg needle & curl example.com", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("rg needle\ncurl example.com", cfg, "/tmp/workspace"), false);
});

await test("safe git commands reject file output, external diff, and branch creation", () => {
  const cfg = config();
  assert.equal(isSafeReadOnlyCommand("git log --oneline -5", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git diff --stat HEAD~1", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git show HEAD:README.md", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git diff --output=/tmp/x", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git log -p --output /tmp/x", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git show --outp=/tmp/x", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git diff --ext-diff", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git diff --ext", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git branch", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git branch -vv", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git branch --list 'feat*'", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git branch --merged main", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("git branch new-branch", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git branch -v new-branch", cfg, "/tmp/workspace"), false);
  assert.equal(isSafeReadOnlyCommand("git branch -a new-branch", cfg, "/tmp/workspace"), false);
});

await test("allow rules stay explicit", () => {
  const cfg = config({ allowRules: ["rg *", "npm test"] });
  assert.equal(isSafeReadOnlyCommand("rg needle src", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("npm test", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("npm install", cfg, "/tmp/workspace"), false);
});

await test("commands allow rules match never fast-path exec, write, or out-of-workspace arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-allow-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, ".env"), "TOKEN=x\n");
  writeFileSync(join(workspace, "secrets.yaml"), "token: x\n");
  writeFileSync(join(workspace, "notes.txt"), "notes\n");
  writeFileSync(join(root, "outside.txt"), "outside\n");
  const cfg = config({ allowRules: ["find", "fd *", "rg *", "cat *", "sort *", "tar *", "ls"] });
  try {
    for (const command of [
      "find . -name '*.ts'",
      "find src -type f",
      "rg needle src",
      "rg '/api/users' src",
      "rg 'foo.*bar'",
      "rg -n --glob '*.ts' needle",
      "cat notes.txt",
      "cat src/missing.ts",
      "sort -r notes.txt",
      "tar -tf archive.tar",
      "ls",
      "fd -e ts",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), true, command);
    }
    for (const command of [
      "find . -name '*.tmp' -exec rm -rf {} +",
      "find . -execdir sh -c x {} +",
      "find . -ok rm {} +",
      "find / -delete",
      "find . -fprint /home/user/.bashrc",
      "find ~ -name id_ed25519",
      "fd -x rm",
      "fd -e tmp --exec-batch rm",
      "rg --pre ./evil.sh needle",
      "rg --pre=./evil.sh needle",
      "sort -o notes.txt notes.txt",
      "sort -ro out.txt notes.txt",
      "sort --output=out.txt notes.txt",
      "tar -xIzstd -f a.tar",
      "tar xIf a.tar",
      "tar -x --to-command=sh -f a.tar",
      "cat ~/.ssh/id_ed25519",
      `cat ${join(root, "outside.txt")}`,
      "cat ../outside.txt",
      "cat .env",
      "cat secrets*",
      "cat *",
      "rg foo.*bar",
      "rg TOKEN --file=../outside.txt",
      "cat {notes,.env}.txt",
      "~/bin/tool",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), false, command);
    }
    assert.equal(
      isSafeReadOnlyCommand(
        `cat ${join(root, "outside.txt")}`,
        config({ allowRules: ["cat *"], readRoots: [root] }),
        workspace,
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("fast-pathed commands are pinned to the program on OMP's startup PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-pin-"));
  const workspace = join(root, "workspace");
  const spaced = join(root, "tool dir");
  mkdirSync(join(workspace, "bin"), { recursive: true });
  mkdirSync(spaced);
  for (const program of [join(workspace, "bin", "git"), join(spaced, "rg")]) {
    writeFileSync(program, "#!/bin/sh\n");
    chmodSync(program, 0o755);
  }
  mkdirSync(join(root, "links"));
  symlinkSync(join(workspace, "bin", "git"), join(root, "links", "git"));
  const cfg = config({ allowRules: ["rg *", "./scripts/check.sh"] });
  try {
    assert.equal(pinnedCommand("git status --short", cfg, workspace, TEST_PATH), `${STUB_BIN}/git status --short`);
    assert.equal(pinnedCommand('  "git" log -1', cfg, workspace, TEST_PATH), `  ${STUB_BIN}/git log -1`);
    assert.equal(pinnedCommand("pwd", cfg, workspace, TEST_PATH), `${STUB_BIN}/pwd`);
    // Directories and links inside the workspace are skipped: the agent writes there without review.
    assert.equal(
      pinnedCommand("git status", cfg, workspace, `${join(workspace, "bin")}:${join(root, "links")}:${STUB_BIN}`),
      `${STUB_BIN}/git status`,
    );
    assert.equal(pinnedCommand("git status", cfg, workspace, `relative/bin:${join(workspace, "bin")}`), null);
    assert.equal(pinnedCommand("rg needle", cfg, workspace, spaced), `'${join(spaced, "rg")}' needle`);
    assert.equal(pinnedCommand("rg needle", cfg, workspace, join(root, "missing")), null);
    assert.equal(pinnedCommand("./scripts/check.sh", cfg, workspace, ""), "./scripts/check.sh");
    assert.equal(pinnedCommand("git diff -- secrets*", cfg, workspace, TEST_PATH), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("the fast path reads chains and pipelines, safe redirections, and a leading cd", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-chain-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "sub"), { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "notes\n");
  writeFileSync(join(workspace, ".env"), "TOKEN=x\n");
  writeFileSync(join(root, "outside.txt"), "outside\n");
  const cfg = config({ allowRules: ["rg", "head", "cat"] });
  const plan = (command: string) =>
    planSafeCommand(command, cfg, { workspace, searchPath: TEST_PATH, rules: cfg.rules });
  try {
    for (const command of [
      "git status && git log -1",
      "git status; git diff --stat",
      "git log --oneline | head -5",
      "git status 2>&1 | head -20",
      "git diff 2>/dev/null || git status",
      "rg needle >/dev/null 2>&1",
      "git status &>/dev/null",
      "cat < notes.txt",
      "head -3 </dev/null",
      "# check\ngit status\ngit log -1",
      "cd sub && git status",
      "cd sub && cat ../notes.txt",
      "cd sub && cd .. && git diff -- notes.txt",
      "cd sub; git status",
      "git -C sub log -1 && git --no-pager -C sub -C .. diff -- notes.txt",
      "git grep -n needle -- '*.ts'",
      "git ls-files",
      "git tag",
      "git tag -l 'v*'",
      "git remote -v",
      "git stash list",
      "git blame notes.txt",
      "git cat-file -p HEAD:notes.txt",
    ]) {
      assert.notEqual(plan(command), null, command);
    }
    for (const command of [
      "git status && rm -rf tmp",
      "git status | sh",
      "git log > log.txt",
      "git log >> log.txt",
      "git log &> log.txt",
      "git log 2>log.txt",
      "git status >&3",
      "git status 3>&1",
      "cat < .env",
      `cat < ${join(root, "outside.txt")}`,
      "cd sub && git diff ../.env",
      "cd .. && git status",
      "cd /etc && git status",
      "cd missing && git status",
      "cd notes.txt && git status",
      "cd - && git status",
      "cd -P sub && git status",
      "cd 'su'* && git status",
      "cd sub",
      "cd sub || git status",
      "git status && cd sub",
      "cd sub && git status && cd .. && git status",
      "git -C .. status",
      "git -C missing status",
      "git -C sub diff ../.env",
      "git -c core.pager=sh log",
      "git -C",
      "git grep -O needle",
      "git grep -nOless needle",
      "git grep --open-files-in-pager needle",
      "git tag v1",
      "git tag -d v1",
      "git tag -a v1 -m x",
      "git remote add x y",
      "git stash",
      "git stash pop",
      "git fetch",
      "git config --get user.name",
    ]) {
      assert.equal(plan(command), null, command);
    }

    // Every program is pinned; a leading cd becomes the call's directory.
    // The plan also names the rule that let each command through.
    assert.deepEqual(plan("git status && git log -1 | head -3 2>&1"), {
      command: `${STUB_BIN}/git status && ${STUB_BIN}/git log -1 | ${STUB_BIN}/head -3 2>&1`,
      rules: [
        { id: "program:git status", source: "default" },
        { id: "program:git log", source: "default" },
        { id: "program:head", source: "default" },
      ],
    });
    const where = (planned: ReturnType<typeof plan>) => planned && { command: planned.command, cwd: planned.cwd };
    assert.deepEqual(where(plan("cd sub && git status")), {
      command: `${STUB_BIN}/git status`,
      cwd: join(workspace, "sub"),
    });
    assert.deepEqual(where(plan("cd sub &&\n  cd ..  &&  2>/dev/null git status # done")), {
      command: `2>/dev/null ${STUB_BIN}/git status # done`,
      cwd: workspace,
    });
    assert.deepEqual(
      where(
        planSafeCommand("cd .. && git status", cfg, {
          workspace,
          cwd: join(workspace, "sub"),
          searchPath: TEST_PATH,
          rules: cfg.rules,
        }),
      ),
      {
        command: `${STUB_BIN}/git status`,
        cwd: workspace,
      },
    );
    // Every program must be found: one unknown program sends the whole chain to review.
    assert.equal(pinnedCommand("git status | head", cfg, workspace, `${STUB_BIN}/missing:${join(root, "none")}`), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("common read-only programs skip review by their option tables", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-programs-"));
  const workspace = join(root, "workspace");
  for (const file of [
    "notes.txt",
    "src/a.ts",
    "src/b.ts",
    ".env",
    "app/index.ts",
    "app/node_modules/pkg/.env",
    "dash/-o.txt",
    "dash/x.txt",
  ]) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true });
    writeFileSync(join(workspace, file), "x\n");
  }
  writeFileSync(join(root, "outside.txt"), "outside\n");
  const cfg = config();
  const safe = (command: string, cwd?: string) =>
    planSafeCommand(command, cfg, { workspace, cwd, searchPath: TEST_PATH, rules: cfg.rules }) !== null;
  try {
    for (const command of [
      "cat notes.txt",
      "cat -n src/a.ts",
      "head -20 notes.txt",
      "head -n 5 notes.txt",
      "tail -n +2 notes.txt",
      "tail -3 notes.txt",
      "wc -l src/*.ts",
      "ls",
      "ls -la src",
      "ls src/*.ts",
      "ls --color=auto -1",
      "du -sh src",
      "stat -c %s notes.txt",
      "grep -n foo notes.txt",
      "grep -rn foo src",
      "grep -rn -A3 -e foo -e bar src",
      "grep -c foo src/a.ts src/b.ts",
      "grep -rn foo --include='*.ts' .",
      "grep -rn foo --include=*.ts src",
      "grep -rn foo --exclude-dir=node_modules app",
      "grep -rln foo --exclude-dir='node_*' app",
      "git log --oneline | grep -iE 'fix|feat' | head -5",
      "sed -n '1,5p' notes.txt",
      "sed 's/a/b/g' notes.txt",
      "sed -n '/start/,/end/p' notes.txt",
      "sed -E -e 's|x|y|' -e '3q' notes.txt",
      "cut -c1-20 notes.txt",
      "sort -u notes.txt | uniq -c",
      "sort -k2,2 -t: -rn notes.txt",
      "tr -d x < notes.txt",
      "jq -r '.name' src/a.ts",
      "jq '.spec.env' src/a.ts",
      "jq -n --arg v 1 '$v'",
      "find src -name '*.ts' -type f",
      "find . -maxdepth 2 \\( -name x -o -name y \\) -print",
      "find . -newer notes.txt",
      "echo --- && git status",
      "printf '%s\\n' a b",
      "date +%s",
      "date -u",
      "sleep 1",
      "basename /a/b.ts .ts",
      "which git",
      "uname -a",
      "timeout 10 git status",
      "timeout -s KILL 5 grep -n x notes.txt",
      "diff notes.txt src/a.ts",
      "diff -u src/a.ts src/b.ts",
      "pwd -P",
    ]) {
      assert.equal(safe(command), true, command);
    }
    for (const command of [
      // Credential-like or outside files, directly or through a glob, a directory, or a recursive read.
      "cat .env",
      "cat ../outside.txt",
      `head ${join(root, "outside.txt")}`,
      "cat *",
      "cat .e*",
      "head -c 5 ~/.ssh/id_rsa",
      "grep -rn foo .",
      "grep -rn foo",
      "grep -n foo .",
      "grep -rn foo app",
      "grep -rn foo --include=*.ts .",
      "grep -rn foo --exclude-dir='[n]ode_modules' app",
      "grep -rn foo src/*.nothing",
      "diff -r app src",
      "diff app src",
      "cat src/*.nothing",
      "ls ..",
      "ls .*",
      "find .. -name x",
      "find . -newer ../outside.txt",
      "grep -f .env notes.txt",
      // Options outside the tables: writes, programs, symlink following, unknowns, abbreviations.
      "tail -f notes.txt",
      "sort -o out.txt notes.txt",
      "sort -T /tmp notes.txt",
      "uniq notes.txt out.txt",
      "grep -R foo src",
      "grep -z foo notes.txt",
      "grep --incl='*.ts' foo src",
      "grep -A x foo notes.txt",
      "ls -L",
      "cat --unknown notes.txt",
      "diff -l notes.txt src/a.ts",
      "date -s 2020-01-01",
      "date 0101",
      "hostname evil",
      "printf -v x y",
      "du -L src",
      "sed -i s/a/b/ notes.txt",
      "sed 's/a/b/w out' notes.txt",
      "sed 's/a/b/e' notes.txt",
      "sed 'e ls' notes.txt",
      "sed '1r /etc/passwd' notes.txt",
      "sed -f script.sed notes.txt",
      "jq -n env",
      "jq -n '$ENV.HOME'",
      "jq 'import \"x\" as x; .' src/a.ts",
      "jq -f prog.jq src/a.ts",
      "find . -exec rm {} +",
      "find . -delete",
      "find -L . -name x",
      "find . -name *.ts",
      "find . -fprint out",
      "echo *",
      "timeout 5 rm notes.txt",
      "timeout 5 sh -c 'rm x'",
      "timeout 5",
      "timeout x git status",
      "./cat notes.txt",
    ]) {
      assert.equal(safe(command), false, command);
    }
    // A glob match that starts with `-` would be read as an option.
    assert.equal(safe("cat *.txt", join(workspace, "dash")), false);
    assert.equal(safe("cat ./*.txt", join(workspace, "dash")), true);

    assert.equal(
      pinnedCommand("timeout 5 git status | head -3", cfg, workspace),
      `${STUB_BIN}/timeout 5 ${STUB_BIN}/git status | ${STUB_BIN}/head -3`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("a leading ~ is pinned to OMP's home directory, since the shell's HOME can change", () => {
  const home = mkdtempSync(join(tmpdir(), "omp-clearance-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  writeFileSync(join(home, "notes.txt"), "x\n");
  try {
    const cfg = config({ readRoots: ["~"], allowRules: ["rg"] });
    const workspace = join(home, "workspace");
    mkdirSync(workspace);
    assert.equal(pinnedCommand("cat ~/notes.txt", cfg, workspace), `${STUB_BIN}/cat ${home}/notes.txt`);
    assert.equal(pinnedCommand("ls -d ~/*.txt", cfg, workspace), `${STUB_BIN}/ls -d ${home}/*.txt`);
    assert.equal(pinnedCommand("rg x ~/notes.txt", cfg, workspace), `${STUB_BIN}/rg x ${home}/notes.txt`);
    assert.equal(pinnedCommand("cat '~/notes.txt'", cfg, workspace), `${STUB_BIN}/cat '~/notes.txt'`);
    assert.equal(pinnedCommand("cat ~root/x", cfg, workspace), null);
  } finally {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

await test("sed scripts are fast-pathed only when they cannot read, write, or run anything", () => {
  for (const script of [
    "p",
    "1,5p",
    "$p",
    "/a/,/b/p",
    "1~2p",
    "/x/,+3d",
    "s/a/b/g",
    "s|a/b|c|",
    "s/a\\/b/c/2",
    "1!d",
    "3q",
    "q5",
    "=",
    "1,5p;10q",
    "s/a/b/;s/c/d/",
    "/re/I,$ p",
    " p ; p ;",
    "y",
  ]) {
    assert.equal(isSafeSedScript(script), script !== "y", script);
  }
  for (const script of [
    "w x",
    "s/a/b/w x",
    "s/a/b/gw x",
    "s/a/b/e",
    "e",
    "e ls",
    "r x",
    "1r x",
    "R x",
    "W x",
    "a text",
    "1i\\",
    "y/ab/cd/",
    "s/a/b",
    "#n",
    "s/[/]/x/",
    "p\nw x",
    "1{p}",
    ":a",
    "b",
    "s/a/b/\nw x",
    "1,",
    "/a",
  ]) {
    assert.equal(isSafeSedScript(script), false, script);
  }
});

await test("a word naming a file after any = is checked as that file", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-equals-"));
  writeFileSync(join(workspace, "notes.txt"), "x\n");
  try {
    const cfg = config({ allowRules: ["npm view"] });
    for (const command of [
      "npm view x go-template-file=/etc/passwd",
      "npm view x --from-file=key=/etc/passwd",
      "npm view x a=b=/etc/passwd",
      "npm view x -ofile=/etc/passwd",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), false, command);
    }
    for (const command of [
      "npm view x go-template-file=notes.txt",
      "npm view x --from-file=key=notes.txt",
      "npm view x a=b",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), true, command);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("a git option naming a file outside the workspace is reviewed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-git-files-"));
  writeFileSync(join(workspace, "order.txt"), "*.ts\n");
  try {
    for (const command of [
      "git diff -O/etc/passwd",
      "git log --format=x=/etc/passwd",
      "git -C . show -O/etc/passwd HEAD",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, config(), workspace), false, command);
    }
    for (const command of ["git diff -Oorder.txt", "git log --format=%H", "git diff -O order.txt"]) {
      assert.equal(isSafeReadOnlyCommand(command, config(), workspace), true, command);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("long options named like Object.prototype members are unknown options", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-proto-"));
  writeFileSync(join(workspace, "notes.txt"), "x\n");
  try {
    for (const command of [
      "sort --constructor x notes.txt",
      "grep --valueOf=1 x notes.txt",
      "cat --__proto__ notes.txt",
      "head --hasOwnProperty 1 notes.txt",
      "git --constructor status",
      "git constructor",
      "git __proto__",
      "find . -constructor x",
      "constructor",
      "toString x",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, config(), workspace), false, command);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("an entry with subcommands reads its own options as whole words before the subcommand", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-subcommands-"));
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "notes.txt"), "x\n");
  try {
    // npm is a stub program here; the entry is made up.
    const rules = {
      problem: null,
      files: [],
      rules: [],
      programs: compileRules({
        programs: {
          npm: {
            options: { "-q --quiet": "flag", "-C": "workspace-directory", "--depth": "number" },
            except: ["--write"],
            subcommands: {
              "list show": { options: "any", operands: "git-operands" },
              view: { options: "any", except: ["-x"], operands: "none" },
            },
          },
        },
      }),
    };
    const safe = (command: string) =>
      planSafeCommand(command, config(), { workspace, searchPath: TEST_PATH, rules }) !== null;
    for (const command of [
      "npm list",
      "npm -q list notes.txt",
      "npm --quiet -C sub show",
      "npm --depth 2 list",
      "npm view -a",
      "npm list -- notes.txt",
    ]) {
      assert.equal(safe(command), true, command);
    }
    for (const command of [
      "npm",
      "npm -q",
      "npm publish",
      "npm -qC sub list",
      "npm -Csub list",
      "npm -C /etc list",
      "npm -C missing list",
      "npm -C",
      "npm --depth x list",
      "npm --depth=2 list",
      "npm list --write",
      "npm list --wr",
      "npm list --write-all",
      "npm view -ax",
      "npm view x",
      "npm list /etc/passwd",
      "npm list ../x",
      "npm list $X",
      "npm $SUB",
      "npm -C sub list ../../x",
    ]) {
      assert.equal(safe(command), false, command);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("a fast-pathed bash call runs pinned, and only from inside the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-pin-call-"));
  mkdirSync(join(workspace, "sub"));
  try {
    const event = { toolName: "bash", input: { command: "git status --short" } as Record<string, unknown> };
    assert.deepEqual(
      await evaluateToolCall(
        event,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        classifierDenyOptions(),
      ),
      {},
    );
    assert.match(String(event.input.command), /^\/\S*\/git status --short$/);

    const inside = { toolName: "bash", input: { command: "git status", cwd: "sub" } as Record<string, unknown> };
    assert.deepEqual(
      await evaluateToolCall(
        inside,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        classifierDenyOptions(),
      ),
      {},
    );
    assert.equal(inside.input.cwd, "sub");

    // A leading cd is not run in the shell, where an earlier call may have redefined it; the call moves instead.
    const moved = {
      toolName: "bash",
      input: { command: "cd sub && git log -1 2>/dev/null" } as Record<string, unknown>,
    };
    assert.deepEqual(
      await evaluateToolCall(
        moved,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        classifierDenyOptions(),
      ),
      {},
    );
    assert.match(String(moved.input.command), /^\/\S*\/git log -1 2>\/dev\/null$/);
    assert.equal(moved.input.cwd, join(workspace, "sub"));
    const outside = { toolName: "bash", input: { command: "git status", cwd: "/etc" } };
    assert.deepEqual(
      await evaluateToolCall(
        outside,
        ctx({ cwd: workspace }),
        config({ reviewer: "ai" }),
        new SessionApprovalStore(),
        classifierDenyOptions(),
      ),
      { block: true, reason: CLASSIFIER_DENY_REASON },
    );
    assert.equal(outside.input.command, "git status");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("commands allow rules match see through abbreviations, glued values, and name=value arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-argv-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "notes.txt"), "notes\n");
  writeFileSync(join(workspace, "patterns.txt"), "notes\n");
  writeFileSync(join(workspace, ".env"), "TOKEN=x\n");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside\n");
  const cfg = config({ allowRules: ["sort *", "rg *", "fd *", "grep *", "dd *", "tar *", "cat *"] });
  try {
    for (const command of [
      "sort -k2 -t, notes.txt",
      "sort --reverse notes.txt",
      "rg --passthru needle notes.txt",
      "fd -H -e ts",
      "grep -fpatterns.txt notes.txt",
      "grep -rn needle .",
      "grep -e/api/users notes.txt",
      "dd if=notes.txt",
      "cat a=b",
      'cat "a"=~/notes.txt',
      "tar -tf archive.tar",
      "tar tvf archive.tar",
      "tar --list -f archive.tar",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), true, command);
    }
    for (const command of [
      "sort --outp=x.txt notes.txt",
      "sort --compress-prog=sh notes.txt",
      "sort --o=x.txt notes.txt",
      "rg --pr=./x.sh needle",
      "fd -Hx rm",
      "fd -HX rm",
      `grep -f${outside} notes.txt`,
      "grep -f.env notes.txt",
      `dd if=${outside}`,
      "dd if=.env",
      "dd if=~/notes.txt",
      "cat a=x:~/notes.txt",
      "tar -xf archive.tar",
      "tar xf archive.tar",
      "tar -czf out.tar notes.txt",
      "tar --extract -f archive.tar",
      "tar --ext -f archive.tar",
      "tar --delete -f archive.tar notes.txt",
      `grep -${"r".repeat(600)} needle`,
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), false, command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("allow rules for script programs and bare interpreters are errors", () => {
  for (const prefix of ["sed -n", "xargs", "awk *", "python", "bash *", "env", "python -*", "sudo*"]) {
    assert.throws(
      () => config({ allowRules: [prefix] }),
      new RegExp(
        `prefix: (${prefix.split(" ")[0]} runs commands|allowing bare ${prefix.split(" ")[0]} would allow any code)`,
      ),
      prefix,
    );
  }
  const cfg = config({ allowRules: ["python -m pytest", "npm test"] });
  for (const command of ["python -c 'import os'", "npm install"]) {
    assert.equal(isSafeReadOnlyCommand(command, cfg, "/tmp/workspace"), false, command);
  }
  assert.equal(isSafeReadOnlyCommand("python -m pytest tests", cfg, "/tmp/workspace"), true);
  assert.equal(isSafeReadOnlyCommand("npm test", cfg, "/tmp/workspace"), true);
  // A prefix with a glued `*` names no program in full, so it cannot let
  // a shell, interpreter or wrapper through.
  const glued = config({ allowRules: ["ba*", "pyth*", "e*", "s*", "timeou*", "python -m pytest*"] });
  for (const command of [
    "bash -c 'rm -rf x'",
    "python -c 'import os'",
    "python3 -c x",
    "env rm x",
    "sudo rm x",
    "timeout 5 rm x",
    "/usr/bin/env rm x",
  ]) {
    assert.equal(isSafeReadOnlyCommand(command, glued, "/tmp/workspace"), false, command);
  }
  assert.equal(isSafeReadOnlyCommand("python -m pytest -x tests", glued, "/tmp/workspace"), true);
});

await test("safe git commands reject operands outside the workspace or naming secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-clearance-git-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  symlinkSync(root, join(workspace, "linked-parent"));
  const cfg = config();
  try {
    for (const command of [
      "git diff HEAD~1 -- src",
      "git log --oneline main..feature",
      "git show HEAD:src/a.ts",
      "git diff --stat origin/main",
      "git log -n 5 --author 'A Person'",
      "git status src",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), true, command);
    }
    for (const command of [
      "git diff /tmp/secret.txt /dev/null",
      "git diff ~/.ssh/id_ed25519 /dev/null",
      "git diff --no-index a.txt b.txt",
      "git diff --no-i a.txt b.txt",
      "git log -p -- ../other",
      "git diff ..",
      "git diff linked-parent/secret.txt src",
      "git show HEAD:.env",
      "git show :config/credentials.json",
      "git show HEAD:../outside",
      "git diff .env",
      "git log -p -- secrets/token",
    ]) {
      assert.equal(isSafeReadOnlyCommand(command, cfg, workspace), false, command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("allow rules let commands through by their prefix", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-clearance-allow-rules-"));
  writeFileSync(join(workspace, "notes.txt"), "x\n");
  writeFileSync(join(workspace, ".env"), "SECRET=1\n");
  try {
    writeFileSync(
      join(workspace, "rules.jsonc"),
      '{ "rules": [{ "id": "rg", "outcome": "allow", "prefix": "rg" }, { "id": "no-rg-pre", "match": "rg --pre*", "outcome": "block" }] }',
    );
    const rules = loadCommandRules(join(workspace, "rules.jsonc"));
    const plan = (command: string) => planSafeCommand(command, config(), { workspace, searchPath: TEST_PATH, rules });
    assert.deepEqual(plan("rg x notes.txt")?.rules, [
      { id: "rg", source: join(workspace, "rules.jsonc").replace(homedir(), "~") },
    ]);
    for (const command of ["rgx", "rg x /etc/passwd", "rg --pre=cat x", "rg x .env"]) {
      assert.equal(plan(command), null, command);
    }
    assert.equal(escalateCommand("rg --pre=cat x", rules)?.rule.id, "no-rg-pre");
    assert.equal(escalateCommand("rg x", rules), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
