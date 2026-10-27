---
name: uninstall-claude-openai
description: "Use when the user asks to uninstall or remove claude-openai, undo its installation, or remove its launcher or shell alias. Keeps OAuth credentials and shared dependencies. For installation or connection checks, use apana:claude-openai."
---

# uninstall-claude-openai

Remove the launcher and managed shell alias installed by `apana:claude-openai`. Reuse its bundled uninstaller; do not edit shell configuration or delete installation folders by hand. This is launcher removal, not credential revocation or a complete data purge.

## Preview

Resolve `${CLAUDE_SKILL_DIR}` from this skill's expanded base directory. The uninstaller is in the sibling `claude-openai` skill from the same plugin version. If it is missing, stop and report the missing file; do not install dependencies or substitute an old installed copy.

Only Python 3 and access to the user's files are needed. Inspect whether `~/.local/bin/claude-openai` and the managed block in `~/.zshrc` exist, reporting presence only. Do not print shell configuration or credential contents.

```sh
python3 "${CLAUDE_SKILL_DIR}/../claude-openai/scripts/claude_openai.py" uninstall --dry-run
```

The preview validates the launcher ownership marker and shell-block structure. Its message is generic, even when nothing is installed; it does not list actual changes or guarantee a later write will succeed. On failure, report the error and stop. An unowned launcher or malformed block needs the user's decision, not forced deletion.

Explain the scope before removal:

- Removes `~/.local/bin/claude-openai` and the block between `# >>> claude-openai >>>` and `# <<< claude-openai <<<` in `~/.zshrc`. Unrelated shell content stays.
- Keeps `~/.local/share/claude-openai/`, including OAuth credentials, proxy configuration, the installed Python copy and the `zshrc.before` backup. The backup is not restored.
- Keeps CLIProxyAPI, `claude`, `claude-auto`, the Apana plugin and its skills. Global `~/.claude/settings.json` is not edited.

If the user only asked for a preview, stop after the dry run. If removal was not explicitly requested, ask for confirmation before continuing. Creating or editing this skill is not a request to uninstall the current machine.

## Remove and check

After a successful preview and explicit removal intent, run:

```sh
python3 "${CLAUDE_SKILL_DIR}/../claude-openai/scripts/claude_openai.py" uninstall
```

Use exactly the documented commands: `uninstall --help` is not a safe preview. Do not run install, login or verify as part of removal. Do not stop running sessions or proxy processes. Removing credentials, retained state or a shared dependency requires a separate explicit request; this skill does not purge them.

Success is silent with exit status 0. On a nonzero exit, report the error; removal may be partial because shell editing and launcher removal are sequential. Inspect the remaining targets without exposing their contents, and do not claim completion from the preview alone.

Check whether the owned launcher and managed alias block remain. Report what was removed, already absent, or left unresolved, and where retained data lives. Running uninstall again is safe for a normally owned installation. Other aliases or executables with the same name are outside this uninstaller's scope.

Existing shells may retain the old alias. Tell the user to open a new terminal when ready; do not replace their current shell or interrupt a session. To reinstall later, use `apana:claude-openai`.
