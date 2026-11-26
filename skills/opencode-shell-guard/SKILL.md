---
name: opencode-shell-guard
description: "Makes OpenCode run its shell commands with bash instead of zsh and refuse grep in them with a reason that says to use rg (rg, git grep and pgrep stay allowed): writes \"shell\" in the global OpenCode config (~/.config/opencode/opencode.jsonc), links a small OpenCode plugin that refuses the command into ~/.config/opencode/plugins/, adds a note to ~/.config/opencode/AGENTS.md and removes the 13 grep rules that earlier versions wrote into \"permissions\"; checks, previews and repairs that setup and keeps comments and the user's own rules. Use when the user wants bash in OpenCode, a loop over a space-separated variable ran once in OpenCode (zsh does not split it), grep in an OpenCode shell command was slow on a large file or should be replaced by rg, a refused grep said only `Permission denied: shell`, or a new computer needs the same OpenCode shell setup. Romanian: \"bash în loc de zsh în OpenCode\", \"blochează grep în OpenCode\", \"folosește rg în loc de grep\", \"refuzul de grep să spună de ce\"."
---

# opencode-shell-guard

One setting in OpenCode's global config, a plugin linked beside it and a note, and why:

- **`"shell"`: bash.** OpenCode picks its shell from `"shell"` in the config, then `$SHELL`, then `/bin/zsh`, so on a Mac it usually runs zsh. zsh does not split an unquoted variable into words: `IDS="a b c"; for s in $IDS` runs once with `a b c`, where bash runs three times. Models write bash, so such a loop silently does the wrong thing (in one session, a polling loop over 8 session IDs found none of them, so it would have run all its 100 rounds of 6 s and then reported the 8 sessions, which had finished, as still running). The script writes a bash 4 or newer when it finds one (`/opt/homebrew/bin/bash`, `/usr/local/bin/bash`, `/usr/bin/bash`), because macOS's `/bin/bash` is 3.2 and has no `declare -A` or `mapfile`.
- **A plugin that refuses grep in shell commands and says why.** macOS grep ran `grep -a -o -E '.{0,120}"server\.connected".{0,120}'` on a 240 MB binary for 556 s; `rg` gave the same lines in 0.032 s (measured, n=1 each). The script links this skill's `plugin/` folder as `plugins/opencode-shell-guard` in the config folder. Through OpenCode's `permission.evaluate` hook, the plugin applies these rules to each part of a shell command as OpenCode splits it, with OpenCode's own wildcard matching (the last matching rule wins):

  | Rule | Effect |
  | --- | --- |
  | `*grep *` | refuse: any part whose text holds `grep ` anywhere or ends in `grep`, also inside `bash -c '...'`, `xargs`, `find -exec`, `/usr/bin/grep`, `egrep`, `fgrep` |
  | `git *grep *`, `pgrep *`, `rg *` | allow |
  | `echo *`, `printf *`, `cat *`, `tee *`, `gh *`, `python3 *`, `node *`, `sed *`, `perl *` | allow: they may carry the text `grep ` without running grep |

  A refused command gets `permission.rejected: opencode-shell-guard refused `<command>`: grep is not allowed in shell commands here ...`, followed by what to use instead (`rg`, `... | rg pattern`, `git grep`, the `grep` tool) and not to retry or ask. `echo hi | grep hi` and `cat <(grep x f)` are refused, because each part is checked on its own. OpenCode's own `grep` tool, which is ripgrep, is not a shell command and is not affected; neither is a script that calls grep inside itself, such as `npm test`.

  Why a plugin and not rules in `"permissions"`: a rule there has only `action`, `resource` and `effect`, so it cannot carry a message, and one that denies ends OpenCode's check with a bare `Permission denied: shell` before any plugin hook runs (read in OpenCode's source and in the 2.4.2 binary). Given only that, a model in another session retried `... | grep ...` commands 6 times and asked the user 3 times why they failed. A throw-away plugin with the same hook refused `echo shell-guard-probe | rg probe`, which the rules allowed, with its own message (OpenCode 2.4.2, n=1). Earlier versions of this skill wrote the 13 rules into `"permissions"`; the script removes exactly those 13 and keeps the user's own rules.
- **A note in `AGENTS.md`** in the same folder, between `<!-- opencode-shell-guard -->` and `<!-- /opencode-shell-guard -->`, so the model writes `rg` before its first grep instead of after a refusal. It says that a command with `grep ` is refused and how the refusal starts, to rewrite the command with `rg` (also `... | rg pattern`), `git grep` or the `grep` tool instead of retrying or asking, that `-E` in `rg` is the encoding (`rg -E 'a|b'` fails with `unknown encoding: a|b`, measured n=1), and which commands may carry the text. OpenCode reads that `AGENTS.md` as instructions in every session. The rest of the file is not touched.

## Steps

1. Look first, change nothing:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/shell-guard.mjs" --check
   ```

   Lines start with `ok`, `info`, `warn` or `fail`; anything other than `ok` makes the exit code 1. If every line is `ok`, say so and stop. If the user only asked to check, report and stop here. The check sees that the link points to the plugin, not that OpenCode loaded it; in an OpenCode session, `echo hi | grep hi` must be refused with a message that starts with `opencode-shell-guard refused`.

2. Show what would change, write nothing (the lines starting with `info |` are the note as it would be written):

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/shell-guard.mjs" --dry-run
   ```

3. Write it, with the same command and no flag. Each file that changes is first copied to `<name>.bak-shell-guard-<time>`. The link comes first, so if it cannot be made the config keeps the rules that still refuse grep, without a reason. In the config, the script replaces only `"shell"` and removes the 13 rules from `"permissions"` (the whole key when nothing else is in it); the other keys, the user's own rules in their order and the comments outside `"permissions"` stay. In `AGENTS.md` it replaces the note between its markers, or adds it at the end after a blank line, or creates the file. Then it runs the check again. It is idempotent: a second run prints `nothing to change`. `--shell <path>` writes that bash instead of the one it finds; `--config-dir <dir>` works on another folder (default: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`; `opencode.jsonc`, else `opencode.json`, else a new `opencode.jsonc`; `AGENTS.md` and `plugins/` in the same folder). When this copy of the skill is in Claude Code's plugin cache, which every update of the plugin replaces, the link points to the same folder in the marketplace clone (`~/.claude/plugins/marketplaces/apana-private/skills/opencode-shell-guard/plugin`) instead.

4. Handle what it reports:
   - `is not valid JSON or JSONC`: nothing was written. Show the user the file and the position from the message; do not fix it without asking.
   - `AGENTS.md: the markers ... are not one pair in this order`: nothing was written, the config and the link neither. One marker is missing, doubled or after the other. Show the user the lines with the markers and ask; do not guess which text is the note.
   - `"permissions" is not an array`: nothing was written. Show the value to the user and ask.
   - `plugins/opencode-shell-guard exists and is not a link`: nothing was written. Show the user what is there and ask; do not delete it.
   - `the marketplace clone has no ...`: the link points into the plugin cache and will break at the next update of the plugin. Ask the user before running `claude plugin marketplace update apana-private`, then run the skill again.
   - `only bash 3 found`: it wrote that bash and works, but suggest `brew install bash` and running the skill again; do not install it without asking.
   - `"permissions" refuses ... itself, before the plugin runs`: a rule of the user's own, for example `{ "action": "shell", "resource": "grep *", "effect": "deny" }`, still refuses grep with only `Permission denied: shell`. The script keeps it; show it to the user and ask before removing it.
   - `the comments inside "permissions" are not kept`: they are in the backup; tell the user.
   - `also sets shell and permissions` (the other of `opencode.json` and `opencode.jsonc`) or `the deprecated V1 key "permission"`: OpenCode combines them. Show the user `opencode debug config` and ask which one to clean up.

5. Report in a few lines what changed and where the backups are. On OpenCode 2.4.2 the running service picked up `"shell"` without a restart (verified by hand, before this script existed) and loaded a newly linked plugin without one too (a command 15 s after the link was refused by it, n=1). Do not restart OpenCode or its service yourself.

## Limits

- The refusal matches the text of a command. A command that is not in the allow list and holds `grep ` as text is refused too, for example `jq` or `awk` with `grep ` in an argument.
- grep started from inside an allowed program (`python3 -c "import subprocess; subprocess.run(['grep', ...])"`) or written to dodge the match (`gr""ep`, a tab after `grep`) is not caught. It is a guard against habit, not a sandbox.
- If OpenCode does not load the plugin (a load error, or an OpenCode with another plugin API), grep is not refused at all. The plugin then prints a warning that starts with `[opencode-shell-guard]` on OpenCode's console, which `--check` cannot see; the `echo hi | grep hi` test in step 1 shows it.
- The plugin also refuses where a session's own rules allow the command: it overrode the allow of the global rules (n=1). For the sessions that `oc.sh` (the `opencode` skill) creates with an allow-all rule of their own, the same is expected but was not tried.
- A command OpenCode cannot parse (`eval`, broken syntax): with no shell deny rule left in `"permissions"`, OpenCode asks for approval of the whole command instead of failing, and the plugin checks its whole text as one part (read in the 2.4.2 binary, not tried). A shell deny rule of the user's own makes it fail as before.
- The note reaches only OpenCode sessions that read the global `AGENTS.md`. On OpenCode 2.4.2, a session already running when the note was written got it as changed instructions at its next step, without a restart (seen once, n=1, a `claude-agent/*` session); other providers are not verified.
- Windows is refused: OpenCode's shell there is not bash by default.

## Undo

Remove the link `plugins/opencode-shell-guard` in the config folder (the link itself, not the folder it points to). Copy the newest `opencode.jsonc.bak-shell-guard-<time>` and `AGENTS.md.bak-shell-guard-<time>` back over their files, or delete the `"shell"` key and the note with its two markers from `AGENTS.md`; the config backup made when the 13 rules of earlier versions were removed brings them back with it. A file the script created has no backup; delete it.

## Tests

From the root of the apana repository: `node --test skills/opencode-shell-guard/scripts/test/*.mjs` (also part of `npm test`). They work only on throw-away folders and never touch the real OpenCode config.
