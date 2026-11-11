# Security policy

## Supported versions

Security fixes go into the latest release only.

## Reporting a vulnerability

Report privately through GitHub: the repository's **Security** tab, **Report a vulnerability**. Don't open a public issue with exploit details, secrets or private logs.

Include:

- the version or commit;
- the tool call or command, and the reviewer (`ai`, `manual` or `off`);
- what happened and what should have happened, with `/clearance explain` output where it helps;
- relevant audit log lines, with secrets and private paths removed.

## Scope

A vulnerability is anything that lets a tool call skip the review it should get. For example:

- a command, path or tool call that a fast path allows but should not (see [docs/fast-paths.md](docs/fast-paths.md));
- a command that a block or ask rule should catch but doesn't, without help from a script the agent wrote first;
- a way to make an allowed command run something other than what was checked, such as a program found through a changed PATH;
- text in the conversation that the classifier takes as your authorization when it isn't;
- leaks of configuration, audit logs, or tool output to the classifier's provider.

Known limits are listed under [Limits](README.md#limits) in the README; a report that one of them can be exploited is still welcome if it shows a cheap fix.
