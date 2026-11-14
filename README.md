# omp-callgate

An [OMP](https://github.com/can1357/oh-my-pi) extension that decides, for every tool call the agent makes, whether it runs without asking, goes to an AI classifier, needs your approval, or is blocked.

- **Fast paths** let routine work through at once: reads and writes inside the workspace, and read-only shell commands such as `git status`, `grep -rn TODO src` or `ls | wc -l`, checked option by option.
- **Command rules** stop what should never happen without you: a forced `git push` is blocked, `sudo` asks you, `terraform apply` goes to review. You can add your own.
- **The classifier**, inspired by Claude Code auto mode and Codex Auto-review, judges review outcomes against what you asked for in the conversation when the reviewer is `ai`. The `manual` reviewer asks you directly; `off` lets review outcomes run without a classifier.

## Limits

- **It is not a sandbox.** An allowed command runs with your permissions. Fast paths and rules read commands as text, conservatively: what they cannot read exactly goes to review, but a determined agent can still hide a command from a rule, for example in a script it writes first.
- **The classifier is a model.** It can be wrong, and it reads text the agent wrote, though [it treats that text as untrusted](#the-classifier). `manual` asks you about every review outcome without calling the classifier; `ai` trusts its allow verdicts.
- **Only OMP is supported.** The extension loads OMP's own packages, and its fast paths know OMP's tools.

## Installation

```bash
omp plugin install https://github.com/sthetz/omp-callgate
```

Restart OMP, then choose the reviewer recommended for interactive use (the default is `off`):

```text
/callgate ai
```

To remove it: `omp plugin uninstall omp-callgate`.

OMP's own `tools.approvalMode` setting runs after this extension has allowed a call. Its default, `yolo`, adds no prompts; with `always-ask`, `always-ask-cached` or `write`, OMP still asks you about calls this extension already allowed.

Don't run omp-callgate alongside pi-auto-approval or omp-auto-approval: each reviews every tool call on its own.

## Reviewers

The reviewer is the only thing that changes between modes. Fast paths, allow and review rules, ask rules, blocks, the denial counter and the shell latch are active in all three.

| Reviewer | A `review` outcome, including an unmatched call | If the classifier fails or times out |
| --- | --- | --- |
| `off` | Runs without a classifier. Default. | The classifier is not called. |
| `manual` | You approve every review outcome without an LLM. | The classifier is not called. |
| `ai` | The classifier decides: allow runs; deny goes back to the agent. Recommended for interactive use. | You are asked when a UI is available; otherwise the call is denied. |

Ask rules and manual-only tools still ask you under `off` and `ai`. Any approval prompt that cannot be shown because no UI is available becomes a denial. Block rules and broken-rules blocks always deny without asking.

The reviewer is shared by every OMP session and subagent. `/callgate ai`, `manual` or `off` writes `reviewer-state.json` next to `config.jsonc`, never the config itself, and running sessions notice the change on their next tool call. The config's `reviewer` key is only the starting value while that state file does not exist. Old `enabled` and `mode` keys produce a notice and are not migrated.

When you are asked, the prompt shows the action, the classifier's reason or the rule's, and offers:

- **Allow Once**;
- **Allow Always This Exact Action**, for the rest of the session;
- **Reject**, or **Reject With Reason**, which is shown to the agent;
- **Reject and Stop the Turn**.

The cursor starts on **Reject**, and no answer within `approvalTimeoutSeconds` (default 30) rejects.

Supplied text in approval prompts is quoted, with terminal controls, Unicode format controls (including direction overrides), and line separators shown as literal escapes. Filenames and commands retain visible `\n`, `\r` and `\t` rather than having them collapsed into spaces. Long fields are bounded and marked `[truncated]`. This formatting is display-only: execution arguments, classifier inputs, and exact-action approval hashes are unchanged.

A short note in the system prompt asks the agent to report a blocked call to you instead of retrying it in another form. Calls that run normally reset the consecutive denial count; your rejections and automatic denials increment it, and switching reviewers does not reset it. At `maxConsecutiveDenials` (default 3), an `ai` classifier denial shows you the approval prompt with the classifier's reason when a UI is available. Any other automatic denial at the threshold stops the turn; ordinary user rejections only increment the counter.

Optional OMP QA reporting is an exception to stopping, not to authorization. A denied builtin `write` to exactly `xd://report_issue` stays blocked and audited, but the agent is instructed to continue your task and mention the skipped report and its reason in the final response. Reporting must not be retried, including through another mechanism, unless you explicitly authorize it. These reporting calls neither increment nor reset the denial counter and do not trigger the classifier-denial threshold prompt. An explicit **Reject and Stop the Turn** still stops the turn.

## Commands

`/callgate` is the only slash command; type `/callgate ` with a trailing space to see its arguments.

| Command | Effect |
| --- | --- |
| `/callgate off`, `manual`, `ai` | Switch the shared reviewer, writing `reviewer-state.json` rather than `config.jsonc`. |
| `/callgate status` | Reviewer, classifier model, config and reviewer-state paths, rules and audit log paths, and any problems with them. |
| `/callgate model` | Choose the classifier model. `/callgate model current` uses the session's model. |
| `/callgate rules [program \| rule id]` | List the command rules in use and the file each comes from, or show one. |
| `/callgate explain <tool> [args]` | Show what would happen to a tool call, without running it. `args` is a path, a JSON object, or a bash command: `/callgate explain read ~/.ssh/id_ed25519`, `/callgate explain ls -la`. |

## How a tool call is decided

The first row that applies decides. `/callgate explain` runs the same decision function and prints its selected route; the audit log records that route. When you are asked, the log records your answer with route `human`.

| | When | What happens | `route` |
| --- | --- | --- | --- |
| 1 | Any default, user or included rules file is broken | Every bash call is denied, in every reviewer mode; other tools continue | `blocked_command` |
| 2 | A bash command matches a **block** rule | Denied, without asking anyone | `blocked_command` |
| 3 | A bash command matches an **ask** rule | You are asked, without the classifier, unless you already chose "Allow Always This Exact Action" for it; denied without a UI | `ask_rule` |
| 4 | OMP's own `todo` or `wait`, or an `ask` form with no links | Allowed | `local_state`, `ui_only` |
| 5 | The tool is listed in `reviewExemptTools` | Allowed | `tool_allowlist` |
| 6 | A read inside the workspace or `readRoots`, a write inside the workspace, or a language server query, edit preview or previewed rename, that touches no sensitive path; a `write` to `xd://lsp`, whose `lsp` call is decided on its own | Allowed | `readonly`, `workspace_write`, `lsp_read`, `lsp_edit`, `lsp_dispatch` |
| 7 | A tool that needs a human: computer use, browser clicks and typing, plugin installs, MCP or permission settings | You are asked in every reviewer mode; denied without a UI | `manual_only` |
| 8 | A bash command made only of read-only programs, or ones your allow rules name | Allowed, with every program run by its absolute path | `safe_command` |
| 9 | You chose "Allow Always This Exact Action" for this exact call earlier | Allowed | `session_approval` |
| 10 | Under `ai`, the classifier already judged this exact call in this session, and you have written nothing since | Its earlier answer is reused | `classifier_cache` |
| 11 | Anything else, including a **review** rule | Handled by the reviewer: run under `off`, ask under `manual`, classify under `ai` | `reviewer_off`, `human`, `manual_unavailable`, `classifier` |

A bash command that matches a **review** rule skips rows 5 and 8. Row 8 is also skipped for the rest of a session once a bash command may have changed how the shell runs later commands, as a `trap` or an `eval` can ([details](docs/fast-paths.md#when-the-bash-fast-path-turns-off)).

What each fast path accepts, in full: [docs/fast-paths.md](docs/fast-paths.md).

## Command rules

Bash commands are checked against rules before anything else. The built-in ones are in [`config/default-rules.jsonc`](config/default-rules.jsonc): tables of read-only programs and their options, and the rules below. Your own go in `rules.jsonc` next to `config.jsonc`, or at `CALLGATE_RULES_PATH`:

```jsonc
{
  "rules": [
    { "id": "project-tests", "prefix": "python -m pytest", "outcome": "allow" },
    { "id": "kube-interactive", "match": "kubectl exec|port-forward|edit|apply", "outcome": "ask",
      "why": "Changes the cluster." },
    { "id": "no-prod-db", "match": "psql *prod*", "outcome": "block" }
  ],
  "disable": ["infrastructure"]
}
```

- `allow` lets a command that starts with `prefix` through without review, unless it uses an option that runs programs or writes files, or names a path outside the workspace.
- `review` sends it to the session reviewer, never a fast path.
- `ask` asks you directly, without the classifier.
- `block` denies it outright.

The most restrictive matching rule wins, and `why` is shown in the denial, in the prompt, and to the classifier. Patterns match commands as bash reads them, so `git push --force` matches `cd repo && git push origin main --force` and `bash -c "git push --force"`, while a commit message that mentions it is only sent to review. Rules are a tripwire, not a sandbox: a script or an alias can get past them, and is then reviewed as usual.

[`config/rules.example.jsonc`](config/rules.example.jsonc) is a commented example of the format: a table for `docker ps`, `images` and `logs`, rules by words, glob and regex, and changes to built-in entries. [`config/examples/`](config/examples) holds ready-made policies to include, such as [`kubectl.jsonc`](config/examples/kubectl.jsonc), which lets reads through, sends changes to review, asks before deletes and drains, and blocks deleting namespaces. [docs/command-rules.md](docs/command-rules.md) is the full format, including pattern syntax and program tables.

If any default, user or included rules file has an error, no rules are used. Since it might have held block or ask rules, every bash call is then blocked in every reviewer mode, including `off`; other tools are unaffected. OMP emits an error notification, shows a red status entry, and includes the file and location in the block reason. The files are checked on every tool call, so fixing one reloads it automatically and emits a recovery notification. There are no per-project rules files, since a cloned repository could ship one.

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
| `npm-install` | ask | npm installs/CI, updates, removals, rebuilds, dedupe, prune, link, shrinkwrap and `audit fix`, including aliases |
| `npm-exec` | ask | `npx`; npm exec/init, scripts and lifecycle commands, pack/version, editors, help viewers and browser launchers |
| `publish` | ask | `npm`/`pnpm`/`yarn`/`bun publish`, `cargo publish`, `twine upload`, `poetry`/`uv publish`, `gem push`, `docker`/`podman push`, `gh release create`, … |
| `power` | ask | `shutdown`, `reboot`, `poweroff`, `halt`, `systemctl reboot` and the like |
| `database-drop` | ask | `DROP` or `TRUNCATE` of a database, schema or table through `psql`, `mysql`, `sqlite3`, … |
| `infrastructure` | review | `terraform`/`tofu apply`/`destroy`, `pulumi up`/`destroy`, `kubectl delete`/`drain`, `helm uninstall` |

`infrastructure` is reviewed rather than asked about, since infrastructure work runs these often and the session reviewer can judge it in context. To change a built-in rule, disable it and add your own: `"disable": ["infrastructure"], "rules": [{ "id": "infrastructure-ask", "match": "kubectl delete|drain", "outcome": "ask" }]`.

The npm rules ask even with `--ignore-scripts`, `--offline`, `--dry-run`, a global install or a temporary `--prefix`. An allow prefix such as `npm test`, an AI allow, reviewer `off`, or a bash exemption cannot override them. Explicit exact-action session approvals still work; these are ordinary ask rules, not once-only confirmation floors. To choose a different policy, disable the relevant rule and supply your own. Exactly `npm --version` and `npm -v`, plus bounded local `npm prefix`, `npm root` and `npm pkg get` queries, have [fast paths](docs/fast-paths.md#npm); other informational npm calls remain with the reviewer. These new rules cover npm and npx, not every package manager.

## Other tools

- `web_search` is always reviewed: its query goes to a third party and could carry data out of the session.
- `eval` and `task` are always reviewed: `eval` runs code, and `task` hands work to subagents with every tool.
- An `ask` form skips review only in an interactive session and when it contains no links, since OMP fetches images in it.
- Tools are trusted by name only when OMP reports them as its own. An extension or MCP tool named `read` is reviewed, and self-declared read-only hints are ignored.
- `reviewExemptTools` in `config.jsonc` lets more tools through without any review, including tools that would otherwise need a human. Names are case-insensitive; list only tools you are happy to run unchecked. Review, ask and block rules still apply to `bash` when it is listed.

## The classifier

By default the classifier uses the session's model; `/callgate model` picks another, saved as `classifierModel`. Requests go through OMP's own model client, with the provider auth OMP has for that model, and carry no headers of their own.

The classifier sees:

- the latest user request and up to six earlier user messages, from anywhere in the session, however much the agent has done since;
- the agent's latest message, marked as untrusted;
- the pending action, and the rule that sent it to review, if any.

A verdict is reused for the same action until you write something new, steering messages sent mid-turn included: the next attempt is then reviewed again with your new message. So is it after a change to the classifier's settings (`classifierModel`, `allow`, `deny`, `environment`) or to your rules files. Nothing the agent writes, and no tool output, makes it review again.

It does not see tool output (file contents, command output, fetched pages), since that is where prompt injections come from. Only your own messages can authorize anything. Messages that OMP puts in the user role on someone else's behalf are not yours: a subagent's assignment, compaction and branch summaries, messages from other agents, MCP notices. The classifier sees the latest of them separately, marked as untrusted; otherwise an agent could write "the user approved this" into a `task` assignment. A subagent's classifier reads your messages from the parent session's file; with `--no-session` there is none, so only low-risk actions pass.

The classifier is instructed to treat task-relevant public source and documentation lookups as potentially low risk when they appear read-only, use a recognizable public source, and do not send sensitive information. It is also instructed to be cautious about unclear destinations, redirects and authenticated requests. This is model guidance, not a host allowlist or a guarantee about network requests.

An answer that allows a `high`-risk action without `high` user authorization, or a `critical` one without it at all, counts as a denial. `allow`, `deny` and `environment` in `config.jsonc` add your own guidance to its prompt; they are advice to the classifier, not rules.

**Timeout.** OMP blocks a tool call outright when an extension takes longer than `extensionHandlers.toolCallTimeoutMs` (30 s by default) to decide. Under `ai`, `classifierTimeoutSeconds` (default 25) stops the classifier first, so its failure can still ask you when a UI is available. For a slower classifier model, raise both, keeping `classifierTimeoutSeconds` below OMP's limit; `/callgate status` warns when it is 30 or more. According to OMP's description of the setting, time spent in its own dialogs, such as the approval prompt, doesn't count.

## Configuration

`config.jsonc` lives in the extension's directory, or at `CALLGATE_CONFIG_PATH`. Only values that differ from the defaults are saved, so later changes to defaults take effect. `/callgate status` reports unknown keys. The shared `reviewer-state.json` beside it holds the current reviewer and is re-read on change; `reviewer` in config applies only while no state file exists. See the [schema](schemas/config.schema.json) and an [annotated example](config/config.example.jsonc).

| Key | Default | Meaning |
| --- | --- | --- |
| `reviewer` | `"off"` | Starting reviewer (`"ai"`, `"manual"` or `"off"`) while `reviewer-state.json` does not exist. |
| `classifierModel` | `null` | `provider/model`, or `null` for the session's model. |
| `classifierTimeoutSeconds` | `25` | See [the classifier](#the-classifier). |
| `approvalTimeoutSeconds` | `30` | How long the approval prompt waits before rejecting. |
| `maxConsecutiveDenials` | `3` | Consecutive denials before the classifier prompt or turn stop described under [Reviewers](#reviewers). |
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

Changes to `config.jsonc` apply from the next session, or after any `/callgate` command, such as `/callgate status`.

## Audit log

Every decision is appended as a line of JSON to `logs/omp-callgate.jsonl` in the extension's directory, or in `CALLGATE_LOGS_DIR`. Each line has:

- `route` and `outcome`;
- the tool, a summary of the action and its hash;
- the classifier's decision, your answer, or the reason for a denial;
- the rule that decided (`ruleId`, `ruleSource`), or for a fast-pathed command the entries that let it through (`ruleIds`);
- the command as actually run, if pinning rewrote it (`pinnedCommand`, `pinnedCwd`).

A `shell_latch` event records when the bash fast path turned off for a session, and a `result_withheld` event an `lsp` result the agent did not see because it showed source lines from a file it may not read without review ([details](docs/fast-paths.md#language-server-queries)), and an `lsp_edit_mismatch` event a previewed rename whose result changed more than its preview listed. The log holds the commands and paths your agent used, so treat it as private.

## Development

`npm run check` runs the type check, the tests and a smoke test. [CONTRIBUTING.md](CONTRIBUTING.md#the-development-cycle) describes the full cycle a change goes through: a diff of every decision it changes, oracles that check the shell parser against bash and the program tables against the programs themselves, and end-to-end runs against the real OMP binary.

## Origins and license

omp-callgate began as a fork of [pi-auto-approval](https://github.com/Europa2061/pi-auto-approval), by way of HayabusaC's OMP adaptation, published on npm as [`omp-auto-approval@0.1.0`](https://www.npmjs.com/package/omp-auto-approval/v/0.1.0) (its source repository is no longer public). It was restored from that package, rewritten for the most part, and renamed to omp-clearance in 0.4.0 before becoming omp-callgate. It is not affiliated with either project; the `omp-auto-approval` package on npm is HayabusaC's original. Licensed under [Apache-2.0](LICENSE), like both; the git history records each author's commits.
