#!/usr/bin/env python3
"""Link the skills of enabled Claude Code plugins into a folder that OpenCode reads.

Plugin install paths contain the version, so old links break after an update. A background job
(macOS LaunchAgent, Linux systemd user unit or Windows scheduled task, installed by install.py) runs
this script when ~/.claude/plugins/installed_plugins.json or ~/.claude/settings.json changes, and at
login. Run it by hand only to force a sync.

The links go to claude-plugin-skills in OpenCode's global config folder. It touches only the links
that differ. A plugin whose marketplace folder is listed in "skills" of opencode.json or
opencode.jsonc there is skipped. A skill that already exists in ~/.claude/skills, ~/.agents/skills
or the skills folder of the config folder is kept and not replaced by the plugin's copy. The apana
plugin is skipped: its own OpenCode plugin registers the skills meant for OpenCode.

Needs Python 3.9 or newer. On Windows, where a symlink needs a privilege, it falls back to a directory junction.

  --config-dir DIR  OpenCode's global config folder (default: $XDG_CONFIG_HOME/opencode, or
                    ~/.config/opencode); the job passes the folder found when it was installed
  --log FILE        write a traceback to FILE when the sync fails and delete FILE when it succeeds
                    (for a job that has no stderr, such as pythonw.exe on Windows)
"""
import argparse
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

HOME = Path.home()
PLUGINS = HOME / ".claude/plugins"
SETTINGS = HOME / ".claude/settings.json"
CONFIG_FILES = ("opencode.json", "opencode.jsonc")
OUT_NAME = "claude-plugin-skills"
# apana's OpenCode plugin registers its OpenCode skills with ${CLAUDE_SKILL_DIR} filled in and leaves out the
# Claude-only ones; a link with the same id would win over it and make it refuse /apana:<id>.
APANA = "apana"
IS_WINDOWS = os.name == "nt"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def default_config_dir():
    return Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config") / "opencode"


def read_jsonc(path):
    """The value of a JSON file that may have comments and trailing commas, as OpenCode's config files may."""
    text = path.read_text(encoding="utf-8-sig")
    out, i = [], 0
    while i < len(text):
        if text[i] == '"':
            j = i + 1
            while j < len(text) and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                raise ValueError(f"{path} is not valid JSON or JSONC: a /* comment is not closed")
            i = end + 2
            out.append(" ")
        else:
            if text[i] in "}]":
                k = len(out) - 1
                while k >= 0 and out[k].isspace():
                    k -= 1
                if k >= 0 and out[k] == ",":
                    del out[k]
            out.append(text[i])
            i += 1
    try:
        return json.loads("".join(out))
    except json.JSONDecodeError as error:
        raise ValueError(f"{path} is not valid JSON or JSONC: {error}") from None


def configured_skill_paths(config_dir, home):
    """The folders listed in "skills" of both config files; OpenCode combines the two lists.

    "skills" is a list, or the deprecated {"paths": [...], "urls": [...]}. A URL is a catalog and a
    relative path depends on where OpenCode runs, so neither can name a plugin folder and both are left out.
    """
    paths = []
    for name in CONFIG_FILES:
        path = config_dir / name
        if not path.is_file():
            continue
        config = read_jsonc(path)
        skills = config.get("skills") if isinstance(config, dict) else None
        entries = skills.get("paths") if isinstance(skills, dict) else skills
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, str):
                continue
            if entry == "~" or entry.startswith("~/"):
                paths.append((home / entry[2:]).resolve())
            elif Path(entry).is_absolute():
                paths.append(Path(entry).resolve())
    return paths


def install_path(entries):
    entry = next((e for e in entries if e.get("scope") == "user"), entries[0])
    return Path(entry["installPath"])


def skill_dirs(root):
    manifest = root / ".claude-plugin/plugin.json"
    entries = load(manifest).get("skills") if manifest.is_file() else None
    if isinstance(entries, str):
        entries = [entries]
    bases = [root / "skills"] + [root / e for e in entries or []]
    found = []
    for base in bases:
        if (base / "SKILL.md").is_file():
            found.append(base)
        elif base.is_dir():
            found += sorted(d for d in base.iterdir() if (d / "SKILL.md").is_file())
    if (root / "SKILL.md").is_file():
        found.append(root)
    unique = []
    for d in found:
        if d.resolve() not in [u.resolve() for u in unique]:
            unique.append(d)
    return unique


def existing_ids(config_dir):
    ids = {}
    for source in (HOME / ".claude/skills", HOME / ".agents/skills", config_dir / "skills"):
        if source.is_dir():
            for d in source.iterdir():
                if (d / "SKILL.md").is_file():
                    ids.setdefault(d.name, source / d.name)
    return ids


def link_target(path):
    """Where a symlink or a Windows junction points; None for anything else, a missing path included."""
    try:
        return os.readlink(path)
    except (OSError, ValueError):
        return None


def same_target(a, b):
    def norm(value):
        text = str(value)
        if text.startswith("\\\\?\\"):
            text = text[4:]
        return os.path.normcase(os.path.normpath(text))

    return norm(a) == norm(b)


def make_link(link, target):
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError as error:
        if not IS_WINDOWS:
            raise
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, text=True)
        if result.returncode != 0:
            raise OSError(f"no symlink ({error}) and mklink /J failed: {(result.stderr or result.stdout).strip()}")


def remove_link(link):
    try:
        os.unlink(link)
    except OSError:
        os.rmdir(link)  # a Windows junction is removed like an empty folder, and its target stays


def main(config_dir):
    # A file Claude Code has not written yet means nothing is enabled or installed, not an error.
    settings = load(SETTINGS) if SETTINGS.is_file() else {}
    enabled = [k for k, v in settings.get("enabledPlugins", {}).items() if v]
    installed_file = PLUGINS / "installed_plugins.json"
    installed = load(installed_file)["plugins"] if installed_file.is_file() else {}
    out = config_dir / OUT_NAME
    configured = [p for p in configured_skill_paths(config_dir, HOME) if p != out.resolve()]
    others = existing_ids(config_dir)

    out.mkdir(parents=True, exist_ok=True)

    linked, skipped = {}, []
    for key in enabled:
        if key not in installed:
            skipped.append(f"{key}: enabled but not installed")
            continue
        plugin, marketplace = key.split("@", 1)
        if plugin == APANA:
            skipped.append(f"{key}: apana's skills reach OpenCode through apana's own OpenCode plugin")
            continue
        root = install_path(installed[key])
        clone = (PLUGINS / "marketplaces" / marketplace).resolve()
        if any(p.is_relative_to(root.resolve()) or p in (clone, clone / "skills") for p in configured):
            skipped.append(f"{key}: already listed in \"skills\" of the OpenCode config")
            continue
        for d in skill_dirs(root):
            skill_id = plugin if d == root else d.name
            if skill_id in linked:
                skipped.append(f"{key}: {skill_id} already linked from {linked[skill_id][0]}")
                continue
            if skill_id in others:
                skipped.append(f"{key}: {skill_id} kept from {others[skill_id]}")
                continue
            linked[skill_id] = (key, d)

    # Touch only the links that differ, so a run with nothing new does not make the skill list flicker.
    # A real folder or file in the links folder is never a link, so it is never removed.
    for entry in out.iterdir():
        current = link_target(entry)
        if current is not None and (entry.name not in linked or not same_target(current, linked[entry.name][1])):
            remove_link(entry)
    for skill_id, (key, d) in linked.items():
        link = out / skill_id
        if link_target(link) is not None:
            continue
        if os.path.lexists(link):
            skipped.append(f"{key}: {skill_id} not linked, {link} exists and is not a link")
            continue
        make_link(link, d)

    for skill_id, (key, d) in sorted(linked.items()):
        print(f"linked {skill_id} <- {key}")
    for line in skipped:
        print(f"skipped {line}")
    print(f"{len(linked)} skills in {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config-dir", type=Path)
    parser.add_argument("--log", type=Path)
    args = parser.parse_args()
    config_dir = args.config_dir or default_config_dir()
    if args.log is None:
        main(config_dir)
    else:
        try:
            main(config_dir)
        except Exception:
            args.log.parent.mkdir(parents=True, exist_ok=True)
            with args.log.open("a", encoding="utf-8") as log:
                log.write(time.strftime("%Y-%m-%d %H:%M:%S ") + traceback.format_exc() + "\n")
            sys.exit(1)
        args.log.unlink(missing_ok=True)
