#!/usr/bin/env python3
"""uninstall.py: remove opencode-auto: its PATH block in the zsh rc file, the plugin link, the launcher and the `enabled` file.

    uninstall.py [--dry-run] [--no-rc] [--purge-notes] [--rc FILE] [--home DIR]

  1. removes the block the install-opencode-auto skill added to the rc file (and the one blank line before it), nothing else in the rc;
     the <rc>.opencode-auto.bak copy goes too when the rc is back to exactly what it saved;
  2. removes the link <config>/plugins/apana-auto (the repository behind it is not touched) and the launcher <config>/opencode-auto/,
     then their folders only when empty;
  3. removes the `enabled` file under <state>/opencode/apana/auto/: handoffs stop at once, in sessions that are already running too;
  4. keeps the handoff notes (<data>/opencode/apana/handoffs/auto/) and auto.log unless --purge-notes is given.

<config> is $XDG_CONFIG_HOME/opencode or ~/.config/opencode, <state> is $XDG_STATE_HOME or ~/.local/state, <data> is $XDG_DATA_HOME or
~/.local/share; with --home all three are under that home. OpenCode's own config file is never touched. Running it twice is fine.
Exit codes: 0 done, 1 done but something needs attention (rc markers broken, foreign files kept).
"""
import argparse, os, re, shutil, stat, sys, tempfile

START = "# >>> opencode-auto >>>"
END = "# <<< opencode-auto <<<"
LINK_NAME = "apana-auto"
LAUNCHER = "opencode-auto"
ENC = dict(encoding="utf-8", errors="surrogateescape", newline="")   # keep every byte and line ending of the rc as is

problems = []


def say(tag, msg):
    print("%-5s %s" % (tag, msg))


def attention(msg):
    problems.append(msg)
    say("warn", msg)


def write_atomic(path, data, mode):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".opencode-auto-")
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
    return [(i + 1, l.strip()) for i, l in enumerate(split_lines(text)) if "opencode-auto" in l]


def default_rc(home):
    return os.path.join(os.environ.get("ZDOTDIR") or home, ".zshrc")


def places(home, explicit_home):
    """(config, state, data) folders. With --home they come from that home alone, so a throw-away home never reaches the real one."""
    if explicit_home:
        return (os.path.join(home, ".config", "opencode"), os.path.join(home, ".local", "state"), os.path.join(home, ".local", "share"))
    return (os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "opencode"),
            os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state"),
            os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"))


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
        say("ok", "%s: no opencode-auto block, nothing to remove" % rc)
        new = old
    elif dry:
        say("ok", "%s: would remove the PATH block" % rc)
    else:
        write_atomic(real, new, stat.S_IMODE(os.stat(real).st_mode))
        say("ok", "%s: PATH block removed" % rc)
    for n, line in mentions_outside_block(new):
        attention("%s:%d still mentions opencode-auto (it is not part of the block, so it was left alone): %s" % (rc, n, line[:80]))
    backup = real + ".opencode-auto.bak"
    if os.path.isfile(backup) and not dry:
        with open(backup, **ENC) as f:
            same = f.read() == new
        if same:
            os.remove(backup)
            say("ok", "%s removed (the rc is exactly what it saved)" % backup)
        else:
            say("info", "%s kept: the rc differs from it (you changed it after the install)" % backup)


def remove_empty(folder, stop, dry):
    """Remove `folder` and its parents up to (not including) `stop`, each only when empty. Never follows a link."""
    while folder != stop and folder.startswith(stop + os.sep) and os.path.isdir(folder) and not os.path.islink(folder):
        if os.listdir(folder):
            return
        if not dry:
            os.rmdir(folder)
        say("ok", "%s: %sfolder removed" % (folder, "would be " if dry else ""))
        folder = os.path.dirname(folder)


def remove_link(config, dry):
    plugins = os.path.join(config, "plugins")
    link = os.path.join(plugins, LINK_NAME)
    if os.path.islink(link):
        if not dry:
            os.remove(link)
        say("ok", "%s: %sremoved (the checkout it pointed to was not touched)" % (link, "would be " if dry else ""))
    elif os.path.lexists(link):
        attention("%s is not a link, so it is not ours; it was left alone" % link)
        return
    else:
        say("ok", "%s: not there, nothing to remove" % link)
    if os.path.isdir(plugins) and not os.path.islink(plugins):
        left = [name for name in os.listdir(plugins) if not (dry and name == LINK_NAME)]   # a dry run has not removed the link
        if not left:
            if not dry:
                os.rmdir(plugins)
            say("ok", "%s: %sfolder removed" % (plugins, "would be " if dry else ""))


def remove_launcher(config, dry):
    folder = os.path.join(config, LAUNCHER)
    if os.path.islink(folder) or (os.path.lexists(folder) and not os.path.isdir(folder)):
        attention("%s is not a plain folder; it was left alone" % folder)
        return
    if not os.path.isdir(folder):
        say("ok", "%s: not there, nothing to remove" % folder)
        return
    path = os.path.join(folder, LAUNCHER)
    if os.path.lexists(path):
        if not dry:
            os.remove(path)
        say("ok", "%s: %sremoved" % (path, "would be " if dry else ""))
    left = sorted(n for n in os.listdir(folder) if n != LAUNCHER)
    if left:
        attention("%s kept, it also holds files that are not opencode-auto's: %s" % (folder, ", ".join(left)))
    elif dry:
        say("ok", "%s: would remove the folder" % folder)
    else:
        os.rmdir(folder)
        say("ok", "%s: folder removed" % folder)


def remove_enabled(state, dry):
    folder = os.path.join(state, "opencode", "apana", "auto")
    flag = os.path.join(folder, "enabled")
    if os.path.lexists(flag):
        if not dry:
            os.remove(flag)
        say("ok", "%s: %sremoved (handoffs stop at once)" % (flag, "would be " if dry else ""))
    else:
        say("ok", "%s: not there, nothing to remove" % flag)
    log = os.path.join(folder, "auto.log")
    if os.path.isfile(log):
        say("info", "%s kept. Delete with --purge-notes." % log)
    elif not dry:
        remove_empty(folder, state, dry)


def handle_notes(notes, state, purge, dry):
    log = os.path.join(state, "opencode", "apana", "auto", "auto.log")
    if not os.path.isdir(notes) and not os.path.isfile(log):
        return
    count = sum(len(fs) for _, _, fs in os.walk(notes)) if os.path.isdir(notes) else 0
    if not purge:
        if os.path.isdir(notes):
            say("info", "%s kept (%d file(s) of handoff notes). Delete with --purge-notes." % (notes, count))
        return
    if os.path.islink(notes):
        if not dry:
            os.remove(notes)
        say("ok", "%s: %slink removed (its target was not touched)" % (notes, "would be " if dry else ""))
    elif os.path.isdir(notes):
        if not dry:
            shutil.rmtree(notes)
        say("ok", "%s: %sdeleted (%d file(s))" % (notes, "would be " if dry else "", count))
    if os.path.isfile(log):
        if not dry:
            os.remove(log)
        say("ok", "%s: %sremoved" % (log, "would be " if dry else ""))
        remove_empty(os.path.dirname(log), state, dry)


def main():
    ap = argparse.ArgumentParser(description="Remove opencode-auto: the PATH block, the plugin link, the launcher and the enabled file.")
    ap.add_argument("--home", help="home folder to uninstall from (default: ~)")
    ap.add_argument("--rc", help="rc file to edit (default: $ZDOTDIR/.zshrc or ~/.zshrc)")
    ap.add_argument("--no-rc", action="store_true", help="do not edit any rc file")
    ap.add_argument("--dry-run", action="store_true", help="show what would be removed, remove nothing")
    ap.add_argument("--purge-notes", action="store_true", help="also delete the handoff notes and auto.log")
    args = ap.parse_args()

    home = os.path.abspath(os.path.expanduser(args.home or "~"))
    config, state, data = places(home, bool(args.home))
    rc = os.path.abspath(os.path.expanduser(args.rc)) if args.rc else default_rc(home)

    if args.no_rc:
        say("info", "--no-rc: the rc file was not edited")
    else:
        remove_rc_block(rc, args.dry_run)
    remove_link(config, args.dry_run)
    remove_launcher(config, args.dry_run)
    remove_enabled(state, args.dry_run)
    handle_notes(os.path.join(data, "opencode", "apana", "handoffs", "auto"), state, args.purge_notes, args.dry_run)

    print()
    say("done" if not problems else "done*", "dry run, nothing was removed" if args.dry_run else "uninstalled")
    if not args.dry_run:
        print("      A running OpenCode drops the server part within about 10 seconds; a TUI that is already open keeps its TUI part until it is closed (it does nothing without handoffs).")
        print("      Open a new terminal (or run `exec zsh`): the one you are in still has the old PATH.")
    if problems:
        print("      %d thing(s) need attention, see the 'warn' lines above." % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
