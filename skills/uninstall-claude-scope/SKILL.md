---
name: uninstall-claude-scope
description: "Use when the user wants to uninstall, remove, disable, undo or clean up claude-scope, remove its zsh PATH entry, or restore after an installation. Romanian: dezinstalează claude-scope, scoate claude-scope din zshrc/PATH."
---
# uninstall-claude-scope

Safely undo `apana:install-claude-scope`. Run the bundled remover; do not edit a shell rc or delete `~/.claude/claude-scope` manually:

```bash
python3 -I ${CLAUDE_SKILL_DIR}/scripts/uninstall.py
```

It removes only:

- the exact `# >>> claude-scope >>>` / `# <<< claude-scope <<<` PATH block;
- the copied launcher only when it is recognized as installer-owned;
- an empty `~/.claude/claude-scope/` directory;
- the installer backup only when the rc is byte-for-byte back to its saved state.

It keeps foreign files in that directory, changed rc contents, unrelated Claude files, settings, reports and runs. Broken/repeated markers or an unknown same-named launcher are warnings and are left untouched. The operation is idempotent. The installer is no longer shipped: use `/apana:scope` for the current in-session workflow. This remover does not disable the new scope hook.

Options: `--dry-run`, `--no-rc`, `--rc FILE`, and `--home DIR` for an isolated target. Do not print the rc; it may contain secrets. After a real uninstall, open a new terminal or run `exec zsh` because the current shell retains its previous PATH.
