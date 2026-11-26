---
name: opencode-plugin-skills-sync
description: "Sets up, checks and repairs the automatic sync that keeps the skills of Claude Code plugins other than apana visible in OpenCode after a plugin is installed, updated, enabled or disabled, on macOS (LaunchAgent), Linux (systemd user unit) and Windows (scheduled task). The job refreshes the links in ~/.config/opencode/claude-plugin-skills when ~/.claude/plugins/installed_plugins.json or ~/.claude/settings.json changes. Use when the user wants OpenCode to pick up plugin updates by itself, a plugin skill is missing or stale in OpenCode after `claude plugin update`, the sync job seems stuck, or a new computer needs the setup. Romanian: \"auto update în OpenCode\", \"skill-ul lipsește în OpenCode după update\", \"sincronizează skill-urile pluginurilor\"."
---

# opencode-plugin-skills-sync

Claude Code keeps each plugin under a path that contains its version, so a symlink to a plugin skill breaks on the next update. OpenCode reads the folders listed in `skills` of its global config (`opencode.json` and `opencode.jsonc` in `~/.config/opencode`, or in `$XDG_CONFIG_HOME/opencode` when that is set; the two lists are combined), and one of them, `claude-plugin-skills` in that folder, holds one link per skill of every enabled plugin except apana itself (apana's OpenCode plugin registers its OpenCode skills, and leaves out the Claude-only ones). This skill keeps that folder right without a manual step.

Two parts, both installed by `scripts/install.py`, which picks the right job for the system it runs on:

- **`sync-claude-plugin-skills.py` in the config folder** (canonical copy: `scripts/sync-claude-plugin-skills.py`). It rebuilds the links and touches only the ones that differ, so the skill list in OpenCode does not flicker. It skips a plugin whose marketplace folder is already listed in `skills` of either config file (read with comments, trailing commas and the deprecated `{"paths": [...]}` form, as OpenCode reads them), and it keeps a skill that already exists in `~/.claude/skills`, `~/.agents/skills` or the `skills` folder of the config folder. It needs Python 3.9 or newer and only the standard library.
- **A background job that runs the script:**

  | System | Job | When it runs |
  | --- | --- | --- |
  | macOS | LaunchAgent `local.opencode-plugin-skills-sync` in `~/Library/LaunchAgents`, runs `/usr/bin/python3` | when `installed_plugins.json` or `settings.json` changes, and at login. Errors: `~/Library/Logs/opencode-plugin-skills-sync.log` (the file exists only after a failed run) |
  | Linux | systemd user units `opencode-plugin-skills-sync.path` and `.service` in `~/.config/systemd/user` | when one of the two files changes, and at login. Errors: `journalctl --user -u opencode-plugin-skills-sync.service` |
  | Windows | Task Scheduler task `opencode-plugin-skills-sync`, runs `pythonw.exe` (no console window) | at logon and every 15 minutes, also on battery. Windows cannot watch a file, so it polls; a run with nothing new changes nothing. Errors: `%LOCALAPPDATA%\opencode-plugin-skills-sync\sync.log` (the file exists only after a failed run) |

On Windows a symlink needs a privilege that most users do not have, so the script makes a directory junction instead. A junction is removed like an empty folder and its target stays.

## What was verified

- Verified: the installer, the sync script and the job files for all three systems are tested on a throw-away home folder (`scripts/test_install.py`, also run with a home path that has spaces).
- **Not verified:** that launchd runs the current macOS job (with `--config-dir` and `--log`); only an earlier version of it ran on the author's Mac. Also not verified: that systemd and Task Scheduler accept the Linux and Windows job files, that systemd sees a file that is replaced by a rename, and that OpenCode follows a Windows junction. No Linux or Windows machine was available. On the first install there, run `--check` and read what it reports, then change one plugin and look at the links.
- Where OpenCode keeps its global config follows its docs (`~/.config/opencode/`, also on Windows) and OpenCode 2.4.2: with `XDG_CONFIG_HOME` set, `opencode debug paths` names `$XDG_CONFIG_HOME/opencode`, and `opencode debug config` reads both `opencode.json` and `opencode.jsonc`. A job does not start from the shell, so the installer writes the folder it found into the job (`--config-dir`); after changing `XDG_CONFIG_HOME`, run the installer again. `CLAUDE_CONFIG_DIR` and `OPENCODE_CONFIG_DIR` are not read. The Linux units are written to `~/.config/systemd/user` even when `XDG_CONFIG_HOME` is set; not verified on a system where it is.

## Steps

1. Look first, change nothing:

   ```bash
   python3 -I "${CLAUDE_SKILL_DIR}/scripts/install.py" --check
   ```

   On Windows use `python` or `py -3` instead of `python3`. Lines start with `ok`, `info`, `warn` or `fail`; a `warn` or `fail` makes the exit code 1. If everything is `ok`, stop and say so.

2. To install or repair, run the same command without `--check` (add `--dry-run` to show what would change and write nothing). It copies the script, writes the job files, runs the sync once (a good run deletes the job's error log), then loads the job (`launchctl`, `systemctl --user` or `schtasks`) only if a file changed, the job is not loaded or its last run failed, and lists broken links. It is idempotent.

3. Handle what it reports:
   - `does not list ... in "skills"`: OpenCode will not read the links. Show the user the line to add (the folder the message names, for example `"~/.config/opencode/claude-plugin-skills"`, in the `skills` array of `opencode.jsonc` or `opencode.json`) and ask. The installer never edits OpenCode's config.
   - `is not valid JSON or JSONC`: show the user the file and the position from the message. The sync fails too until the file is fixed; do not fix it without asking.
   - `last exit code ... is N`, `the sync service failed`, or `log is not empty`: read the log or the journal named in the message and show the last lines. Once the cause is fixed, run the installer without `--check`: it loads the job again, which on Linux also resets the failed state of the service (not verified).
   - `broken link(s)`: run the installer without `--check`; the sync removes links that no longer match.
   - `settings.json does not exist`: Claude Code has not written it yet; nothing to fix here.
   - `systemctl not found` or `no systemd user session` (a Linux without systemd, a container, WSL1): the job cannot be loaded. The script still works; ask the user, then add a cron entry (`crontab -e`): `*/15 * * * * /usr/bin/python3 -I "$HOME/.config/opencode/sync-claude-plugin-skills.py"` (with `XDG_CONFIG_HOME` set, use the script path the installer printed and add `--config-dir` with its folder). Not tested.
   - `loading job ... failed` on Windows: show the `schtasks` message. The task file stays in `%LOCALAPPDATA%\opencode-plugin-skills-sync\task.xml` and can be imported by hand in Task Scheduler.

4. Report in a few lines what was new, updated or unchanged. Whether an already open OpenCode session lists a changed skill without a restart is not verified; if a skill is still missing, the user opens a new session. Do not restart OpenCode or its service yourself.

## Things worth knowing

- **Edit the skill, not the installed copy.** `install.py` overwrites `sync-claude-plugin-skills.py` in the config folder with `scripts/sync-claude-plugin-skills.py`. After a change in the apana repository, run the tests from its root, then the installer: `npm run test:opencode-plugin-skills-sync`. The tests use throw-away home folders, never call `launchctl`, `systemctl` or `schtasks`, and fail if the real job files, script or links change.
- **Why a background job and not an OpenCode plugin:** OpenCode runs as a background service and a plugin's `setup()` runs only when the service starts, so an update made while it runs would be missed.
- **The macOS job runs about twice per change** (`ThrottleInterval` is 10 s). The script is idempotent, so this is harmless. The systemd service has no start limit, so several quick writes do not stop the path unit.
- **A plugin with a stable marketplace folder needs no sync.** Listing `~/.claude/plugins/marketplaces/<marketplace>/skills` in `skills` of the OpenCode config makes OpenCode read it directly, and the sync then skips that plugin. The checkout can be newer than the installed version between `claude plugin marketplace update` and `claude plugin update`.
- **The job's Python is fixed at install time:** `/usr/bin/python3` on macOS and Linux (the Linux job falls back to the python3 on `PATH`), the python that ran `install.py` on Windows. If that python is removed, run the installer again.
- **Do not print `settings.json`**: it may hold tokens. The script only reads `enabledPlugins`.

## Uninstall

macOS:

```bash
launchctl bootout gui/$(id -u)/local.opencode-plugin-skills-sync
rm ~/Library/LaunchAgents/local.opencode-plugin-skills-sync.plist
```

Linux:

```bash
systemctl --user disable --now opencode-plugin-skills-sync.path opencode-plugin-skills-sync.service
rm ~/.config/systemd/user/opencode-plugin-skills-sync.{path,service}
systemctl --user daemon-reload
```

Windows (PowerShell):

```powershell
schtasks /Delete /TN opencode-plugin-skills-sync /F
```

The script and the links can stay; remove the `claude-plugin-skills` folder and its line in the OpenCode config only if the user asks.
