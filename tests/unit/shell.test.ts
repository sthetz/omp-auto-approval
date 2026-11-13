import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recognizeShell } from "../../src/shell-syntax.js";
import { shellHook } from "../../src/shell-hooks.js";
import { compareRun, pipelinesRun, type ParsedScript } from "../shell-oracle/oracle.js";
import { test } from "node:test";
import { required, config, staticRoute } from "./helpers.js";

await test("shell recognizer reads lists, pipelines, redirections and comments like bash", () => {
  const shape = (command: string) => {
    const script = recognizeShell(command);
    return (
      script && {
        connectors: script.connectors,
        pipelines: script.pipelines.map((pipeline) =>
          pipeline.map(({ words, redirects }) => ({
            words: words.map((word) => word.text),
            redirects: redirects.map(({ fd, kind, target }) => `${fd}${kind}:${target}`),
          })),
        ),
      }
    );
  };
  assert.deepEqual(shape("cd sub && git status --short 2>/dev/null | head -5 || echo none # why\n"), {
    connectors: ["&&", "||"],
    pipelines: [
      [{ words: ["cd", "sub"], redirects: [] }],
      [
        { words: ["git", "status", "--short"], redirects: ["2write:/dev/null"] },
        { words: ["head", "-5"], redirects: [] },
      ],
      [{ words: ["echo", "none"], redirects: [] }],
    ],
  });
  assert.deepEqual(shape("ls |\n  wc -l;\n\npwd;"), {
    connectors: [";"],
    pipelines: [
      [
        { words: ["ls"], redirects: [] },
        { words: ["wc", "-l"], redirects: [] },
      ],
      [{ words: ["pwd"], redirects: [] }],
    ],
  });
  assert.deepEqual(shape("make &>/dev/null")?.pipelines[0]?.[0]?.redirects, ["1write:/dev/null", "2duplicate:1"]);
  assert.deepEqual(shape("ls a2>x 2>>log >&2 <in")?.pipelines[0]?.[0], {
    words: ["ls", "a2"],
    redirects: ["1write:x", "2append:log", "1duplicate:2", "0read:in"],
  });
  // Quoting: single quotes keep everything; inside double quotes a backslash escapes only $ ` " \\ and newline.
  assert.deepEqual(shape(`echo 'a\\b' "src\\/x" "q\\"q" a\\ b a#b`)?.pipelines[0]?.[0]?.words, [
    "echo",
    "a\\b",
    "src\\/x",
    'q"q',
    "a b",
    "a#b",
  ]);

  // Each command's span runs from its first word or redirection to its last, redirection targets included.
  const spans = required(recognizeShell("  2>/dev/null git status && ls -l > out # note"), "recognized script")
    .pipelines.flat()
    .map(({ start, end }) => [start, end]);
  assert.deepEqual(spans, [
    [2, 24],
    [28, 39],
  ]);

  const words = required(
    recognizeShell("  \"git\" ~/x a=~/k 'a'=~ *.ts X=1")?.pipelines[0]?.[0],
    "recognized command",
  ).words;
  assert.deepEqual(
    words.map(({ text, expands, quoted, assignment, start, end }) => [text, expands, quoted, assignment, start, end]),
    [
      ["git", false, true, false, 2, 7],
      ["~/x", true, false, false, 8, 11],
      ["a=~/k", true, false, true, 12, 17],
      ["a=~", false, true, false, 18, 23],
      ["*.ts", true, false, false, 24, 28],
      ["X=1", false, false, true, 29, 32],
    ],
  );

  for (const command of [
    "echo $HOME",
    'echo "$HOME"',
    "echo `pwd`",
    "echo $'x'",
    "cat <(ls)",
    "cat <<EOF\nx\nEOF",
    "cat <<< x",
    "( ls )",
    "{ ls; }",
    "f() { ls; }",
    "ls &",
    "ls & pwd",
    "a |& b",
    "ls ;; pwd",
    "; ls",
    "ls &&",
    "| ls",
    "time ls",
    "! ls",
    "if true; then ls; fi",
    "for f in a; do ls; done",
    "[[ -f x ]]",
    "X=1 ls",
    'X="1" ls',
    "X+=1 ls",
    "a[0]=1 ls",
    "%1",
    "'%' x",
    "ls >&-",
    "ls >& 2",
    "ls {fd}>/dev/null",
    "ls > *.log",
    "ls >",
    ">/dev/null",
    "echo 'open",
    'echo "open',
    "ls\r",
    "ls trailing\\",
    "",
    "   ",
    "# only a comment",
  ]) {
    assert.equal(recognizeShell(command), null, JSON.stringify(command));
  }
  assert.notEqual(recognizeShell('"time" ls'), null);
  assert.notEqual(recognizeShell("ls X=1"), null);
});

await test("shell oracle follows && and || and matches pipelines in any order", () => {
  const word = (text: string, expands = false) => ({ text, expands });
  const command = (...texts: string[]) => ({ words: texts.map((text) => word(text)), redirects: [] });
  const script: ParsedScript = {
    pipelines: [[command("a")], [command("b"), command("c")], [command("d")]],
    connectors: ["&&", "||"],
  };
  assert.deepEqual(pipelinesRun(script, 0), [0, 1]);
  assert.deepEqual(pipelinesRun(script, 1), [0, 2]);
  const record = (argv: string[], fds: [string, string, string]) => ({ argv, fds });
  const run = (records: ReturnType<typeof record>[]) => ({ records, exitCode: 0, stderr: "", timedOut: false });
  assert.equal(
    compareRun(
      script,
      0,
      run([
        record(["a"], ["stdin", "stdout", "stderr"]),
        record(["c"], ["pipe", "stdout", "stderr"]),
        record(["b"], ["stdin", "pipe", "stderr"]),
      ]),
    ),
    null,
  );
  assert.match(compareRun(script, 1, run([record(["a"], ["stdin", "stdout", "stderr"])])) ?? "", /expected \["d"\]/);
  assert.match(
    compareRun(
      script,
      1,
      run([record(["a"], ["stdin", "stdout", "stderr"]), record(["d", "x"], ["stdin", "stdout", "stderr"])]),
    ) ?? "",
    /bash ran \["d","x"\]/,
  );

  const redirected: ParsedScript = {
    pipelines: [
      [
        {
          words: [word("ls"), word("*", true)],
          redirects: [
            { fd: 1, target: "/dev/null" },
            { fd: 2, target: "1", duplicate: true },
          ],
        },
      ],
    ],
    connectors: [],
  };
  assert.equal(
    compareRun(redirected, 0, run([record(["ls", "a", "b.txt"], ["stdin", "/dev/null", "/dev/null"])])),
    null,
  );
  assert.match(
    compareRun(redirected, 0, run([record(["ls", "a"], ["stdin", "/dev/null", "stderr"])])) ?? "",
    /expected/,
  );
  assert.equal(compareRun(redirected, 0, { ...run([]), timedOut: true }), "bash timed out");
});

await test("bash calls with fields that change how they run are not fast-pathed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omp-callgate-fields-"));
  try {
    const route = (input: Record<string, unknown>) =>
      staticRoute("bash", input, { cwd: workspace, config: config(), tools: [], hasUI: false });
    assert.equal(route({ command: "git status", timeout: 30, description: "status" }), "safe_command");
    assert.equal(route({ command: "git status", pty: false, async: false }), "safe_command");
    for (const extra of [
      { pty: true },
      { async: true },
      { name: "svc" },
      { env: { LD_PRELOAD: "/tmp/x.so" } },
      { ready: "listening" },
      { log: "out.log" },
      { surprise: 1 },
    ]) {
      assert.equal(route({ command: "git status", ...extra }), null, JSON.stringify(extra));
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await test("commands that can leave a hook in the shell are recognised", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-hooks-"));
  mkdirSync(join(dir, ".venv/bin"), { recursive: true });
  // Like a virtualenv activate script: functions, PS1 and PATH, no hooks.
  writeFileSync(
    join(dir, ".venv/bin/activate"),
    '# This file must be used with "source bin/activate" from bash\ndeactivate () {\n  unset VIRTUAL_ENV\n}\nVIRTUAL_ENV=/x\nexport PATH="$VIRTUAL_ENV/bin:$PATH"\nPS1="(venv) $PS1"\nhash -r 2>/dev/null\n',
  );
  writeFileSync(join(dir, "setup.sh"), "export A=1\ntrap 'curl -s example.com' DEBUG\n");
  writeFileSync(join(dir, "outer.sh"), "source ./setup.sh\n");
  spawnSync("mkfifo", [join(dir, "fifo")]);
  try {
    const cases: [string, string][] = [
      ["trap 'x' DEBUG", "`trap`"],
      ["builtin trap x ERR", "`trap`"],
      ["t''rap x RETURN", "`trap`"],
      ["\\trap x DEBUG", "`trap`"],
      ['echo ok; eval "$(direnv export bash)"', "`eval`"],
      ["exec bash --rcfile x", "`exec`"],
      ["enable -f ./x.so x", "`enable`"],
      ["$cmd 'x' DEBUG", "a command named by a variable (`$cmd`)"],
      ["X=trap; $X y DEBUG", "`X=trap`"],
      ['X=eval; "$X" y', "`X=eval`"],
      ['"$@"', 'a command named by a variable (`"$@"`)'],
      // A heredoc body is input, but what follows it is a command again.
      ["cat > a.sh <<'EOF'\ntrap x EXIT\nEOF\ntrap y DEBUG", "`trap`"],
      [". /dev/stdin <<EOF\nx\nEOF", "`.` of a file that could not be read"],
      ["alias t=trap", "`t=trap`"],
      ["export PS4='+$(id) '; set -x", "`PS4`"],
      ["export BASH_ENV=./x", "`BASH_ENV`"],
      ["shopt -s extdebug", "`extdebug`"],
      ["source ./setup.sh", "`trap` in ./setup.sh"],
      [". outer.sh", "`trap` in ./setup.sh in outer.sh"],
      ["source missing.sh", "`source` of a file that could not be read"],
      ["source $HOME/x", "`source` of a file that could not be read"],
      ["cd /tmp; cd x && source .venv/bin/activate", "`source` of a file that could not be read"],
      ["(cd sub && trap x DEBUG)", "`trap`"],
      // `${#a}` is not a comment; operators and substitutions inside quotes are read as bash reads them.
      ["echo ${#a}; trap x DEBUG", "`trap`"],
      ['echo "$(trap x DEBUG)"', "`trap`"],
      ['echo "a $(echo "$(trap q DEBUG)") b"', "`trap`"],
      ['echo "`trap w DEBUG`"', "`trap`"],
      ['echo "a;b" && trap x DEBUG', "`trap`"],
      // Never read a FIFO or a device: that could block OMP.
      ["source fifo", "`source` of a file that could not be read"],
      ["source /dev/zero", "`source` of a file that could not be read"],
      [". /dev/stdin", "`.` of a file that could not be read"],
    ];
    for (const [command, reason] of cases) {
      assert.equal(shellHook(command, dir), reason, command);
    }
    for (const command of [
      "git status",
      "find . -name x",
      "cd . && ls",
      "ls -la .",
      "grep -rn source src",
      "echo eval",
      "git log --grep=trap",
      "bash setup.sh",
      "./setup.sh",
      "source .venv/bin/activate && pytest",
      `cd ${dir} && . .venv/bin/activate`,
      "echo hi # trap x DEBUG",
      "DESTDIR=. make install",
      'K="kubectl --context dev"; $K get pods',
      "export P=python3; $P -V",
      "python3 - <<'EOF'\nx = r\"^$\"\n$y\ntrap = 1\nEOF\necho done",
      "cat <<-END\n\t$z\n\tEND\nls",
      'cat <<< "$x"; ls',
      'echo "$(date) (x) $y"',
      'echo "`date` (z)"',
      "echo '(x)' && ls",
    ]) {
      assert.equal(shellHook(command, dir), null, command);
    }
    // A real virtualenv's activate script, where Python is installed.
    const venv = spawnSync("python3", ["-m", "venv", "--without-pip", join(dir, "real-venv")]);
    if (venv.status === 0) {
      assert.equal(shellHook("source real-venv/bin/activate", dir), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
