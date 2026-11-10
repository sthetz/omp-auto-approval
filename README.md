# omp-clearance

An [OMP](https://github.com/can1357/oh-my-pi) extension that decides, for every tool call the agent makes, whether it runs without asking, goes to an AI classifier, needs your approval, or is blocked.

- **Fast paths** let routine work through at once: reads and writes inside the workspace, and read-only shell commands such as `git status`, `grep -rn TODO src` or `ls | wc -l`, checked option by option.
- **Command rules** stop what should never happen without you: a forced `git push` is blocked, `sudo` asks you, `terraform apply` goes to review. You can add your own.
- **The classifier**, inspired by Claude Code auto mode and Codex Auto-review, judges everything else against what you asked for in the conversation. In `fallback` mode you decide when it says no; in `auto` mode its no is final.

## Limits

- **It is not a sandbox.** An allowed command runs with your permissions. Fast paths and rules read commands as text, conservatively: what they cannot read exactly goes to review, but a determined agent can still hide a command from a rule, for example in a script it writes first.
- **The classifier is a model.** It can be wrong, and it reads text the agent wrote, though [it treats that text as untrusted](#the-classifier). `fallback` keeps you in the loop for every no; `auto` trusts every yes.
- **Only OMP is supported.** The extension loads OMP's own packages, and its fast paths know OMP's tools.

## Installation

```bash
omp plugin install https://github.com/sthetz/omp-clearance
# or a pinned release:
omp plugin install github:sthetz/omp-clearance#v0.4.1
```

Restart OMP, then turn it on in the recommended mode:

```text
/clearance fallback
```

To remove it: `omp plugin uninstall omp-clearance`.

OMP's own `tools.approvalMode` setting runs after this extension has allowed a call. Its default, `yolo`, adds no prompts; with `always-ask`, `always-ask-cached` or `write`, OMP still asks you about calls this extension already allowed.

Don't run omp-clearance alongside pi-auto-approval or omp-auto-approval: each reviews every tool call on its own.

**Upgrading from omp-auto-approval.** Before 0.4.0 this project was called omp-auto-approval. Uninstall it (`omp plugin uninstall omp-auto-approval`), rename the environment variables `PI_AUTO_APPROVAL_CONFIG_PATH`, `PI_AUTO_APPROVAL_RULES_PATH` and `PI_AUTO_APPROVAL_LOGS_DIR` to `CLEARANCE_CONFIG_PATH`, `CLEARANCE_RULES_PATH` and `CLEARANCE_LOGS_DIR`, and move `config.jsonc` and `rules.jsonc` along if they lived in the old extension directory. The command is now `/clearance`, and the audit log is written to `omp-clearance.jsonl`. The old `safeCommandAllowlist` and `blockCommands` settings are no longer read: write them as [allow and block rules](docs/command-rules.md#allow-review-ask-and-block-rules). Delete `"classifierTimeoutSeconds": 90` if your config has it: versions before 0.3.0 wrote it there, and it is no longer read as 25, so OMP's 30 s limit would stop the classifier first.

## Modes

| Mode | Fast paths and rules | When the classifier says no, fails or times out |
| --- | --- | --- |
| `off` | not used | OMP behaves as if the extension weren't installed. |
| `fallback` | used | You are asked. Recommended for interactive use. |
| `auto` | used | The call is denied. Ask rules deny too. For trusted, unattended runs only. |

When you are asked, the prompt shows the action, the classifier's reason or the rule's, and offers:

- **Allow Once**;
- **Allow Always This Exact Action**, for the rest of the session;
- **Reject**, or **Reject With Reason**, which is shown to the agent;
- **Reject and Stop the Turn**.

The cursor starts on **Reject**, and no answer within `approvalTimeoutSeconds` (default 30) rejects.

While the extension is on, a short note in the system prompt asks the agent to report a blocked call to you instead of retrying it in another form. If it keeps trying anyway, an automatic denial that makes `maxConsecutiveDenials` denials in a row (default 3, counting your rejections) also ends the agent's turn.

## Commands

`/clearance` is the only slash command; type `/clearance ` with a trailing space to see its arguments.

| Command | Effect |
| --- | --- |
| `/clearance off`, `fallback`, `auto` | Switch mode. |
| `/clearance status` | Mode, classifier model, config, rules and audit log paths, and any problems with them. |
| `/clearance model` | Choose the classifier model. `/clearance model current` uses the session's model. |
| `/clearance rules [program \| rule id]` | List the command rules in use and the file each comes from, or show one. |
| `/clearance explain <tool> [args]` | Show what would happen to a tool call, without running it. `args` is a path, a JSON object, or a bash command: `/clearance explain read ~/.ssh/id_ed25519`, `/clearance explain ls -la`. |

## How a tool call is decided

The first row that applies decides. `/clearance explain` shows which one a given call would hit, and the audit log records it as `route`; when you are asked, the log records your answer with route `human`.

| | When | What happens | `route` |
| --- | --- | --- | --- |
| 1 | The extension is off | OMP decides as usual | |
| 2 | A bash command matches a **block** rule | Denied, without asking anyone | `blocked_command` |
| 3 | A bash command matches an **ask** rule, or any bash command while the rules files have an error | You are asked, without the classifier, unless you already chose "Allow Always This Exact Action" for it; denied in `auto` mode or without a UI | `ask_rule` |
| 4 | OMP's own `todo` or `wait`, or an `ask` form with no links | Allowed | `local_state`, `ui_only` |
| 5 | The tool is listed in `reviewExemptTools` | Allowed | `tool_allowlist` |
| 6 | A read inside the workspace or `readRoots`, or a write inside the workspace, that touches no sensitive path | Allowed | `readonly`, `workspace_write` |
| 7 | A tool that needs a human: computer use, browser clicks and typing, plugin installs, MCP or permission settings | You are asked; denied in `auto` mode | `manual_only` |
| 8 | A bash command made only of read-only programs, or ones your allow rules name | Allowed, with every program run by its absolute path | `safe_command` |
| 9 | You chose "Allow Always This Exact Action" for this exact call earlier | Allowed | `session_approval` |
| 10 | The classifier already judged this exact call in this session | Its earlier answer is reused; a no still goes to you in `fallback` mode | `classifier_cache` |
| 11 | Anything else | The classifier decides; see [Modes](#modes) for a no | `classifier` |

A bash command that matches a **review** rule skips rows 5 and 8. Row 8 is also skipped for the rest of a session once a bash command may have changed how the shell runs later commands, as a `trap` or an `eval` can ([details](docs/fast-paths.md#when-the-bash-fast-path-turns-off)).

What each fast path accepts, in full: [docs/fast-paths.md](docs/fast-paths.md).

## Command rules

Bash commands are checked against rules before anything else. The built-in ones are in [`config/default-rules.jsonc`](config/default-rules.jsonc): tables of read-only programs and their options, and the rules below. Your own go in `rules.jsonc` next to `config.jsonc`, or at `CLEARANCE_RULES_PATH`:

```jsonc
{
  "rules": [
    { "id": "npm-test", "prefix": "npm test", "outcome": "allow" },
    { "id": "kube-interactive", "match": "kubectl exec|port-forward|edit|apply", "outcome": "ask",
      "why": "Changes the cluster." },
    { "id": "no-prod-db", "match": "psql *prod*", "outcome": "block" }
  ],
  "disable": ["infrastructure"]
}
```

- `allow` lets a command that starts with `prefix` through without review, unless it uses an option that runs programs or writes files, or names a path outside the workspace.
- `review` always sends it to the classifier.
- `ask` asks you directly, without the classifier.
- `block` denies it outright.

The most restrictive matching rule wins, and `why` is shown in the denial, in the prompt, and to the classifier. Patterns match commands as bash reads them, so `git push --force` matches `cd repo && git push origin main --force` and `bash -c "git push --force"`, while a commit message that mentions it is only sent to review. Rules are a tripwire, not a sandbox: a script or an alias can get past them, and is then reviewed as usual.

[`config/rules.example.jsonc`](config/rules.example.jsonc) is a commented example. It adds a table for `kubectl get`, `describe` and `logs` that leaves out secrets, and changes some built-in entries. [docs/command-rules.md](docs/command-rules.md) is the full format, including pattern syntax and program tables.

If a rules file has an error, no rules are used. Since it might have held block or ask rules, every bash command then asks you first until the file is fixed (and is denied in `auto` mode), and OMP shows the error at session start. There are no per-project rules files, since a cloned repository could ship one.

### Built-in rules

These cover commands that are rarely right for an agent to run on its own, in any kind of terminal work:

| id | outcome | matches |
| --- | --- | --- |
| `force-push` | block | `git push --force`, `-f`, `+branch` |
| `rm-root-or-home` | block | `rm -r` of `/`, `/*`, `~` or `$HOME`; `rm --no-preserve-root` |
| `format-disk` | block | `mkfs*`, `wipefs`, `dd of=/dev/sd*` and other disk devices |
| `pipe-to-shell` | ask | `curl …` or `wget …` piped to a shell |
| `git-discard` | ask | `git reset --hard`, `git clean -f`, `git checkout .`, `git restore .`, `git stash drop`/`clear` |
| `git-overwrite-remote` | ask | `git push --force-with-lease`, `--delete`, `:branch`; `git branch -D` |
| `privilege` | ask | `sudo`, `doas`, `su`, `pkexec` |
| `publish` | ask | `npm`/`pnpm`/`yarn`/`bun publish`, `cargo publish`, `twine upload`, `poetry`/`uv publish`, `gem push`, `docker`/`podman push`, `gh release create`, … |
| `power` | ask | `shutdown`, `reboot`, `poweroff`, `halt`, `systemctl reboot` and the like |
| `database-drop` | ask | `DROP` or `TRUNCATE` of a database, schema or table through `psql`, `mysql`, `sqlite3`, … |
| `infrastructure` | review | `terraform`/`tofu apply`/`destroy`, `pulumi up`/`destroy`, `kubectl delete`/`drain`, `helm uninstall` |

`infrastructure` is reviewed rather than asked about, since infrastructure work runs these often and the classifier can judge them from the conversation. To change a built-in rule, disable it and add your own: `"disable": ["infrastructure"], "rules": [{ "id": "infrastructure-ask", "match": "kubectl delete|drain", "outcome": "ask" }]`.

## Other tools

- `web_search` is always reviewed: its query goes to a third party and could carry data out of the session.
- `eval` and `task` are always reviewed: `eval` runs code, and `task` hands work to subagents with every tool.
- An `ask` form skips review only in an interactive session and when it contains no links, since OMP fetches images in it.
- Tools are trusted by name only when OMP reports them as its own. An extension or MCP tool named `read` is reviewed, and self-declared read-only hints are ignored.
- `reviewExemptTools` in `config.jsonc` lets more tools through without any review, including tools that would otherwise need a human. Names are case-insensitive; list only tools you are happy to run unchecked. Review, ask and block rules still apply to `bash` when it is listed.

## The classifier

By default the classifier uses the session's model; `/clearance model` picks another, saved as `classifierModel`. Requests go through OMP's own model client, with the provider auth OMP has for that model, and carry no headers of their own.

The classifier sees:

- the latest user request and up to six earlier user messages;
- the agent's latest message, marked as untrusted;
- the pending action, and the rule that sent it to review, if any.

It does not see tool output (file contents, command output, fetched pages), since that is where prompt injections come from. Only your own messages can authorize anything. Messages that OMP puts in the user role on someone else's behalf are not yours: a subagent's assignment, compaction and branch summaries, messages from other agents, MCP notices. The classifier sees the latest of them separately, marked as untrusted; otherwise an agent could write "the user approved this" into a `task` assignment. A subagent's classifier reads your messages from the parent session's file; with `--no-session` there is none, so only low-risk actions pass.

An answer that allows a `high`-risk action without `high` user authorization, or a `critical` one without it at all, counts as a denial. `allow`, `deny` and `environment` in `config.jsonc` add your own guidance to its prompt; they are advice to the classifier, not rules.

**Timeout.** OMP blocks a tool call outright when an extension takes longer than `extensionHandlers.toolCallTimeoutMs` (30 s by default) to decide, even in `fallback` mode. `classifierTimeoutSeconds` (default 25) stops the classifier first, so that `fallback` can still ask you. For a slower classifier model, raise both, keeping `classifierTimeoutSeconds` below OMP's limit; `/clearance status` warns when it is 30 or more. According to OMP's description of the setting, time spent in its own dialogs, such as the approval prompt, doesn't count.

## Configuration

`config.jsonc` lives in the extension's directory, or at `CLEARANCE_CONFIG_PATH`. Only values that differ from the defaults are saved, so later changes to defaults take effect. `/clearance status` reports unknown keys. See the [schema](schemas/config.schema.json) and an [annotated example](config/config.example.jsonc).

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled`, `mode` | `false`, `"fallback"` | Set by `/clearance off`, `fallback`, `auto`. |
| `classifierModel` | `null` | `provider/model`, or `null` for the session's model. |
| `classifierTimeoutSeconds` | `25` | See [the classifier](#the-classifier). |
| `approvalTimeoutSeconds` | `30` | How long the approval prompt waits before rejecting. |
| `maxConsecutiveDenials` | `3` | Automatic denials in a row before the turn is stopped. |
| `readRoots` | `[]` | Directories outside the workspace that may be read without review. |
| `reviewExemptTools` | `[]` | Tools that skip review entirely. |
| `allow`, `deny` | `[]` | Guidance lines for the classifier. |
| `environment` | `""` | A description of your environment for the classifier. |
| `audit` | `true` | Write the audit log. |

`readRoots` saves a classifier call for reads of things like dependency sources:

```json
{ "readRoots": ["/nix/store", "~/.cargo/registry", "~/go/pkg/mod"] }
```

Entries are absolute or start with `~/`. Credential-like files below a read root are still reviewed. Read roots also cover the files a fast-pathed bash command reads, but never add a program to the fast path.

## Audit log

Every decision is appended as a line of JSON to `logs/omp-clearance.jsonl` in the extension's directory, or in `CLEARANCE_LOGS_DIR`. Each line has:

- `route` and `outcome`;
- the tool, a summary of the action and its hash;
- the classifier's decision, your answer, or the reason for a denial;
- the rule that decided (`ruleId`, `ruleSource`), or for a fast-pathed command the entries that let it through (`ruleIds`);
- the command as actually run, if pinning rewrote it (`pinnedCommand`, `pinnedCwd`).

A `shell_latch` event records when the bash fast path turned off for a session. The log holds the commands and paths your agent used, so treat it as private.

## Development

`npm run check` runs the type check, the tests and a smoke test. [CONTRIBUTING.md](CONTRIBUTING.md#the-development-cycle) describes the full cycle a change goes through: a diff of every decision it changes, oracles that check the shell parser against bash and the program tables against the programs themselves, and end-to-end runs against the real OMP binary.

## Origins and license

omp-clearance began as a fork of [pi-auto-approval](https://github.com/Europa2061/pi-auto-approval), by way of HayabusaC's OMP adaptation, published on npm as [`omp-auto-approval@0.1.0`](https://www.npmjs.com/package/omp-auto-approval/v/0.1.0) (its source repository is no longer public). It was restored from that package, rewritten for the most part, and renamed in 0.4.0. It is not affiliated with either project; the `omp-auto-approval` package on npm is HayabusaC's original. Licensed under [Apache-2.0](LICENSE), like both; the git history records each author's commits.
