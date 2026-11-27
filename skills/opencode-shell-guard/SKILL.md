---
name: opencode-shell-guard
description: "Sets bash as OpenCode's shell instead of zsh and links a plugin that refuses grep with an explanation to use rg and find with an explanation to use fd. Adds a note to the global AGENTS.md and removes the old grep permissions while keeping the user's own rules and config comments outside those permissions. Checks, previews and repairs the setup. Use when a loop over a space-separated variable ran once in OpenCode, a shell grep was slow, find should be replaced by fd, or a refusal only said `Permission denied: shell`. Romanian: \"bash în loc de zsh în OpenCode\", \"folosește rg în loc de grep\", \"folosește fd în loc de find\"."
---

# opencode-shell-guard

One setting in OpenCode's global config, a plugin linked beside it and a note, and why:

- **`"shell"`: bash.** OpenCode picks its shell from `"shell"` in the config, then `$SHELL`, then `/bin/zsh`, so on a Mac it usually runs zsh. zsh does not split an unquoted variable into words: `IDS="a b c"; for s in $IDS` runs once with `a b c`, where bash runs three times. Models write bash, so such a loop silently does the wrong thing (in one session, a polling loop over 8 session IDs found none of them, so it would have run all its 100 rounds of 6 s and then reported the 8 sessions, which had finished, as still running). The script writes a bash 4 or newer when it finds one (`/opt/homebrew/bin/bash`, `/usr/local/bin/bash`, `/usr/bin/bash`), because macOS's `/bin/bash` is 3.2 and has no `declare -A` or `mapfile`.
- **A plugin that directs searches to `rg` and `fd`.** The script links this skill's `plugin/` folder as `plugins/opencode-shell-guard` in the config folder. Through OpenCode's `permission.evaluate` hook, the plugin checks each part of a shell command as OpenCode splits it.

  For **`grep`**, macOS grep ran `grep -a -o -E '.{0,120}"server\.connected".{0,120}'` on a 240 MB binary for 556 s; `rg` gave the same lines in 0.032 s (measured, n=1 each). The grep rule uses OpenCode's wildcard matching (the last matching rule wins):

  | Rule | Effect |
  | --- | --- |
  | `*grep *` | refuse: any part whose text holds `grep ` anywhere or ends in `grep`, also inside `bash -c '...'`, `xargs`, `find -exec`, `/usr/bin/grep`, `egrep`, `fgrep`; a part refused only for a `pgrep` in it passes, so `ps -p $(pgrep x)` runs and `ps -p $(pgrep x) $(grep -l y f)` does not |
  | `git *grep *`, `pgrep *`, `rg *` | allow |
  | `echo *`, `printf *`, `cat *`, `tee *`, `gh *`, `python3 *`, `node *`, `sed *`, `perl *` | allow: they may carry the text `grep ` without running grep |

  A refused command gets `permission.rejected: opencode-shell-guard refused `<command>`: grep is not allowed in shell commands here ...`, followed by what to use instead (`rg`, `... | rg pattern`, `git grep`, the `grep` tool) and not to retry or ask. `echo hi | grep hi` and `cat <(grep x f)` are refused, because each part is checked on its own. OpenCode's own `grep` tool, which is ripgrep, is not a shell command and is not affected; neither is a script that calls grep inside itself, such as `npm test`.

  For **`find`**, the plugin checks the executable position. It covers `find` by name or path, after shell assignments or redirections, through `command`, `env`, `timeout` and `xargs` with common static options, and in literal command strings passed to `bash -c` or `sh -c`. `echo "find ."`, `cat ./find` and `command -v find` still pass. On refusal, use `fd`, which must be in the OpenCode service's `PATH`. For example, `find . -type f -name '*.kt'` becomes `fd -HI -s -t f -g '*.kt' .`: include hidden and ignored files, match case, and select regular files by name. Check `fd --help` for more complex expressions; `find -exec` is not translated. A resource that triggers both refusals gets advice for both.

  Why a plugin and not rules in `"permissions"`: a rule there has only `action`, `resource` and `effect`, so it cannot carry a message, and one that denies ends OpenCode's check with a bare `Permission denied: shell` before any plugin hook runs (read in OpenCode's source and in the 2.4.2 binary). Given only that, a model in another session retried `... | grep ...` commands 6 times and asked the user 3 times why they failed. A throw-away plugin with the same hook refused `echo shell-guard-probe | rg probe`, which the rules allowed, with its own message (OpenCode 2.4.2, n=1). Earlier versions of this skill wrote the 13 rules into `"permissions"`; the script removes exactly those 13 and keeps the user's own rules.
- **A note in `AGENTS.md`** in the same folder, between `<!-- opencode-shell-guard -->` and `<!-- /opencode-shell-guard -->`, so the model uses `rg` and `fd` from its first call. It explains the refusals, gives the `fd` example and reminds the model that `-E` in `rg` sets the encoding. OpenCode reads that `AGENTS.md` as instructions in every session. The rest of the file is not touched.

## Steps

1. Look first, change nothing:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/shell-guard.mjs" --check
   ```

   Lines start with `ok`, `info`, `warn` or `fail`; anything other than `ok` makes the exit code 1. If every line is `ok`, say so and stop. If the user only asked to check, report and stop here. The check inspects the plugin link and the configured permissions for sample commands. To confirm a running hook in an OpenCode session, `echo hi | grep hi` and `find . -type f -name '*.kt'` must be refused with messages starting with `opencode-shell-guard refused` and indicating `rg` and `fd`, respectively. Check `fd --version` in the session to verify it can run `fd`.

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
   - `"permissions" refuses ... itself, before the plugin runs`: a rule of the user's own, for example `{ "action": "shell", "resource": "find *", "effect": "deny" }`, still refuses the sample with only `Permission denied: shell`. The script keeps it; show it to the user and ask before removing it.
   - `the comments inside "permissions" are not kept`: they are in the backup; tell the user.
   - `also sets shell and permissions` (the other of `opencode.json` and `opencode.jsonc`) or `the deprecated V1 key "permission"`: OpenCode combines them. Show the user `opencode debug config` and ask which one to clean up.

5. Report in a few lines what changed and where the backups are. On OpenCode 2.4.2 the running service picked up `"shell"` without a restart (verified by hand, before this script existed) and loaded a newly linked plugin without one too (a command 15 s after the link was refused by it, n=1). Do not restart OpenCode or its service yourself.

## Limits

- The grep rule matches command text. A command that is not in the allow list and holds `grep ` as text is refused too, for example `jq` or `awk` with `grep ` in an argument, or `sqlite3` with `like '%grep %'` in its query (refused live).
- grep started from inside an allowed program (`python3 -c "import subprocess; subprocess.run(['grep', ...])"`) or written to dodge the match (`gr""ep`, a tab after `grep`) is not caught. It is a guard against habit, not a sandbox.
- The find rule checks simple commands and lists reaching the hook. It does not resolve aliases, expansions, arbitrary wrapper options, shell functions, or commands read from a script file. Within `bash -c` and `sh -c` it does not parse compound constructs such as loops and substitutions.
- If registration fails, neither plugin rule runs. The warning on OpenCode's console starts with `[opencode-shell-guard]` and is not visible to `--check`; use the live checks in step 1.
- The plugin also refuses where a session's own rules allow the command: it overrode the allow of the global rules (n=1), and the allow-all rule of a session that `oc.sh` (the `opencode` skill) created (n=1).
- A change to `scripts/rules.mjs` alone does not reach a running OpenCode. On 2.4.2 it reloads the plugin when `plugin/server.js` changes, not when the rules do, so after editing the rules touch `plugin/server.js`; the next reload takes them (seen live, n=1).
- A command OpenCode cannot parse (`eval`, broken syntax): with no shell deny rule left in `"permissions"`, OpenCode asks for approval of the whole command instead of failing, and the plugin checks its whole text as one part (read in the 2.4.2 binary, not tried). A shell deny rule of the user's own makes it fail as before.
- The note reaches only OpenCode sessions that read the global `AGENTS.md`. On OpenCode 2.4.2, a session already running when the note was written got it as changed instructions at its next step, without a restart (seen once, n=1, a `claude-agent/*` session); other providers are not verified.
- Windows is refused: OpenCode's shell there is not bash by default.

## Undo

Remove the link `plugins/opencode-shell-guard` in the config folder (the link itself, not the folder it points to). Copy the newest `opencode.jsonc.bak-shell-guard-<time>` and `AGENTS.md.bak-shell-guard-<time>` back over their files, or delete the `"shell"` key and the note with its two markers from `AGENTS.md`; the config backup made when the 13 rules of earlier versions were removed brings them back with it. A file the script created has no backup; delete it.

## Tests

From the root of the apana repository: `node --test skills/opencode-shell-guard/scripts/test/*.mjs` (also part of `npm test`). They work only on throw-away folders and never touch the real OpenCode config.
