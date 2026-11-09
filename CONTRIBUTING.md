# Contributing

Thanks for improving `omp-auto-approval`.

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
```

Run the OMP smoke regression:

```bash
npm run smoke:omp
```

### Shell parser oracle

The bash fast path is only as safe as its reading of a command. `tests/shell-oracle/` checks that reading against bash itself: for every command the parser (`src/shell-syntax.ts`) accepts, bash runs the same string in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox (no network, no home directory, read-only system directories) where every program and builtin is replaced by a recorder. Any difference in which commands run, their arguments, or their file descriptors is reported. Rejecting a command is always allowed. It needs `bwrap`, `bash` and coreutils on `PATH`.

```bash
npm run oracle:shell -- --no-corpus           # hand-written cases and seeded fuzz
npm run oracle:shell -- --fuzz 20000 --seed 7 # more fuzz
```

Real agent commands make the best test input. `npm run oracle:corpus` collects the bash commands from your local Claude Code transcripts and OMP sessions into `~/.cache/omp-auto-approval/shell-corpus.jsonl` (readable only by you), and `oracle:shell` picks it up from there, together with any other `shell-corpus*.jsonl` file in that directory, such as commands collected on another machine. Those commands can contain hostnames, paths, or secrets: never commit the corpus or paste its divergence reports publicly. The report shows only the start of each corpus command for that reason.

## Pull Requests

Before opening a PR:

- keep changes focused;
- update README or example config when behavior changes;
- add or update tests for approval-routing behavior;
- run `npm run check`;
- avoid committing local runtime files such as `config.jsonc`, `logs/`, `references/`, `pi/`, and `.DS_Store`.

## Security

Do not include secrets, private logs, local model selections, or real user paths in issues, PRs, tests, or fixtures. Use synthetic paths and redacted examples.

For security-sensitive reports, follow `SECURITY.md`.
