# Contributing

Thanks for improving `omp-clearance`.

## Development

Install dependencies:

```bash
npm install
```

Run every check (type check, tests, and a smoke test that loads the extension through a stub of OMP's extension API):

```bash
npm run check
```

There is no build step: OMP loads the TypeScript sources directly.

### Shell parser oracle

The bash fast path is only as safe as its reading of a command. `tests/shell-oracle/` checks that reading against bash itself: for every command the parser (`src/shell-syntax.ts`) accepts, bash runs the same string in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox (no network, no home directory, read-only system directories) where every program and builtin is replaced by a recorder. Any difference in which commands run, their arguments, or their file descriptors is reported. Rejecting a command is always allowed. It needs `bwrap`, `bash` and coreutils on `PATH`.

```bash
npm run oracle:shell -- --no-corpus           # hand-written cases and seeded fuzz
npm run oracle:shell -- --fuzz 20000 --seed 7 # more fuzz
```

Real agent commands make the best test input. `npm run oracle:corpus` collects the bash commands from your local Claude Code transcripts and OMP sessions into `~/.cache/omp-clearance/shell-corpus.jsonl` (readable only by you), and `oracle:shell` picks it up from there, together with any other `shell-corpus*.jsonl` file in that directory, such as commands collected on another machine. Those commands can contain hostnames, paths, or secrets: never commit the corpus or paste its divergence reports publicly. The report shows only the start of each corpus command for that reason.

### Program table oracle

The built-in command rules (`config/default-rules.jsonc`, applied by `src/program-rules.ts`) claim that every option they list is read-only. `tests/program-oracle/` checks that claim: it builds random commands from the tables, and runs each one the fast path accepts, pinned, under `strace` in a bubblewrap sandbox with a read-only workspace. Starting a program the plan did not pin, opening a file for writing, changing the filesystem, or reading outside the workspace and system directories is reported. It needs `bwrap`, `strace` and `bash` on `PATH`, and checks the implementations installed locally (GNU on most Linux systems).

```bash
npm run oracle:programs -- --self-test          # each planted side effect must be caught
npm run oracle:programs -- --count 4000 --seed 2
```

When adding an option, also check it against the program's `--help` and, where it differs, against BSD and busybox: the tables must hold for whichever implementation is on `PATH`. `npm run oracle:help` compares every table with the local programs' `--help`: options the help does not mention, values the help shows differently, and short and long options paired in one entry that the help does not pair. A few reports are expected, where the help text is written loosely (`ls --sort`, `sort --check`, `du --time`, `jq --indent`).

`config/default-rules.jsonc` is validated strictly when it loads: an unknown key, kind or check name, or an option listed twice, is an error, and then every bash command asks the user first (denied in auto mode) and `/clearance status` says why. `npm test` loads it, and checks `schemas/rules.schema.json` against the code.

## Pull Requests

Before opening a PR:

- keep changes focused;
- update the README, `docs/` or the example config when behavior changes;
- add or update tests for approval-routing behavior;
- run `npm run check`;
- avoid committing local runtime files such as `config.jsonc` and `logs/`.

## Security

Do not include secrets, private logs, local model selections, or real user paths in issues, PRs, tests, or fixtures. Use synthetic paths and redacted examples.

For security-sensitive reports, follow `SECURITY.md`.
