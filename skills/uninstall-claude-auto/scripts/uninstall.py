#!/usr/bin/env python3
"""uninstall.py: remove claude-auto: its PATH block in the zsh rc file and the ~/.claude/claude-auto/ folder.

    uninstall.py [--dry-run] [--no-rc] [--purge-notes] [--rc FILE] [--home DIR]

  1. removes the block the install-claude-auto skill added to the rc file (and the one blank line before it), nothing
     else in the rc; the <rc>.claude-auto.bak copy goes too when the rc is back to exactly what it saved;
  2. removes the wrapper, its tests and known cooperation runtime files, then their folders only when empty;
  3. keeps the handoff notes in ~/.claude/handoffs/auto/ unless --purge-notes is given.

Running it twice is fine. ~/.claude/settings.json is only read, never edited. Exit codes: 0 done, 1 done but something
needs attention (rc markers broken, foreign files kept).
"""
import argparse, os, re, shutil, stat, subprocess, sys, tempfile

START = "# >>> claude-auto >>>"
END = "# <<< claude-auto <<<"
FILES = ("claude-auto", "test_claude_auto.py", "claude_auto_managed.py", "test_managed.py")
ENC = dict(encoding="utf-8", errors="surrogateescape", newline="")   # keep every byte and line ending of the rc as is

problems = []


def say(tag, msg):
    print("%-5s %s" % (tag, msg))


def attention(msg):
    problems.append(msg)
    say("warn", msg)


def write_atomic(path, data, mode):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".claude-auto-")
    try:
        with os.fdopen(fd, "w", **ENC) as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def split_lines(text):
    return re.findall(r"[^\n]*\n|[^\n]+", text)


def find_block(text):
    """(lines, start, end) of the marked block, None when there is none; ValueError when the markers are broken."""
    lines = split_lines(text)
    starts = [i for i, l in enumerate(lines) if l.strip() == START]
    ends = [i for i, l in enumerate(lines) if l.strip() == END]
    if not starts and not ends:
        return None
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
        raise ValueError("the '%s' / '%s' markers are repeated, reversed or one of them is missing" % (START, END))
    return lines, starts[0], ends[0]


def without_block(text):
    """The rc text without the block (and the one blank line the install put before it); None if there is no block."""
    found = find_block(text)
    if found is None:
        return None
    lines, s, e = found
    if s > 0 and lines[s - 1].strip() == "":
        s -= 1
    return "".join(lines[:s] + lines[e + 1:])


def mentions_outside_block(text):
    return [(i + 1, l.strip()) for i, l in enumerate(split_lines(text)) if "claude-auto" in l]


def default_rc(home):
    return os.path.join(os.environ.get("ZDOTDIR") or home, ".zshrc")


def remove_rc_block(rc, dry):
    real = os.path.realpath(rc)          # a symlinked rc (dotfiles repo) is edited where it really lives
    if not os.path.isfile(real):
        say("ok", "%s: no such file, nothing to remove" % rc)
        return
    with open(real, **ENC) as f:
        old = f.read()
    try:
        new = without_block(old)
    except ValueError as e:
        attention("%s was not edited: %s. Remove the lines between the markers by hand." % (rc, e))
        return
    if new is None:
        say("ok", "%s: no claude-auto block, nothing to remove" % rc)
        new = old
    elif dry:
        say("ok", "%s: would remove the PATH block" % rc)
    else:
        write_atomic(real, new, stat.S_IMODE(os.stat(real).st_mode))
        say("ok", "%s: PATH block removed" % rc)
    for n, line in mentions_outside_block(new):
        attention("%s:%d still mentions claude-auto (it is not part of the block, so it was left alone): %s"
                  % (rc, n, line[:80]))
    backup = real + ".claude-auto.bak"
    if os.path.isfile(backup) and not dry:
        with open(backup, **ENC) as f:
            same = f.read() == new
        if same:
            os.remove(backup)
            say("ok", "%s removed (the rc is exactly what it saved)" % backup)
        else:
            say("info", "%s kept: the rc differs from it (you changed it after the install)" % backup)


def running_wrappers(script):
    r = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True)
    return [l.strip() for l in r.stdout.splitlines() if script in l and str(os.getpid()) != l.split()[0]]


def remove_cooperation(target, dry):
    """Remove only known runtime files and empty owned folders, never traverse directory symlinks."""
    root = os.path.join(target, "cooperation")
    if not os.path.lexists(root):
        return False
    if os.path.islink(root) or not os.path.isdir(root):
        return True
    remaining = set(os.listdir(root))
    for directory, names in ((".claude-plugin", ("plugin.json",)),
                             ("hooks", ("hooks.json", "register.ts")), ("scripts", ("registry.py", "managed_mcp.py")),
                             ("types", ("index.d.ts",))):
        folder = os.path.join(root, directory)
        if os.path.islink(folder) or not os.path.isdir(folder):
            continue
        left = set(os.listdir(folder))
        for name in names:
            path = os.path.join(folder, name)
            if os.path.islink(path) or os.path.isfile(path):
                if not dry:
                    os.remove(path)
                left.discard(name)
                say("ok", "%s: %sremoved" % (path, "would be " if dry else ""))
        if not left:
            if not dry:
                os.rmdir(folder)
            remaining.discard(directory)
    if not remaining:
        if not dry:
            os.rmdir(root)
        say("ok", "%s: %sfolder removed" % (root, "would be " if dry else ""))
    return bool(remaining)


def remove_files(target, dry):
    if os.path.islink(target) or (os.path.lexists(target) and not os.path.isdir(target)):
        attention("%s is not a plain folder; it was left alone" % target)
        return
    if not os.path.isdir(target):
        say("ok", "%s: not there, nothing to remove" % target)
        return
    live = running_wrappers(os.path.join(target, "claude-auto"))
    if live:
        attention("%d claude-auto session(s) still running; they keep working but cannot hand off any more" % len(live))
    for name in FILES:
        path = os.path.join(target, name)
        if os.path.lexists(path):
            if not dry:
                os.remove(path)
            say("ok", "%s: %sremoved" % (path, "would be " if dry else ""))
    cache = os.path.join(target, "__pycache__")
    if os.path.isdir(cache) and not os.path.islink(cache) and not dry:
        shutil.rmtree(cache)
    cooperation_left = remove_cooperation(target, dry)
    removed = set(FILES) | {"__pycache__"}
    if not cooperation_left:
        removed.add("cooperation")
    left = sorted(n for n in os.listdir(target) if n not in removed)
    if left:
        attention("%s kept, it also holds files that are not claude-auto's: %s" % (target, ", ".join(left)))
    elif dry:
        say("ok", "%s: would remove the folder" % target)
    else:
        os.rmdir(target)
        say("ok", "%s: folder removed" % target)


def handle_notes(notes, purge, dry):
    if not os.path.isdir(notes):
        return
    count = sum(len(fs) for _, _, fs in os.walk(notes))
    if not purge:
        say("info", "%s kept (%d file(s) of handoff notes and logs). Delete with --purge-notes." % (notes, count))
    elif dry:
        say("ok", "%s: would delete %d file(s)" % (notes, count))
    elif os.path.islink(notes):
        os.remove(notes)
        say("ok", "%s: link removed (its target was not touched)" % notes)
    else:
        shutil.rmtree(notes)
        say("ok", "%s: deleted (%d file(s))" % (notes, count))


def main():
    ap = argparse.ArgumentParser(description="Remove claude-auto and its PATH block from the zsh rc file.")
    ap.add_argument("--home", help="home folder to uninstall from (default: ~)")
    ap.add_argument("--rc", help="rc file to edit (default: $ZDOTDIR/.zshrc or ~/.zshrc)")
    ap.add_argument("--no-rc", action="store_true", help="do not edit any rc file")
    ap.add_argument("--dry-run", action="store_true", help="show what would be removed, remove nothing")
    ap.add_argument("--purge-notes", action="store_true", help="also delete ~/.claude/handoffs/auto (notes and logs)")
    args = ap.parse_args()

    home = os.path.abspath(os.path.expanduser(args.home or "~"))
    target = os.path.join(home, ".claude", "claude-auto")
    rc = os.path.abspath(os.path.expanduser(args.rc)) if args.rc else default_rc(home)

    if args.no_rc:
        say("info", "--no-rc: the rc file was not edited")
    else:
        remove_rc_block(rc, args.dry_run)
    remove_files(target, args.dry_run)
    handle_notes(os.path.join(home, ".claude", "handoffs", "auto"), args.purge_notes, args.dry_run)

    settings = os.path.join(home, ".claude", "settings.json")
    if os.path.isfile(settings):
        with open(settings, **ENC) as f:
            if "claude-auto" in f.read():
                attention("%s mentions claude-auto; it was not touched, check it by hand" % settings)

    print()
    say("done" if not problems else "done*", "dry run, nothing was removed" if args.dry_run else "uninstalled")
    if not args.dry_run:
        print("      Open a new terminal (or run `exec zsh`): the one you are in still has the old PATH.")
    if problems:
        print("      %d thing(s) need attention, see the 'warn' lines above." % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
