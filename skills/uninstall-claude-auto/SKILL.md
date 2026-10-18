---
name: uninstall-claude-auto
description: "Removes claude-auto (the wrapper that hands off to a fresh `claude` session at a token threshold) - its PATH block in ~/.zshrc and the ~/.claude/claude-auto/ folder - and leaves the rest of the rc untouched. Use this whenever the user wants to uninstall, remove, disable, undo or clean up claude-auto, take it out of zshrc or PATH, or says things like \"dezinstalează claude-auto\", \"scoate claude-auto din zshrc\", \"nu mai vreau claude-auto\", even if they never say \"skill\". To install or reinstall use apana:install-claude-auto."
---

# uninstall-claude-auto

This undoes what `apana:install-claude-auto` did. The bundled `scripts/uninstall.py` does the work, so run it instead of editing `~/.zshrc` or deleting folders by hand: it removes exactly the marked block the installer added (plus the one blank line before it), so everything else in the rc comes back byte for byte.

## Steps

1. Run it:

   ```bash
   python3 -I ${CLAUDE_SKILL_DIR}/scripts/uninstall.py
   ```

   It does four things:
   - removes the `# >>> claude-auto >>>` ... `# <<< claude-auto <<<` block from the zsh rc (`$ZDOTDIR/.zshrc`, else `~/.zshrc`). If the rc is then exactly what the installer saved in `~/.zshrc.claude-auto.bak`, that backup is deleted too; if the user changed the rc since, the backup is kept;
   - deletes `claude-auto` and `test_claude_auto.py` from `~/.claude/claude-auto/`, then the folder if nothing else is in it. Unknown files in the folder stay, and the output says so;
   - keeps the handoff notes and `auto.log` in `~/.claude/handoffs/auto/`;
   - only reads `~/.claude/settings.json`, to tell the user if it mentions claude-auto.

   Flags: `--dry-run` shows what would go and removes nothing (use it when the user wants to look first); `--no-rc` leaves the rc alone; `--rc FILE` and `--home DIR` point it elsewhere; `--purge-notes` also deletes `~/.claude/handoffs/auto/`.

2. Pass `--purge-notes` only when the user clearly asked to delete the handoff notes. They are the only copy of those summaries and deleting them cannot be undone; by default say where they are and how to delete them.

3. Read the output. `warn` lines make the exit code 1 although the removal went through:
   - `N claude-auto session(s) still running`: those sessions keep working, but their hook is gone, so they will not hand off any more. Tell the user they can finish them or close them.
   - `markers ... unbalanced`: the rc has half a block (a hand edit). The rc was left alone on purpose; show the two marker lines and ask the user what to do.
   - `still mentions claude-auto`: lines the user wrote themselves (an alias, an export). They are not part of the block, so they stay; point them out so the user can remove them.
   - `kept, it also holds files that are not claude-auto's`: the folder had other files; list them.

4. Report in a few lines what was removed and what was kept. Remind the user that the terminal they are in still has the old PATH until they open a new one or run `exec zsh`.

## Things worth knowing

- **Do not print the rc file.** It often holds API keys and tokens, and the script never prints its contents.
- Running it twice is fine: the second run says there is nothing to remove.
- This does not delete the two skills. To bring claude-auto back, run `apana:install-claude-auto`: the source files live in its `assets/`, so a reinstall works even after the folder was removed.
