# Contributing

## Setup

```bash
npm install
npm run check
```

`npm run check` runs the format check, the type check, ESLint (typescript-eslint, with type information), the tests, and a smoke test that loads the extension through a stand-in for OMP's extension API. It needs Node 20.11 or later and `git` (and uses `python3` for one test when it is there). It uses no network, no model, and no files outside temporary directories. CI runs it on pull requests and on pushes to `master`.

`npm run format` formats the TypeScript with [Prettier](https://prettier.io); set your editor to format on save, or run it before committing. A commit that only reformats goes in `.git-blame-ignore-revs`, which GitHub's blame skips; for `git blame` to skip it too, run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once.

There is no build step: OMP loads the TypeScript sources directly. To try a change in OMP itself, link your checkout as the extension with `omp plugin link /path/to/checkout`, and restart OMP.

## The development cycle

A change to what the extension allows can be wrong in ways unit tests don't show: a rule that matches too much, a parser that reads a command differently from bash, an option that turns out to write files, or behaviour that holds against the stub but not in OMP. Every change goes through some of these steps, depending on what it touches:

| Step | Command | Needs | Run it when you change |
| --- | --- | --- | --- |
| 1. Unit tests and smoke test | `npm run check` | Node, `git` | anything |
| 2. Decision diff | `npm run decisions:diff` | `git` | rules, program tables, the shell parser, path checks |
| 3. Shell parser oracle | `npm run oracle:shell` | `bwrap`, `bash` | `src/shell-syntax.ts`, `src/shell-hooks.ts`, `src/command-patterns.ts` |
| 4. Program table oracles | `npm run oracle:programs`, `npm run oracle:help` | `bwrap`, `strace`, `bash` | `config/default-rules.jsonc`, `src/program-rules.ts` |
| 5. End-to-end under OMP | `npm run e2e:omp` | `omp` | anything that talks to OMP: `index.ts`, `src/decision.ts`, tool arguments, host imports |

Steps 2 to 5 run on your machine only, not in CI, since they need tools CI lacks or data that is yours. Mention in the pull request which ones you ran.

### Unit tests and smoke test

Add a test for every change to what is allowed, asked, reviewed or blocked. The unit tests use Node's built-in test runner, one file per area in `tests/unit/`: `fast-path`, `command-rules`, `shell`, `tools`, `classifier`, `reviewer`, `extension`, `model-selector` and `config`. Most tests call `evaluateToolCall` or `planSafeCommand` directly. `tests/unit/helpers.ts` makes them run programs from a temporary directory of stub programs and points the config, rules and audit log paths at temporary files, so they never read or write your real ones. Each file runs in its own process, and its tests run in order.

To run one file, or the tests whose names match a pattern:

```bash
node --import tsx --test tests/unit/fast-path.test.ts
node --import tsx --test --test-name-pattern="sed scripts" tests/unit/*.test.ts
```

`config/default-rules.jsonc` is validated strictly when it loads: an unknown key, kind or check name, or an option listed twice, is an error. Then every bash command is blocked in every reviewer mode, including `off`, until the file is fixed; `/callgate status` says why. Default, user and included files are checked for changes on every tool call and reload automatically. `npm test` loads the defaults, checks `schemas/rules.schema.json` against the code, and covers broken-file and include reloads.

### Internal classifier evaluation

The development-only classifier harness runs cases through the production
classifier and OMP's configured model registry and authentication. Two
development sets live in `tests/classifier-eval/cases/`:

- `ts-bench-smoke.jsonl`: 24 selected, relabeled TS-Bench cases. The manifest
  records provenance and selection criteria; `THIRD-PARTY-NOTICES.txt` records
  source licenses, including AgentHarm's restriction to improving AI safety
  and security. These cases contain potentially harmful actions and injected
  instructions as inert evaluation text: never execute them.
- `project.jsonl`: project-authored synthetic cases, starting with a
  task-relevant public Vault source lookup.

Run either set, or provide another TS-Bench-format JSONL file:

```bash
npm run eval:classifier:smoke -- --output /path/to/results/smoke.json
npm run eval:classifier:project -- --output /path/to/results/project.json
npm run eval:classifier -- --cases /path/to/cases.jsonl --model provider/model-id --output /path/to/results/run.json
```

`--model` is optional and defaults to OMP's active model. These commands make
model requests; `npm run check` does not. Keep real-session datasets and raw
result artifacts outside the repository: results include model responses and
can contain sensitive case content. Public cases must be synthetic or cleared
for redistribution and must not contain private data. These are development
sets, not a frozen holdout or a model leaderboard.

The report treats false allows, false denies and individual failures as
measurements, not exit-status thresholds. The harness uses the default
classifier prompt and timeout rather than local callgate guidance.

### Decision diff

`npm run decisions:diff` shows every decision your working tree makes differently from `HEAD`, for the same bash commands. A decision is blocked, asked, reviewed by a rule, fast-pathed (with the command as pinned), or left to the classifier. It prints each kind of change with a count and examples:

```text
synthetic: 111974 commands, 59 changed; fast path 22437 → 22436
      34  classifier → ask:git-overwrite-remote
            git branch -D x
       1  fast path → review:force-push (text-only)
            echo 'git push --force'
```

Every line should be one you meant. It exits with 1 when anything changed, like `diff`.

- `--base <revision>` compares with another revision (0.4.0 or later), checked out into a temporary git worktree. If a run is killed, `git worktree prune` clears the worktree it leaves registered.
- `--rules <file>` applies a user rules file on both sides.
- `--source synthetic` or `--source corpus` limits the commands; `--examples <n>` prints more of each.

The commands come from two sources:

- **synthetic**: a public list built from the program tables (`tests/decision-diff/synthetic.ts`). It covers every option in each spelling, unknown options, paths inside and outside the workspace, git under its global options, and some chains and rule triggers. Add a line there when you fix a case it missed.
- **corpus**: commands your own agents ran (see [Your own command corpus](#your-own-command-corpus)). These are private, so only their counts are printed; `--show-corpus` prints them for you to look at.

Both sides plan in the same temporary workspace, so the absolute fast-path numbers say little about your real projects; the changes are what count.

### Shell parser oracle

The bash fast path is only as safe as its reading of a command. `tests/shell-oracle/` checks that reading against bash itself. Bash runs every command the parser (`src/shell-syntax.ts`) accepts in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox: no network, no home directory, read-only system directories, and every program and builtin replaced by a recorder. Any difference in which commands run, their arguments or their file descriptors is reported. Rejecting a command is always allowed.

```bash
npm run oracle:shell -- --no-corpus           # hand-written cases and seeded fuzz
npm run oracle:shell -- --fuzz 20000 --seed 7 # more fuzz
npm run oracle:shell                          # and your corpus, if you have one
```

A divergence is a bug in the parser, never in bash. Add the command to `tests/shell-oracle/cases.ts`. The report shows only the start of each corpus command, since the full text is private.

### Program table oracles

The program tables (`config/default-rules.jsonc`, applied by `src/program-rules.ts`) claim that every option they list is read-only. `tests/program-oracle/` checks that claim against the implementations installed locally (GNU on most Linux systems). It builds random commands from the tables and runs each one the fast path accepts, pinned, under `strace` in a bubblewrap sandbox with a read-only workspace. Starting a program the plan did not pin, opening a file for writing, changing the filesystem, or reading outside the workspace and system directories is reported.

```bash
npm run oracle:programs -- --self-test           # each planted side effect must be caught
npm run oracle:programs -- --count 4000 --seed 2
npm run oracle:help                              # the tables against each program's --help
```

When adding an option, also check it against the program's documentation and, where they differ, against BSD and busybox: the tables must hold for whichever implementation is on `PATH`.

`oracle:help` reports three things:

- options the help does not mention;
- values the help shows differently;
- short and long options paired in one entry that the help does not pair.

A few reports are expected, where the help text is written loosely (`ls --sort`, `sort --check`, `du --time`, `jq --indent`).

### End-to-end under OMP

`npm run e2e:omp` runs scenarios against the real `omp` binary. Each scenario:

- installs your checkout as OMP's only extension;
- uses a temporary home, workspace, config, rules file and audit log;
- gives OMP a local fake model (`tests/omp-e2e/fake-model.ts`) that plays both the agent, replaying a fixed list of tool calls, and the classifier, with a fixed verdict.

The checks read the audit log, what the classifier was shown, and what the agent got back. This catches what the stub in `npm run check` cannot:

- OMP loading the extension and mapping its imports to OMP's bundled packages;
- the order in which OMP calls extension handlers;
- the arguments OMP's tools take;
- whether a denial reaches the agent.

```bash
npm run e2e:omp                   # every scenario, a few seconds
npm run e2e:omp -- --only block   # scenarios whose name contains "block"
npm run e2e:omp -- --keep         # keep the temporary directories to inspect
OMP=/path/to/omp npm run e2e:omp  # a specific OMP build
```

It needs no API key and makes no request beyond the local fake model. Point `OMP` at the real binary if your `omp` is a wrapper that needs a keyring or a login: the scenarios pass OMP only `PATH` and their own temporary paths, and stop at the first one where OMP never runs the extension. Prompts can't be answered in print mode, so `manual` asks are covered by the unit tests, and the model selector needs a manual look: run `/callgate model` in a real session.

To add a scenario, add an entry to `SCENARIOS` in `tests/omp-e2e/run.ts`: the reviewer, the classifier's verdict, the agent's tool calls, an optional rules file, and the checks. Make sure a check can fail: break the behaviour it covers once and watch it go red.

### Your own command corpus

Real agent commands make the best test input. `npm run oracle:corpus` collects the bash commands from your local Claude Code transcripts (`~/.claude/projects`), OMP sessions (`~/.omp/agent/sessions`) and Kimi Code sessions (`~/.kimi-code/sessions`). It writes them to `~/.cache/omp-callgate/shell-corpus.jsonl`, readable only by you. `--claude`, `--omp` and `--kimi` take other directories, and `--out` another file.

`oracle:shell` and `decisions:diff` read every `shell-corpus*.jsonl` in that directory. To add commands from another machine, run `npm run oracle:corpus -- --out shell-corpus-<host>.jsonl` there and copy the file next to yours.

The corpus holds whatever those commands contained: hostnames, paths, sometimes secrets. Never commit it, and never paste corpus commands or their reports into an issue or pull request. Report counts, or reduce a case to a synthetic command that shows the same problem.

## Pull requests

- Keep changes focused.
- Update the README, `docs/` or the example config when behaviour changes.
- Add or update tests for the decisions a change affects, and say which of steps 2 to 5 you ran.
- Don't commit local runtime files such as `config.jsonc` and `logs/`.

Don't include secrets, private logs, local model selections or real user paths in issues, pull requests, tests or fixtures. Use synthetic paths and redacted examples. For security problems, follow [SECURITY.md](SECURITY.md).
