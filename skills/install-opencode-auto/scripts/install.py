#!/usr/bin/env python3
"""install.py: install opencode-auto (an OpenCode session that hands itself off to a new one before the context fills up).

    install.py [--dry-run] [--no-rc] [--rc FILE] [--home DIR] [--source DIR]

  1. links <config>/plugins/apana-auto to the plugin folder opencode-auto/ of the apana repository (OpenCode finds it within seconds, no restart);
  2. copies the launcher to <config>/opencode-auto/ and adds one marked block to the zsh rc file that puts that folder on PATH
     (an existing block is updated in place; the original rc is saved once as <rc>.opencode-auto.bak);
  3. creates the `enabled` file under <state>/opencode/apana/auto/ (handoffs happen only while it exists);
  4. checks the result: opencode and python3 are on PATH, opencode is the version that was measured, the handoff writer exists.

<config> is $XDG_CONFIG_HOME/opencode or ~/.config/opencode, <state> is $XDG_STATE_HOME or ~/.local/state; with --home both are under that home.
OpenCode's own config file is never touched, and nothing is restarted. Exit codes: 0 done, 1 done but something needs attention,
2 nothing was installed (missing source or assets, old python, syntax error).
"""
import argparse, hashlib, os, re, shutil, stat, subprocess, sys, tempfile

START = "# >>> opencode-auto >>>"
END = "# <<< opencode-auto <<<"
LINK_NAME = "apana-auto"
LAUNCHER = "opencode-auto"
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")
OWN_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SOURCE_FILES = ("opencode-auto/server.js", "opencode-auto/tui.js", "private/opencode-auto/server.mjs",
                "private/opencode-auto/tui.mjs", "private/opencode/handoff.mjs", "skills/compact-handoff/scripts/make_context.py")
MEASURED = (2, 4)                       # the OpenCode release line the plugin was measured on
ENC = dict(encoding="utf-8", errors="surrogateescape", newline="")   # keep every byte and line ending of the rc as is

problems = []


def say(tag, msg):
    print("%-5s %s" % (tag, msg))


def attention(msg):
    problems.append(msg)
    say("warn", msg)


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def write_atomic(path, data, mode=None, text=False):
    """Write next to `path`, then rename over it: a reader never sees half a file."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".opencode-auto-")
    try:
        with os.fdopen(fd, "w" if text else "wb", **(ENC if text else {})) as f:
            f.write(data)
        os.chmod(tmp, mode if mode is not None else 0o644)
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


def block_for(launcher_dir, home):
    shown = "$HOME" + launcher_dir[len(home):] if launcher_dir.startswith(home + os.sep) else launcher_dir
    return (START + "\n"
            "# Added by the install-opencode-auto skill. Remove it with the uninstall-opencode-auto skill.\n"
            'export PATH="%s:$PATH"\n' % shown
            + END + "\n")


def with_block(text, block):
    """The rc text with the block in it, and what had to be done: added, updated or unchanged."""
    found = find_block(text)
    if found is None:
        if text == "":
            return block, "added"
        return text + ("\n" if text.endswith("\n") else "\n\n") + block, "added"
    lines, s, e = found
    if "".join(lines[s:e + 1]) == block:
        return text, "unchanged"
    return "".join(lines[:s]) + block + "".join(lines[e + 1:]), "updated"


def mentions_outside_block(text):
    lines = split_lines(text)
    try:
        found = find_block(text)
    except ValueError:
        found = None
    skip = range(found[1], found[2] + 1) if found else ()
    return [(i + 1, l.strip()) for i, l in enumerate(lines) if i not in skip and "opencode-auto" in l]


def default_rc(home):
    return os.path.join(os.environ.get("ZDOTDIR") or home, ".zshrc")


def places(home, explicit_home):
    """(config, state) folders. With --home they come from that home alone, so a throw-away home never reaches the real one."""
    if explicit_home:
        return os.path.join(home, ".config", "opencode"), os.path.join(home, ".local", "state")
    config = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "opencode")
    return config, os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")


def is_source(root):
    return all(os.path.isfile(os.path.join(root, name)) for name in SOURCE_FILES)


def find_source(home, explicit):
    """The repository the link points into. A copy under plugins/cache/ is replaced on every plugin update, so the marketplace clone is preferred then."""
    if explicit:
        root = os.path.abspath(os.path.expanduser(explicit))
        if not is_source(root):
            say("fail", "%s is not an apana checkout (one of %s is missing)" % (root, ", ".join(SOURCE_FILES)))
            sys.exit(2)
        return root
    if os.sep + os.path.join("plugins", "cache") + os.sep in OWN_ROOT + os.sep:
        clone = os.path.join(home, ".claude", "plugins", "marketplaces", "apana-private")
        if is_source(clone):
            return clone
        attention("this skill runs from a plugin cache copy and the marketplace clone %s has no opencode-auto: the link will break when the "
                  "plugin is updated. Update the marketplace (`claude plugin marketplace update apana-private`) and install again." % clone)
    if not is_source(OWN_ROOT):
        say("fail", "%s is not an apana checkout (one of %s is missing)" % (OWN_ROOT, ", ".join(SOURCE_FILES)))
        sys.exit(2)
    return OWN_ROOT


def check_assets():
    src = os.path.join(ASSETS, LAUNCHER)
    if not os.path.isfile(src):
        say("fail", "missing %s" % src)
        sys.exit(2)
    r = subprocess.run(["/bin/sh", "-n", src], capture_output=True, text=True)
    if r.returncode != 0:
        say("fail", "assets/%s does not parse: %s" % (LAUNCHER, r.stderr.strip()[:200]))
        sys.exit(2)


def update_link(link, target, dry):
    """link -> target, replaced atomically when it points elsewhere. Something at the link that is not a link is left alone."""
    if os.path.islink(link):
        state = "unchanged" if os.readlink(link) == target else "updated"
    elif os.path.lexists(link):
        attention("%s exists and is not a link; it was left alone, so the plugin is not registered" % link)
        return
    else:
        state = "new"
    if state != "unchanged" and not dry:
        os.makedirs(os.path.dirname(link), exist_ok=True)
        tmp = "%s.tmp-%d" % (link, os.getpid())
        os.symlink(target, tmp)
        os.replace(tmp, link)
    say("ok", "%s -> %s: %s%s" % (link, target, "would be " if dry and state != "unchanged" else "", state))


def copy_launcher(folder, dry):
    if os.path.lexists(folder) and (os.path.islink(folder) or not os.path.isdir(folder)):
        say("fail", "%s exists and is not a plain folder" % folder)
        sys.exit(2)
    src, dst = os.path.join(ASSETS, LAUNCHER), os.path.join(folder, LAUNCHER)
    if not os.path.exists(dst):
        state = "new"
    elif sha(src) != sha(dst) or stat.S_IMODE(os.stat(dst).st_mode) != 0o755:
        state = "updated"
    else:
        state = "unchanged"
    if state != "unchanged" and not dry:
        os.makedirs(folder, exist_ok=True)
        with open(src, "rb") as f:
            write_atomic(dst, f.read(), 0o755)
    say("ok", "%s: %s%s" % (dst, "would be " if dry and state != "unchanged" else "", state))


def create_enabled(state_home, dry):
    folder = os.path.join(state_home, "opencode", "apana", "auto")
    flag = os.path.join(folder, "enabled")
    if os.path.lexists(flag):
        say("ok", "%s: unchanged" % flag)
        return
    if not dry:
        os.makedirs(folder, exist_ok=True)
        open(flag, "w").close()
    say("ok", "%s: %s" % (flag, "would be new" if dry else "new"))


def update_rc(rc, block, dry):
    real = os.path.realpath(rc)          # a symlinked rc (dotfiles repo) is edited where it really lives
    exists = os.path.isfile(real)
    if os.path.lexists(real) and not exists:
        attention("%s is not a regular file; the rc was not edited" % rc)
        return
    try:
        old = ""
        if exists:
            with open(real, **ENC) as f:
                old = f.read()
        new, action = with_block(old, block)
    except ValueError as e:
        attention("%s was not edited: %s. Fix the markers by hand and run the install again." % (rc, e))
        return
    for n, line in mentions_outside_block(new):
        attention("%s:%d mentions opencode-auto outside the block (left alone): %s" % (rc, n, line[:80]))
    if action == "unchanged":
        say("ok", "%s: PATH block already there" % rc)
        return
    if dry:
        say("ok", "%s: would %s the PATH block" % (rc, "add" if action == "added" else "update"))
        return
    backup = real + ".opencode-auto.bak"
    if exists and not os.path.exists(backup):
        with open(real, "rb") as f:
            write_atomic(backup, f.read(), stat.S_IMODE(os.stat(real).st_mode))
    os.makedirs(os.path.dirname(real), exist_ok=True)
    write_atomic(real, new, stat.S_IMODE(os.stat(real).st_mode) if exists else 0o644, text=True)
    say("ok", "%s: PATH block %s%s" % (rc, action, " (original saved as %s)" % backup if exists and action == "added" else ""))


def check_environment():
    opencode = shutil.which("opencode")
    if not opencode:
        attention("`opencode` is not on PATH; opencode-auto needs it to start a session")
    else:
        r = subprocess.run([opencode, "--version"], capture_output=True, text=True, timeout=60)
        found = re.search(r"(\d+)\.(\d+)\.(\d+)", r.stdout + r.stderr)
        if r.returncode != 0 or not found:
            attention("`opencode --version` gave no version (exit %d)" % r.returncode)
        elif (int(found.group(1)), int(found.group(2))) != MEASURED:
            attention("opencode %s: the plugin was measured on %d.%d.x only; its hooks and events may differ here"
                      % (found.group(0), MEASURED[0], MEASURED[1]))
        else:
            say("ok", "opencode %s" % found.group(0))
    if shutil.which("python3"):
        say("ok", "python3 is on PATH (the handoff writer runs with it)")
    else:
        attention("`python3` is not on PATH; the server part cannot run make_context.py, so no handoff would happen")


def default_threshold(root):
    with open(os.path.join(root, "private", "opencode-auto", "server.mjs"), encoding="utf-8") as f:
        m = re.search(r"DEFAULTS = Object\.freeze\(\{ tokens: ([\d_]+)", f.read())
    return int(m.group(1).replace("_", "")) if m else None


def main():
    ap = argparse.ArgumentParser(description="Install opencode-auto: the plugin link, the launcher, its PATH block and the enabled file.")
    ap.add_argument("--home", help="home folder to install into (default: ~)")
    ap.add_argument("--rc", help="rc file to edit (default: $ZDOTDIR/.zshrc or ~/.zshrc)")
    ap.add_argument("--no-rc", action="store_true", help="do not edit any rc file")
    ap.add_argument("--source", help="apana checkout the plugin link points into (default: the one this skill belongs to)")
    ap.add_argument("--dry-run", action="store_true", help="show what would change, change nothing")
    args = ap.parse_args()

    home = os.path.abspath(os.path.expanduser(args.home or "~"))
    config, state = places(home, bool(args.home))
    launcher_dir = os.path.join(config, LAUNCHER)
    rc = os.path.abspath(os.path.expanduser(args.rc)) if args.rc else default_rc(home)

    if sys.version_info < (3, 8):
        say("fail", "python 3.8 or newer is needed, this is %s" % sys.version.split()[0])
        return 2
    check_assets()
    source = find_source(home, args.source)
    update_link(os.path.join(config, "plugins", LINK_NAME), os.path.join(source, "opencode-auto"), args.dry_run)
    copy_launcher(launcher_dir, args.dry_run)
    create_enabled(state, args.dry_run)
    if args.no_rc:
        say("info", "--no-rc: the rc file was not edited")
    else:
        update_rc(rc, block_for(launcher_dir, home), args.dry_run)
    if not args.dry_run:
        check_environment()

    limit = default_threshold(source)
    print()
    say("done" if not problems else "done*", "dry run, nothing was changed" if args.dry_run else "installed")
    if not args.dry_run:
        print("      A running OpenCode picks up the server part within about 10 seconds, without a restart.")
        print("      Open a new terminal (or run `exec zsh`), then start `opencode-auto` instead of `opencode`: a TUI that is already open has no TUI part.")
        if limit:
            print("      Handoff threshold: %d tokens. For one run: APANA_OPENCODE_AUTO_TOKENS=120000 opencode-auto" % limit)
        print("      To stop handoffs at once, run the uninstall-opencode-auto skill (it removes the enabled file).")
    if problems:
        print("      %d thing(s) need attention, see the 'warn' lines above." % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
