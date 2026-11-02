---
name: uninstall-claude-copilot
description: Use when the user asks to uninstall or remove claude-copilot, or preview its removal.
---

# Remove the Copilot launcher

Use the sibling bundled helper from this same plugin version. If the sibling is missing, stop; do not use a stale installed copy or duplicate the uninstaller.

Preview first.

```sh
python3 -I "${CLAUDE_SKILL_DIR}/../claude-copilot/scripts/claude_copilot.py" uninstall --dry-run
```

If the user only asked for a preview, stop. If removal was not explicitly requested, ask for confirmation before continuing. A preview is not evidence that removal happened.

```sh
python3 -I "${CLAUDE_SKILL_DIR}/../claude-copilot/scripts/claude_copilot.py" uninstall --yes
```

Removal deletes only the owned `~/.local/bin/claude-copilot` and the `.zshrc` block between `# >>> claude-copilot (managed) >>>` and `# <<< claude-copilot (managed) <<<`. Foreign launchers, malformed blocks and symlinks cause refusal before writes. Report refusal or partial filesystem errors as such.

Retain `~/.local/share/claude-copilot`: credentials, account configuration, runtime, initial shell backup and native plugin. Retain CLIProxyAPI, `claude-auto`, the Apana plugin and global `settings.json`. Deleting retained data needs a separate request.

Do not print shell configuration or credential contents. Do not stop running sessions or proxy processes. Do not run install, login or verify during removal.
