# Fast paths

A fast path allows a tool call at once, without the classifier or you. Each is deliberately narrow: anything it cannot read exactly, or that touches a sensitive path, goes to review instead. This page lists what each one accepts; the [README](../README.md#how-a-tool-call-is-decided) shows where they sit among the other checks, and `/clearance explain` shows which one a given call would take.

There are four: [workspace reads](#workspace-reads), [workspace writes](#workspace-writes), [language server queries](#language-server-queries) and [safe bash commands](#safe-bash-commands).

## Workspace reads

The host's own read-only tools (`read`, `grep`, `find`, `glob`, `ast_grep`, `ls`, …) when every path they name is inside the working directory or a `readRoots` directory (after resolving symlinks) and is not credential-like. These always go to the session reviewer:

- paths outside the working directory and `readRoots`;
- URLs (`http(s)://`, `www.`) and remote or sensitive internal URLs (`ssh://`, `mcp://`, `pr://`, `issue://`, `mr://`, `vault://`, `cfg://`, `proc://`, …). Only session-local URLs (`skill://`, `rule://`, `agent://`, `artifact://`, `memory://`, `local://`, `omp://`) skip review;
- credential-like files and directories anywhere in the tree: `.env` and `.env.*` (except `.example`, `.sample`, `.template`, `.dist`, `.defaults`), `.envrc`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`, `.htpasswd`, `kubeconfig`, `id_rsa`/`id_ed25519`-style keys, `credentials.*`, `secret(s).*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `*.tfstate`, `*.tfvars`, and anything under `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.password-store`, `secrets`, `.secrets` or `credentials`;
- path forms that OMP rewrites before use (a leading `@`, `:` or `"`, `~user`, `file://`, `?query`, `#fragment`);
- searches with `gitignore: false`. OMP's `grep` searches hidden files but honours `.gitignore`, which normally keeps `.env` out of a workspace-wide search. A secret file that is *not* gitignored can still appear in grep results.

`web_search` always goes to the session reviewer, because its query is sent to a third party and could carry data out of the session.

Tools are matched by name only when the host reports them as its own (`sourceInfo.source` is `builtin`). An extension, SDK or MCP tool that reuses a read-only name is reviewed. Self-declared metadata (`isReadOnly`, `readOnlyHint`, MCP `annotations.readOnlyHint`) is ignored, as the MCP specification says these hints are untrusted.

## Workspace writes

Calls to OMP's own `write` and `edit` tools whose every destination, including `edit` renames, is a plain path inside the working directory. These always go to the session reviewer instead:

- paths that OMP rewrites before use (`[path]`, `~/…`, `scheme://…`);
- protected entries at any depth, after resolving symlinks. Their contents are executed or trusted later without a call this extension could review:
  - git: `.git`, `.husky`. `core.fsmonitor` in `.git/config` runs on `git status`;
  - agent and editor settings: `.omp`, `.pi`, `.claude`, `.codex`, `.gemini`, `.opencode`, `.cursor`, `.windsurf`, `.mcp.json`, `mcp.json`, `opencode.json`, `opencode.jsonc`, `ssh.json`, `.ssh.json`, `.envrc`, `.vscode`, `.idea`, `.devcontainer`. OMP reads the project config of several agents and starts the MCP servers it names when a session starts, and Claude Code hooks in `.claude/settings.json` run shell commands;
  - language servers: `lsp.json`, `.lsp.json`, `lsp.yaml`, `.lsp.yaml`, `lsp.yml`, `.lsp.yml`, `node_modules`, `.venv`, `venv`, `.env`. OMP starts a language server when a code file is written, takes its command from these files, looks for it in `node_modules/.bin` and virtualenvs first, and typescript-language-server runs the workspace's own `tsserver.js`;
- the credential-like files listed above for reads, such as `.env` or `*.pem`;
- writes that create or change a program: content starting with `#!` (OMP's `write` tool makes such a file executable) or a destination that is already executable. A program in the workspace can shadow a command on the shell's PATH.

Not covered: language servers that run ordinary project files, which this fast path lets the agent write. The ESLint server loads `eslint.config.js`, rust-analyzer runs `build.rs` and proc macros, and the servers for Tailwind, Svelte, Gradle, sbt, Elixir, Zig and Nix (nixd) load or evaluate project code. OMP starts the server for a file type when a file of that type is written, and when the agent asks it a question (see below), so a write can make code run later without review. If you have such a server installed and don't want that, disable it in OMP's user-level `~/.omp/agent/lsp.json`, for example `{"eslint": {"disabled": true}, "rust-analyzer": {"disabled": true}}`; the names are those of OMP's server list (`lsp` `status` shows the ones configured for a project).

## Language server queries

Calls to OMP's own `lsp` tool that only ask the language server a question or preview an edit:

- `definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `status`, `capabilities`, and `diagnostics` on a file;
- `rename` and `rename_file` with `apply: false`, and `code_actions` without `apply: true`, which list what would change without changing it.

Every path the call names (`file`, and `new_name` for `rename_file`) must pass the [workspace read](#workspace-reads) checks; `*` (the whole workspace) is accepted for `symbols`. These always go to the session reviewer instead:

- applied edits: `rename` and `rename_file` (they apply unless `apply` is false) and `code_actions` with `apply: true`, except a previewed rename (below). The language server decides which files an edit changes only after this decision, and OMP writes them without checking where they are; a code action can also run a command inside the server;
- `diagnostics` on `*`, which runs the project's own checker (`cargo check`, `npx tsc`, `go build` or `pyright`), and `diagnostics` on a glob;
- `reload` and `request` (any raw LSP method);
- fields outside the tool's schema.

A language server answers from every file the workspace's code refers to, which can include files outside the workspace and `readRoots` or sensitive ones, and the agent can write that code without review. So every `lsp` result, reviewed or not, is checked before the agent sees it: a result that shows source lines from a file the [workspace read](#workspace-reads) checks would refuse (as `definition` or `references` do under each location) is replaced by a note saying so, and the audit log records a `result_withheld` entry. Paths and symbol names without their source lines are let through. Not covered: `hover` and `diagnostics` can show the value of a constant from such a file (`const TOKEN: "…"`) without naming it, and a review would not catch that either, since the reviewer sees the call, not its result.

### Previewed renames

A `rename` or `rename_file` that repeats an earlier preview of the same call (`file`, `line`, `symbol` and `new_name`, in the same session and directory) skips review once (route `lsp_edit`) when:

- the preview listed only text edits, each in a file the [workspace write](#workspace-writes) checks accept: inside the workspace, not a protected entry, not credential-like, not a program. A preview that creates, moves or deletes files, reports server notes, or prints anything else does not count;
- for `rename`, the new name is an identifier (letters, digits, `_`, `$`), since it is written at every reference;
- for `rename_file`, the file is an ordinary file that is not a program (no execute bit, no `#!` first line, not a directory), and both its old and new paths pass the same write checks;
- nothing that could change files ran while the preview ran or since: no call other than reads, language server queries and previews was allowed in that time or was still running, and none of OMP's background jobs (async bash, subagents) was running. Even a write that skips review counts, because a changed file can make the same arguments name another symbol, such as one declared outside the workspace. A call whose result never comes back keeps this fast path off for the session.

The preview tells the agent when its apply would skip review. With nothing changed in between, the language server sees the same code and normally gives the same answer, but this extension cannot make it: a server still loading the project, for one, can answer the apply with more files than the preview (OMP waits for the project to load before a rename, which makes this unlikely). What such an apply can write is limited, though: a rename writes the new name, an identifier, at the places the server finds the symbol, and `rename_file` writes import paths. After the apply, its result is compared with the preview: if it changed a file the preview did not list, made more edits in one than the preview counted, failed, or printed something this extension does not recognise, you get a warning, the audit log records an `lsp_edit_mismatch` event, and edits are reviewed again for the rest of the session. That check comes after the change, so it can tell you about it but not prevent it. Programs outside OMP's view, such as your editor or a process an approved command left running, can also change files between the two calls; only that check covers them.

The agent often calls `lsp` by writing its arguments to `xd://lsp` with the `write` tool. OMP then runs the `lsp` call as a separate tool call, which is decided as above, so that write is let through (route `lsp_dispatch`). This applies to `xd://lsp` only; other `xd://` devices, such as `xd://bash`, stay reviewed. Letting the write through does not reset the count of [consecutive denials](../README.md#reviewers).

## Safe bash commands

Read-only git commands, common read-only programs such as `grep`, `cat`, `head`, `ls`, `sed -n` and `jq` (see [Built-in read-only programs](#built-in-read-only-programs)), and commands your [allow rules](command-rules.md#allow-rules) name. They can be joined with `&&`, `||`, `;`, newlines and pipes, and each command is checked on its own: `git log --oneline | grep -i fix | head -5` skips review. Only a small subset of bash takes this path, one this extension reads exactly as bash does (it is tested against bash itself, see [CONTRIBUTING](../CONTRIBUTING.md#shell-parser-oracle)): plain and quoted words, those operators, comments, and these redirections:

- copies between stdin, stdout and stderr (`2>&1`);
- `/dev/null` (`2>/dev/null`, `&>/dev/null`, `</dev/null`);
- `< file` for a file the fast path could read anyway.

Everything else is reviewed, including `$` and backticks, subshells and `{ }` groups, background `&`, heredocs, `if`/`for`/`while`, `VAR=value command`, and redirections that write a file (`> out.txt`).

### A leading `cd`

A leading `cd <dir> &&` (or `cd <dir>;`) is allowed when `<dir>` is an existing directory inside the working directory: `cd src && git status`. That `cd` does not run in the shell. The rest of the command runs with the bash call's `cwd` set to that directory, so a `cd` function or `CDPATH` left by an earlier call cannot send it elsewhere, and its relative paths are checked from there. A `cd` anywhere else, or to `-`, a glob, or an option, is reviewed.

### Git

The read-only git commands are `status`, `log`, `diff`, `show`, `rev-parse`, `grep`, `ls-files`, `ls-tree`, `rev-list`, `blame`, `shortlog`, `describe`, `merge-base`, `show-ref`, `cat-file`, `check-ignore`, `check-attr`, `name-rev`, `count-objects`, listing-only `branch` and `tag`, `remote [-v]`, `remote get-url` and `stash list`/`show`, optionally after `--no-pager` and `-C <dir>` (a directory inside the working directory). A git command is still reviewed if it:

- uses `--output`, `--ext-diff`, `--no-index`, or `grep -O`/`--open-files-in-pager`;
- names a path outside the working directory (git compares files outside the work tree even without `--no-index`, so `git diff /etc/passwd /dev/null` prints the file);
- names a credential-like path, including `rev:path` blobs such as `git show HEAD:.env`;
- has an option naming an existing file outside the working directory and `readRoots`, such as an order file glued to `-O` (`git diff -O/path/order`);
- contains an unquoted glob (`git diff -- secrets*`).

### Programs run by absolute path

OMP runs every bash call in one persistent shell per session, so an earlier call can leave an alias, a function, or a workspace directory on PATH that turns `git status` into something else. A fast-pathed command is therefore rewritten to run every program by absolute path, looked up on the PATH OMP started with, skipping directories inside the workspace: `git status` runs as `/run/current-system/sw/bin/git status`. A leading `~` is written out as OMP's home directory too, since bash expands it from the shell's `HOME`, which an earlier call can change. If a program isn't found there, the command is reviewed. The rewritten command appears in the transcript and in the audit log as `pinnedCommand`, with `pinnedCwd` when a leading `cd` moved it. A command wrapped in `bash -lc` is reviewed, since the wrapper's own `bash` would be looked up on that PATH. A bash call whose `cwd` is outside the working directory is reviewed; one inside it has its paths checked from there. Variables exported by an earlier call (`GIT_EXTERNAL_DIFF`, `LD_PRELOAD`, …) still reach the pinned program, but setting them takes a reviewed call.

### When the bash fast path turns off

Some shell state runs code by itself, before or after every later command, and pinning cannot stop it: a `trap … DEBUG` runs before the pinned program, and before anything placed in front of it. So once a bash command that may set up such a hook has run, by whatever route or with the reviewer off, every bash command is reviewed for the rest of the session, and OMP shows a warning. That covers `trap`, `eval`, `exec`, `enable`, a command named by a variable (`$cmd`) unless the same command set it to plain text, aliases or variables set to those, `PS4`, `BASH_ENV`, `PROMPT_COMMAND`, `extdebug` and `functrace`, and `source`/`.` of a file that could not be read or that contains any of these. A sourced file with a literal path is read and checked the same way, so `source .venv/bin/activate` keeps the fast path. Heredoc bodies are a command's input and are not checked. Across about 15,000 recorded agent commands, 1.6% would turn the fast path off. `/clearance status` and `explain` say when the fast path is off; a new session turns it back on, and `/clearance off` does not. This check reads text, so a hook built in pieces (`$'\x74rap'`) can get past it; the command that sets one is still reviewed first.

### Other bash call fields

A bash call is also reviewed when it carries fields that change how or where it runs: `pty: true` (a terminal on stdin), `async`, a service `name` with `ready`/`log`/`port`/`host`, an `env`, or any field the extension does not know. Only `command`, `cwd`, `timeout` and `description` are allowed.

## Built-in read-only programs

These programs skip review without any configuration: `cat`, `head`, `tail`, `wc`, `ls`, `grep`, `sed`, `cut`, `sort`, `uniq`, `tr`, `tac`, `paste`, `base64`, `diff`, `du`, `stat`, `file`, `readlink`, `realpath`, `jq`, `find`, `timeout`, `echo`, `printf`, `true`, `false`, `pwd`, `basename`, `dirname`, `date`, `sleep`, `seq`, `which`, `uname`, `whoami`, `id`, `hostname` and `nproc`. Each has a table of the options it may be given, and git a list of subcommands; all of them are in [`config/default-rules.jsonc`](../config/default-rules.jsonc), with comments on options left out on purpose. The tables list options known to be read-only, not options known to be dangerous: any option outside the table, including a shortened long option such as `--incl`, sends the command to review. Options are read the way GNU getopt reads them (grouped short options, glued values, options after operands). Options were chosen to be read-only in GNU, BSD and busybox alike, and for `grep` in GNU grep and ugrep, since the PATH may resolve to any of them; the oracle in [CONTRIBUTING](../CONTRIBUTING.md#program-table-oracles) checks them against the implementations installed locally. Left out, for example:

- options that write files or run programs: `sort -o/-T/--compress-program`, `sed -i/-f`, `diff -l`, `file -z`, `jq -f/-L`, `find -exec/-delete/-fprint`, `date -s`, an operand to `hostname`, a second operand to `uniq` (its output file);
- options that never finish or follow links out of a tree: `tail -f`, `ls -L`, `du -L`, `grep -R`, `find -L`;
- `egrep` and `fgrep`, which are scripts that run `grep` from whatever PATH the shell has.

Files a program reads, as operands or option values (`grep -f`, `diff --from-file`), must be inside the working directory or `readRoots` and not credential-like, and so must every other word that names an existing file, whatever the program makes of it. Some programs take more care:

- **Globs** in file operands (`wc -l src/*.ts`) are allowed: every file the glob could match is checked, whatever glob options (`dotglob`, `nocaseglob`, `globskipdots`) an earlier call set, so `cat *` is reviewed when `.env` is in the directory. A glob that matches nothing, could match a name starting with `-`, or uses braces or `**` is reviewed. A glob anywhere else is reviewed, except in a `--name=value` option that no file matches.
- **Recursive reads**: `grep -r` (and any directory named to `grep` or `diff`) walks the tree first and is reviewed if it holds a credential-like file that the search would read, so `grep -rn TODO .` is reviewed in a directory with a `.env`. Quoted `--include` and `--exclude-dir` filters are honoured: `grep -rn TODO --include='*.ts' .` is not reviewed. Symbolic links met on the way are skipped, as `grep -r` does. Trees of more than 20,000 entries are reviewed.
- **`sed`** scripts may only print, delete, quit and substitute: addresses, `!`, `p d q Q = l P n N g G h H x z D`, and `s` without the `e` and `w` flags. Commands that read or write files (`r R w W`), run programs (`e`), insert text, branch or group are reviewed.
- **`jq`** can neither write files nor run programs, but a filter can read the environment (`env`, `$ENV`) or load modules (`import`, `include`), and those are reviewed.
- **`timeout`** runs the command after its duration, which must be safe on its own; that program is pinned too.
- **`find`** takes known tests only (`-name`, `-type`, `-path`, `-maxdepth`, `-newer`, `-printf`, …); a glob anywhere in its expression is reviewed, since a matching file name could become an action.
