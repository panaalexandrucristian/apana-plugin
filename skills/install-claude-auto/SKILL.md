---
name: install-claude-auto
description: "Installs claude-auto, the wrapper that starts `claude`, writes a compact handoff when the context reaches 150k tokens and continues in a new session in the same terminal window, and puts it on PATH through ~/.zshrc. Use this whenever the user wants to install, set up, reinstall, update, repair or check claude-auto, or says things like \"pune claude-auto în zshrc\", \"instalează claude-auto\", \"fă claude-auto disponibil în terminal\", \"claude-auto: command not found\", even if they never say \"skill\". For removing it use apana:uninstall-claude-auto instead."
---

# install-claude-auto

`claude-auto` is a Python wrapper you start instead of `claude`. When the context of the running session reaches the threshold (150000 tokens), it writes a handoff note with the apana plugin's compact-handoff skill, ends that session and starts a fresh `claude` that reads the note, all in the same terminal window. Sessions started with plain `claude` are never affected: the hooks reach only the session the wrapper starts (through `--settings`), and `~/.claude/settings.json` stays untouched. A subagent that is working holds the handoff back (up to 30000 tokens above the threshold, `CLAUDE_AUTO_DEFER_EXTRA`): ending `claude` would end it without an answer.

This skill puts it in place. The bundled `scripts/install.py` does the work, so run it instead of copying files or editing `~/.zshrc` by hand. It is idempotent, and it saves the original rc once as `~/.zshrc.claude-auto.bak`.

## Steps

1. Run the installer:

   ```bash
   python3 -I ${CLAUDE_SKILL_DIR}/scripts/install.py
   ```

   It does three things:
   - copies `claude-auto` and its test suite from `assets/` to `~/.claude/claude-auto/` (only what differs);
   - adds one marked block to the zsh rc (`$ZDOTDIR/.zshrc`, else `~/.zshrc`) that puts that folder on PATH. A block from an older install is updated in place, so there is never a second one;
   - checks the result: the script compiles, `claude-auto --version` reaches `claude`, and the compact-handoff script exists.

   Useful flags: `--dry-run` shows what would change and writes nothing (use it when the user wants to see first); `--no-rc` skips the rc edit; `--rc FILE` edits another file; `--run-tests` runs claude-auto's own test suite afterwards (about a minute; use it when the user asks to verify or after changing `assets/claude-auto`).

2. Read the output. Lines start with `ok`, `info`, `warn` or `fail`; a `warn` makes the exit code 1 even though the install went through.
   - `claude is not on PATH`: nothing to fix here; claude-auto cannot start a session without it. Tell the user.
   - `make_context.py was not found`: the apana plugin is missing, so the hook cannot write the note and no handoff will ever happen. Tell the user plainly; the fix is installing the apana plugin or setting `CLAUDE_AUTO_MAKE_CONTEXT` to the script. Do not make up a replacement.
   - `markers ... unbalanced`: the rc has half a block, probably from a hand edit. The installer left the rc alone on purpose, because guessing which lines to keep could damage it. Show the user the two marker lines (`# >>> claude-auto >>>` / `# <<< claude-auto <<<`) and ask what to do.
   - `mentions claude-auto outside the block`: a line the user wrote (an alias, an export). It is left alone, but it may shadow the PATH entry. Mention it.

3. Report in a few lines: what was new, updated or unchanged; that the rc got the block (and where the backup is); that the current terminal does not see the change until the user opens a new one or runs `exec zsh`; then `claude-auto` in place of `claude`. Quote the threshold line the installer prints.

## Things worth knowing

- **Do not print the rc file.** It often holds API keys and tokens. The installer never prints its contents, and you have no reason to either.
- **Why PATH and not an alias:** a PATH entry also works from scripts and non-interactive shells, and one marked block is easy to remove exactly.
- **The threshold** is the default in `assets/claude-auto` (`env_num("CLAUDE_AUTO_TOKENS", 150000)`, and the same number in the docstring). For one run: `CLAUDE_AUTO_TOKENS=120000 claude-auto`. For good: the user exports that variable in their own rc, outside the marked block; or the default in `assets/claude-auto` is changed and the installer run again.
- **Edit `assets/`, not `~/.claude/claude-auto/`.** The assets (in the apana plugin repository, `skills/install-claude-auto/assets/`) are the source of truth and every install overwrites the installed copy, so a fix made only there disappears. This is also what lets the install work again after an uninstall. A change to `assets/` reaches the user only after a plugin release and `claude plugin update apana@apana-private`, then a new run of this skill.
- **Tests.** `assets/test_claude_auto.py` (claude-auto, offline, about a minute) and `scripts/test_setup.py` (this skill and `apana:uninstall-claude-auto`, on a throw-away HOME). `scripts/live_check.py` runs scenarios with a real `claude --model haiku` in a pty; it uses real sessions (cost), so run it only when the user asks or after a change to the wrapper's signal, lock or argument handling.
- **Other settings** (`CLAUDE_AUTO_NEXT_ARGS`, `CLAUDE_AUTO_COOLDOWN`, `CLAUDE_AUTO_MAX`, ...) are documented at the top of `claude-auto`. Read the docstring there only if the user asks about one.
- Handoff notes and `auto.log` go to `~/.claude/handoffs/auto/`.
