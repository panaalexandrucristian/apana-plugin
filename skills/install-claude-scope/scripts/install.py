#!/usr/bin/env python3
"""Install the bundled claude-scope command without touching Claude settings."""
import argparse
import os
import pathlib
import shutil
import stat
import sys

START = "# >>> claude-scope >>>"
END = "# <<< claude-scope <<<"
BLOCK = START + '\nexport PATH="$HOME/.claude/claude-scope:$PATH"\n' + END + "\n"


def source_file():
    return pathlib.Path(__file__).resolve().parent.parent / "assets/claude_scope.py"


def default_rc(home):
    zdot = os.environ.get("ZDOTDIR")
    if zdot:
        path = pathlib.Path(os.path.expandvars(os.path.expanduser(zdot)))
        if not path.is_absolute():
            path = home / path
        return path / ".zshrc"
    return home / ".zshrc"


def update_block(text):
    starts, ends = text.count(START), text.count(END)
    if starts != ends or starts > 1:
        raise ValueError("claude-scope markers are unbalanced")
    if starts == 1:
        before, rest = text.split(START, 1)
        _, after = rest.split(END, 1)
        return before.rstrip("\n") + ("\n" if before else "") + BLOCK + after.lstrip("\n")
    return text.rstrip("\n") + ("\n\n" if text else "") + BLOCK


def install(dry_run=False, no_rc=False, rc_path=None):
    home = pathlib.Path.home()
    source = source_file()
    if not source.is_file():
        raise RuntimeError("bundled claude_scope.py was not found")
    destination_dir = home / ".claude/claude-scope"
    destination = destination_dir / "claude-scope"
    rc = pathlib.Path(rc_path).expanduser() if rc_path else default_rc(home)

    if dry_run:
        print("info would install %s" % destination)
        if not no_rc:
            print("info would update %s" % rc)
        return 0

    destination_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    destination.chmod(destination.stat().st_mode | stat.S_IXUSR)
    print("ok installed %s" % destination)

    if not no_rc:
        rc.parent.mkdir(parents=True, exist_ok=True)
        original = rc.read_text(encoding="utf-8") if rc.exists() else ""
        try:
            updated = update_block(original)
        except ValueError as exc:
            raise RuntimeError("%s in %s" % (exc, rc))
        backup = pathlib.Path(str(rc) + ".claude-scope.bak")
        if rc.exists() and not backup.exists():
            shutil.copy2(rc, backup)
        rc.write_text(updated, encoding="utf-8")
        print("ok PATH block in %s" % rc)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Install claude-scope on PATH")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-rc", action="store_true")
    parser.add_argument("--rc")
    args = parser.parse_args(argv)
    try:
        return install(args.dry_run, args.no_rc, args.rc)
    except (OSError, RuntimeError) as exc:
        sys.stderr.write("fail %s\n" % exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
