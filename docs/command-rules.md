# Command rules

Command rules decide what happens to bash commands before the session reviewer handles them: program entries describe read-only programs option by option, and rules allow, review, ask about or block commands by their text. The built-in ones are in [`config/default-rules.jsonc`](../config/default-rules.jsonc); the [README](../README.md#command-rules) has an overview and the table of built-in rules. This page is the full format.

## Your rules file

A `rules.jsonc` next to `config.jsonc` (or at `CALLGATE_RULES_PATH`) adds to the built-in rules, in the same format as [`config/default-rules.jsonc`](../config/default-rules.jsonc). [`config/rules.example.jsonc`](../config/rules.example.jsonc) is a commented example of the format, and [`config/examples/`](../config/examples) holds ready-made policies to include, such as a [kubectl policy](../config/examples/kubectl.jsonc).

- A program entry of your own **replaces** the built-in one. With `"extends": "default"` it is **merged** into it instead: option and subcommand keys one by one, where `null` deletes a built-in key (written exactly as the built-in file writes it, such as `"-n --lines"`); `except` lists are joined; other keys replace the built-in ones.
- `"disable": ["program:sed", "program:git blame"]` removes built-in entries.
- A key with several names, such as `"get describe"`, lists subcommands that share one entry. Subcommands of subcommands are not entries of their own, so `"worktree list"` means `worktree` and `list`; to allow only `git worktree list`, give `worktree` the operand check `{ "literals": { "min": 1, "max": 1, "pattern": "^list$" } }`, as the example does.
- `"include": ["~/…/kubectl.jsonc"]` reads more files, by absolute path or `~/`. Each program may be defined in one file only.
- Options and subcommands an entry does not list are reviewed, as with the built-in rules, and every check in code still applies: programs run from OMP's startup PATH, files are read only inside the read roots, and so on.
- If any of these files has an error (an unknown key, kind or check, an option listed twice, a broken include), no rules are used: since the file might have held block or ask rules, every bash command is blocked in every reviewer mode until it is fixed. Other tools are unaffected. OMP shows an error notification and a red status entry, `/callgate status` shows the files in use or the error, and fixing the file is enough: it reloads automatically and OMP confirms recovery. Syntax errors name their exact line and column; file-level validation errors use `file:1:1` plus the JSON path.
- Default, main and included files are checked on every tool call and reloaded when they change, including when a previously missing include is created. The write fast path never writes them, nor `config.jsonc`, even when they are inside the working directory.

There are no per-project rules files: a cloned repository could ship one.

## Allow, review, ask and block rules

Program entries say what may skip review by reading options and operands. A `rules` list adds rules by the command's text:

```jsonc
"rules": [
  { "id": "npm-test", "prefix": "npm test", "outcome": "allow" },
  { "id": "kube-secrets", "match": "kubectl get|describe *[Ss][Ee][Cc][Rr][Ee][Tt]*", "outcome": "review",
    "why": "Secret values must not reach the model unreviewed." },
  { "id": "kube-interactive", "match": "kubectl exec|port-forward|cp|edit|apply|rollout", "outcome": "ask" },
  { "id": "no-force-push", "match": ["git push --force", "git push -f", "/\\bgit\\b.*\\bpush\\b.*\\s\\+\\S/"], "outcome": "block" }
]
```

- `allow`: a command that starts with `prefix` skips review, with the checks in [Allow rules](#allow-rules).
- `review`: handled by the session reviewer; never a fast path.
- `ask`: you decide, without the classifier, in every reviewer mode; without an interactive UI, the command is denied. An "Allow Always This Exact Action" answer stands for that exact command for the rest of the session.
- `block`: denied in every mode without asking the classifier or you. Unlike `deny`, which is only guidance for the classifier, a block cannot be argued with.

Among the rules a command matches, the most restrictive decides: block, then ask, then review. Any of them overrides program entries, allow rules and `reviewExemptTools`, so a broad allow can never hide an exception. Ask and block denials count toward `maxConsecutiveDenials`. `why` is shown in the denial, in the approval prompt, and to the classifier as your reason. `id`s are unique; `disable` removes a built-in rule by its id (see [Built-in rules](../README.md#built-in-rules)).

`/callgate rules` lists the programs and rules in use and the file each comes from; `/callgate rules <program | rule id>` shows one. `explain` names the rule that decided, and the audit log records it as `ruleId` and `ruleSource` (and, for a fast-pathed command, the entries that let it through as `ruleIds`).

## Patterns

`match` is a pattern or a list of them. A pattern is either `/regex/flags`, tested against the whole command, or words: the first names a program and the rest must follow it, in order, within the same command. `git push --force` matches `git push origin main --force`, `/usr/bin/git push --force`, `cd repo && git push --force` and `bash -lc "git push --force"`, but not `git push --force-with-lease`. In a word:

- `a|b` lists alternatives, and `*`, `?` and `[…]` are globs; `[|]`, `[*]` and so on match the character itself;
- `--name` also matches `--name=value`, but not a shortened `--na`, so list both spellings if a program accepts them;
- a single-letter flag also matches grouped short flags: `git push -f` matches `git push -uf origin main`.

Git also forces a push when a branch is prefixed with `+` (`git push origin +main`), which no word list can express; the regex above catches it. The program is matched by name, so write `git`, not `/usr/bin/git`.

Words are read as bash reads them: quotes keep a word together, so `;` or `|` inside quotes (`git -c 'x=a;b' push --force`) or a backslash-newline does not hide a command, and a commit message that mentions `git push --force` is one word, not a push. Commands inside loops, `$(…)`, and scripts handed to a shell (`bash -lc '…'`, `eval '…'`, a heredoc fed to `bash`) are read too. The program of a pattern with more words may appear anywhere in a command (after `sudo`, `docker exec c`, `ssh host`); a one-word pattern such as `sudo` or `mkfs*` matches only where a program runs, so `which sudo` does not match it.

A pattern that matches only when quotes are ignored (`ssh host "git reset --hard"`, but also `echo "git reset --hard"`) cannot tell a command from words, so the command is reviewed instead of blocked or asked about. Regexes read the whole text as written and keep their outcome, so built-in block rules avoid them.

A program named by a variable or a substitution (`$k delete --all`, `$(command -v kubectl) delete --all`) may be any program: where a program runs, it matches a pattern of more than one word whose other words follow. Variables the same command sets to plain text are read as that text, so `X=helm; $X delete --all` does not match `kubectl delete --all`. Rules are a best-effort tripwire, not a sandbox: an alias, a function or a script still gets past them, and is then reviewed by the classifier as usual.

## Allow rules

An allow rule's `prefix` is the start of a command as written, quotes included and redirections left out: the command must equal it or continue with a space, or, with a trailing `*`, start with the rest (`"rg *"` matches `rg x` but not a bare `rg`). Each command of a chain or pipeline needs its own rule or program entry. Since a prefix would trust every option of the program, a command is still reviewed if:

- it uses an option that runs another program or writes files: `find -exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls`, `fd -x/-X/--exec*` (also inside a group such as `-Hx`), `rg --pre`, `sort -o/--output/--compress-program`, `tar -I/-F/--to-command/--checkpoint-action/--use-compress-program/...`, and `tar` extracting or writing archives (`x`, `c`, `r`, `u`, `A`, `--extract`, `--delete`, …). GNU tools accept shortened long options, so `sort --outp=x` counts as `--output`;
- an argument names an existing path outside the working directory and `readRoots`, or a credential-like path. This covers values glued to an option and `name=value` arguments: `cat ~/.ssh/id_ed25519`, `cat .env`, `rg TOKEN --file=../x`, `grep -f/etc/x`, `dd if=../x`;
- an argument is expanded by the shell, since its final form is unknown: an unquoted glob or brace, `~user`, or `~` after `=` or `:` in a `name=value` word, which bash expands (`dd if=~/key`). `cat secrets*` is reviewed, `find . -name '*.ts'` is not.

A command a program entry rejects can still be allowed by a rule, under these checks. A prefix for a program whose arguments are a script or command line (`sed`, `awk`, `xargs`, `parallel`; read-only `sed` scripts are covered by its entry), or a bare shell, interpreter or wrapper (`bash`, `python`, `node`, `env`, `sudo`, `timeout`, …), which would allow any code, is an error. Name a specific invocation instead, such as `"python -m pytest"` or `"npm test"`. A `*` glued to a word leaves it unfinished, so `pyth*` or `e*` never lets a shell, interpreter or wrapper through, and `python -*` is a bare `python`. Beyond those checks, a rule still trusts the program: `npm test` runs whatever the `test` script says.
