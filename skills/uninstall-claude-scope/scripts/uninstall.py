#!/usr/bin/env python3
"""Safely undo the files written by install-claude-scope.

Only the installer-owned command, its marked PATH block, and an installer-created
backup are eligible for removal. Unknown files and unrelated Claude state stay.
"""
import argparse
import os
import pathlib
import shutil
import stat
import sys
import tempfile

START = "# >>> claude-scope >>>"
END = "# <<< claude-scope <<<"
OWNED_COMMAND = "claude-scope"
BACKUP_SUFFIX = ".claude-scope.bak"


def say(tag, message):
    print("%-5s %s" % (tag, message))


def default_rc(home):
    zdot = os.environ.get("ZDOTDIR")
    if zdot:
        path = pathlib.Path(os.path.expandvars(os.path.expanduser(zdot)))
        if not path.is_absolute():
            path = home / path
        return path / ".zshrc"
    return home / ".zshrc"


def split_marked_block(text):
    starts, ends = text.count(START), text.count(END)
    if starts == 0 and ends == 0:
        return None
    if starts != 1 or ends != 1 or text.index(END) < text.index(START):
        raise ValueError("claude-scope markers are unbalanced, repeated, or reversed")
    before, rest = text.split(START, 1)
    _, after = rest.split(END, 1)
    # install.py adds one blank line before a new block; remove only that one.
    if before.endswith("\n\n"):
        before = before[:-1]
    return before + after.lstrip("\n")


def atomic_write(path, text):
    fd, temporary = tempfile.mkstemp(prefix=".claude-scope-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def installer_owned_command(path):
    """Conservative recognition of the copied Python launcher.

    A foreign executable with the same name is kept. Every launcher installed by
    install.py is a copy of claude_scope.py and carries both stable identifiers.
    """
    if path.is_symlink() or not path.is_file():
        return False
    try:
        sample = path.read_text(encoding="utf-8", errors="replace")[:4096]
    except OSError:
        return False
    return '"""claude-scope: guarded implementation workflow' in sample and "MIN_CLAUDE_VERSION" in sample


def remove_rc(rc, dry_run):
    if rc.is_symlink():
        say("warn", "%s is a symlink; rc was left alone" % rc)
        return 1
    if not rc.is_file():
        say("ok", "%s: no rc file, nothing to remove" % rc)
        return 0
    with rc.open("r", encoding="utf-8", newline="") as stream:
        old = stream.read()
    try:
        new = split_marked_block(old)
    except ValueError as error:
        say("warn", "%s was not edited: %s" % (rc, error))
        return 1
    if new is None:
        say("ok", "%s: no claude-scope block, nothing to remove" % rc)
        return 0
    if dry_run:
        say("ok", "%s: would remove installer PATH block" % rc)
        return 0
    atomic_write(rc, new)
    say("ok", "%s: installer PATH block removed" % rc)
    backup = pathlib.Path(str(rc) + BACKUP_SUFFIX)
    if backup.is_file():
        with backup.open("r", encoding="utf-8", newline="") as stream:
            saved = stream.read()
        if saved == new:
            backup.unlink()
            say("ok", "%s: removed (rc restored to saved bytes)" % backup)
        else:
            say("info", "%s kept: rc differs from saved bytes" % backup)
    return 0


def remove_command(home, dry_run):
    directory = home / ".claude" / "claude-scope"
    command = directory / OWNED_COMMAND
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        say("warn", "%s is not a plain directory; it was left alone" % directory)
        return 1
    if not directory.exists():
        say("ok", "%s: not present, nothing to remove" % directory)
        return 0
    status = 0
    if command.exists() or command.is_symlink():
        if installer_owned_command(command):
            if dry_run:
                say("ok", "%s: would remove installer command" % command)
            else:
                command.unlink()
                say("ok", "%s: installer command removed" % command)
        else:
            say("warn", "%s is not recognized as installer-owned; it was kept" % command)
            status = 1
    else:
        say("ok", "%s: installer command is absent" % command)
    foreign = sorted(item.name for item in directory.iterdir())
    if foreign:
        say("info", "%s kept; foreign files remain: %s" % (directory, ", ".join(foreign)))
    elif dry_run:
        say("ok", "%s: would remove empty installer directory" % directory)
    else:
        directory.rmdir()
        say("ok", "%s: empty installer directory removed" % directory)
    return status


def uninstall(home, rc=None, no_rc=False, dry_run=False):
    home = pathlib.Path(home).expanduser().resolve()
    rc = pathlib.Path(rc).expanduser() if rc else default_rc(home)
    warnings = 0
    if no_rc:
        say("info", "--no-rc: rc was not edited")
    else:
        warnings += remove_rc(rc, dry_run)
    warnings += remove_command(home, dry_run)
    say("done" if not warnings else "done*", "dry run; nothing was removed" if dry_run else "uninstall finished")
    if not dry_run:
        print("      Open a new terminal (or run `exec zsh`) to refresh PATH.")
    return 1 if warnings else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Safely remove artifacts installed by install-claude-scope")
    parser.add_argument("--home", help="home directory to uninstall from (default: ~)")
    parser.add_argument("--rc", help="zsh rc to edit (default: $ZDOTDIR/.zshrc or ~/.zshrc)")
    parser.add_argument("--no-rc", action="store_true", help="leave rc untouched")
    parser.add_argument("--dry-run", action="store_true", help="report actions without writing")
    args = parser.parse_args(argv)
    try:
        return uninstall(args.home or pathlib.Path.home(), args.rc, args.no_rc, args.dry_run)
    except OSError as error:
        sys.stderr.write("fail %s\n" % error)
        return 1


if __name__ == "__main__":
    sys.exit(main())
