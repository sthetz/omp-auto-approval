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
