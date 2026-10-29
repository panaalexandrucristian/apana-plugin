#!/usr/bin/env python3
"""install.py: install claude-auto and put it on PATH through ~/.zshrc.

    install.py [--dry-run] [--no-rc] [--run-tests] [--rc FILE] [--home DIR]

  1. copies the wrapper, its tests and the cooperation runtime bundle to ~/.claude/claude-auto/ (only what differs);
  2. adds one marked block to the zsh rc file that puts that folder on PATH (an existing block is updated in place;
     the original rc is saved once as <rc>.claude-auto.bak);
  3. checks the result: the script compiles, `claude-auto --version` reaches `claude`, the apana plugin is there.

~/.claude/settings.json is never touched. Exit codes: 0 done, 1 done but something needs attention (rc not edited,
tests failed), 2 nothing was installed (missing assets, old python, syntax error).
"""
import argparse, glob, hashlib, os, re, shutil, stat, subprocess, sys, tempfile

START = "# >>> claude-auto >>>"
END = "# <<< claude-auto <<<"
BLOCK = (START + "\n"
         "# Added by the install-claude-auto skill. Remove it with the uninstall-claude-auto skill.\n"
         'export PATH="$HOME/.claude/claude-auto:$PATH"\n'
         + END + "\n")
# Runtime bundle only: generated native types, caches and development tests are never installed.
COOPERATION_FILES = (".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.ts", "scripts/registry.py",
                     "types/index.d.ts")
FILES = (("claude-auto", 0o755), ("test_claude_auto.py", 0o644)) + tuple(
    ("cooperation/" + name, 0o644) for name in COOPERATION_FILES)
ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
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
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".claude-auto-")
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


def with_block(text):
    """The rc text with the block in it, and what had to be done: added, updated or unchanged."""
    found = find_block(text)
    if found is None:
        if text == "":
            return BLOCK, "added"
        return text + ("\n" if text.endswith("\n") else "\n\n") + BLOCK, "added"
    lines, s, e = found
    if "".join(lines[s:e + 1]) == BLOCK:
        return text, "unchanged"
    return "".join(lines[:s]) + BLOCK + "".join(lines[e + 1:]), "updated"


def mentions_outside_block(text):
    lines = split_lines(text)
    try:
        found = find_block(text)
    except ValueError:
        found = None
    skip = range(found[1], found[2] + 1) if found else ()
    return [(i + 1, l.strip()) for i, l in enumerate(lines) if i not in skip and "claude-auto" in l]


def default_rc(home):
    return os.path.join(os.environ.get("ZDOTDIR") or home, ".zshrc")


def default_threshold(script):
    with open(script, encoding="utf-8") as f:
        m = re.search(r'env_num\("CLAUDE_AUTO_TOKENS",\s*(\d+)\)', f.read())
    return int(m.group(1)) if m else None


def check_assets():
    for name, _ in FILES:
        if not os.path.isfile(os.path.join(ASSETS, name)):
            say("fail", "missing %s" % os.path.join(ASSETS, name))
            sys.exit(2)
    src = os.path.join(ASSETS, "claude-auto")
    try:
        with open(src, encoding="utf-8") as f:
            compile(f.read(), src, "exec")
    except SyntaxError as e:
        say("fail", "assets/claude-auto does not compile: %s" % e)
        sys.exit(2)


def copy_files(target, dry):
    if os.path.lexists(target) and not os.path.isdir(target):
        say("fail", "%s exists and is not a folder" % target)
        sys.exit(2)
    if not dry:
        os.makedirs(target, exist_ok=True)
    for name, mode in FILES:
        src, dst = os.path.join(ASSETS, name), os.path.join(target, name)
        if not os.path.exists(dst):
            state = "new"
        elif sha(src) != sha(dst) or stat.S_IMODE(os.stat(dst).st_mode) != mode:
            state = "updated"
        else:
            state = "unchanged"
        if state != "unchanged" and not dry:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(src, "rb") as f:
                write_atomic(dst, f.read(), mode)
        say("ok", "%s%s: %s" % ("would be " if dry and state != "unchanged" else "", dst, state))


def update_rc(rc, dry):
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
        new, action = with_block(old)
    except ValueError as e:
        attention("%s was not edited: %s. Fix the markers by hand and run the install again." % (rc, e))
        return
    for n, line in mentions_outside_block(new):
        attention("%s:%d mentions claude-auto outside the block (left alone): %s" % (rc, n, line[:80]))
    if action == "unchanged":
        say("ok", "%s: PATH block already there" % rc)
        return
    if dry:
        say("ok", "%s: would %s the PATH block" % (rc, "add" if action == "added" else "update"))
        return
    backup = real + ".claude-auto.bak"
    if exists and not os.path.exists(backup):
        with open(real, "rb") as f:
            write_atomic(backup, f.read(), stat.S_IMODE(os.stat(real).st_mode))
    os.makedirs(os.path.dirname(real), exist_ok=True)
    write_atomic(real, new, stat.S_IMODE(os.stat(real).st_mode) if exists else 0o644, text=True)
    say("ok", "%s: PATH block %s%s" % (rc, action, " (original saved as %s)" % backup if exists and action == "added" else ""))


def check_environment(home, script):
    claude = shutil.which("claude")
    if claude:
        r = subprocess.run([script, "--version"], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            say("ok", "claude-auto --version reaches claude: %s" % (r.stdout.strip().splitlines() or ["?"])[0])
        else:
            attention("claude-auto --version failed (exit %d): %s" % (r.returncode, (r.stderr or r.stdout).strip()[:200]))
    else:
        attention("`claude` is not on PATH; claude-auto needs it to start a session")
    mc = glob.glob(os.path.join(home, ".claude/plugins/cache/*/apana/*/skills/compact-handoff/scripts/make_context.py"))
    if mc:
        say("ok", "handoff writer found: %s" % sorted(mc)[-1])
    else:
        attention("the apana plugin's compact-handoff skill (make_context.py) was not found; without it the hook "
                  "cannot write the note and no handoff happens. Install the apana plugin or set CLAUDE_AUTO_MAKE_CONTEXT.")


def run_tests(target):
    say("info", "running the test suite (about a minute)")
    r = subprocess.run([sys.executable, "-W", "ignore", os.path.join(target, "test_claude_auto.py")], cwd=target,
                       capture_output=True, text=True, timeout=900)
    shutil.rmtree(os.path.join(target, "__pycache__"), ignore_errors=True)
    tail = (r.stderr or r.stdout).strip().splitlines()[-4:]
    if r.returncode == 0:
        say("ok", "tests passed: %s" % " | ".join(t for t in tail if t.strip()))
    else:
        attention("tests failed:\n      " + "\n      ".join(tail))


def main():
    ap = argparse.ArgumentParser(description="Install claude-auto and add it to PATH through the zsh rc file.")
    ap.add_argument("--home", help="home folder to install into (default: ~)")
    ap.add_argument("--rc", help="rc file to edit (default: $ZDOTDIR/.zshrc or ~/.zshrc)")
    ap.add_argument("--no-rc", action="store_true", help="do not edit any rc file")
    ap.add_argument("--dry-run", action="store_true", help="show what would change, change nothing")
    ap.add_argument("--run-tests", action="store_true", help="run the test suite after installing")
    args = ap.parse_args()

    home = os.path.abspath(os.path.expanduser(args.home or "~"))
    target = os.path.join(home, ".claude", "claude-auto")
    rc = os.path.abspath(os.path.expanduser(args.rc)) if args.rc else default_rc(home)

    if sys.version_info < (3, 8):
        say("fail", "python 3.8 or newer is needed, this is %s" % sys.version.split()[0])
        return 2
    check_assets()
    copy_files(target, args.dry_run)
    if args.no_rc:
        say("info", "--no-rc: the rc file was not edited")
    else:
        update_rc(rc, args.dry_run)
    if not args.dry_run:
        check_environment(home, os.path.join(target, "claude-auto"))
        if args.run_tests:
            run_tests(target)

    limit = default_threshold(os.path.join(ASSETS, "claude-auto"))
    print()
    say("done" if not problems else "done*", "dry run, nothing was changed" if args.dry_run else "installed")
    if not args.dry_run:
        print("      Open a new terminal (or run `exec zsh`), then start `claude-auto` instead of `claude`.")
        if limit:
            print("      Handoff threshold: %d tokens. For one run: CLAUDE_AUTO_TOKENS=120000 claude-auto" % limit)
    if problems:
        print("      %d thing(s) need attention, see the 'warn' lines above." % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
