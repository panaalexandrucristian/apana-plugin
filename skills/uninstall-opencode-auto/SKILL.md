---
name: uninstall-opencode-auto
description: "Removes opencode-auto (the launcher that hands an OpenCode session off to a new one at a token threshold): its PATH block in ~/.zshrc, the plugin link in ~/.config/opencode/plugins/, the launcher folder and the enabled file, and leaves the rest of the rc untouched. Use this whenever the user wants to uninstall, remove, disable, undo or clean up opencode-auto, take it out of zshrc or PATH, stop the automatic handoffs in OpenCode, or says things like \"dezinstalează opencode-auto\", \"scoate opencode-auto din zshrc\", \"nu mai vreau opencode-auto\", even if they never say \"skill\". To install or reinstall use apana:install-opencode-auto."
---

# uninstall-opencode-auto

This undoes what `apana:install-opencode-auto` did. The bundled `scripts/uninstall.py` does the work, so run it instead of editing `~/.zshrc` or deleting folders by hand: it removes exactly the marked block the installer added (plus the one blank line before it), so everything else in the rc comes back byte for byte.

## Steps

1. Run it:

   ```bash
   python3 -I ${CLAUDE_SKILL_DIR}/scripts/uninstall.py
   ```

   It does four things:
   - removes the `# >>> opencode-auto >>>` ... `# <<< opencode-auto <<<` block from the zsh rc (`$ZDOTDIR/.zshrc`, else `~/.zshrc`). If the rc is then exactly what the installer saved in `~/.zshrc.opencode-auto.bak`, that backup is deleted too; if the user changed the rc since, the backup is kept;
   - removes the link `~/.config/opencode/plugins/apana-auto` (the repository behind it is not touched) and the launcher folder `~/.config/opencode/opencode-auto/`, then the folders only if nothing else is in them. Unknown files stay, and the output says so;
   - removes the `enabled` file under `~/.local/state/opencode/apana/auto/`: the handoffs stop at once, also in sessions that are already running, whatever the plugin state;
   - keeps the handoff notes in `~/.local/share/opencode/apana/handoffs/auto/` and `auto.log`.

   Flags: `--dry-run` shows what would go and removes nothing (use it when the user wants to look first); `--no-rc` leaves the rc alone; `--rc FILE` and `--home DIR` point it elsewhere; `--purge-notes` also deletes the notes and `auto.log`.

2. Pass `--purge-notes` only when the user clearly asked to delete the handoff notes. They are the only copy of those summaries and deleting them cannot be undone; by default say where they are and how to delete them.

3. Read the output. `warn` lines make the exit code 1 although the removal went through:
   - `is not a link, so it is not ours`: something else sits where the plugin link was. It was left alone; show the path.
   - `markers ... unbalanced`: the rc has half a block (a hand edit). The rc was left alone on purpose; show the two marker lines and ask the user what to do.
   - `still mentions opencode-auto`: lines the user wrote themselves (an alias, an export). They are not part of the block, so they stay; point them out so the user can remove them.
   - `kept, it also holds files that are not opencode-auto's`: the folder had other files; list them.

4. Report in a few lines what was removed and what was kept. Remind the user that a running OpenCode drops the server part within about 10 seconds, that a TUI that is already open keeps its TUI part until it is closed (it does nothing without handoffs), and that the terminal they are in still has the old PATH until they open a new one or run `exec zsh`. Do not restart OpenCode or its service yourself.

## Things worth knowing

- **Do not print the rc file.** It often holds API keys and tokens, and the script never prints its contents.
- Running it twice is fine: the second run says there is nothing to remove.
- Sessions that were marked keep their `apana` metadata; it is inert without the plugin and the `enabled` file.
- This does not delete the two skills. To bring opencode-auto back, run `apana:install-opencode-auto`: the launcher's source is in its `assets/`, so a reinstall works even after the folder was removed.
