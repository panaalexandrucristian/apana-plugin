#!/usr/bin/env python3
"""Tests for install.py, ../../uninstall-opencode-auto/scripts/uninstall.py and the launcher. Every run uses a throw-away HOME and a fake `opencode`.

    python3 -W ignore test_setup.py
"""
import filecmp, os, shutil, stat, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
INSTALL = os.path.join(HERE, "install.py")
UNINSTALL = os.path.join(HERE, "..", "..", "uninstall-opencode-auto", "scripts", "uninstall.py")
ASSETS = os.path.join(HERE, "..", "assets")
LAUNCHER = os.path.join(ASSETS, "opencode-auto")
START, END = "# >>> opencode-auto >>>", "# <<< opencode-auto <<<"
ORIGINALS = [b"", b"a\n", b"a", b"a\n\n", b"a\nb\n", b"a\r\nb\r\n", b"\xff\xfe=\n", b"export X=1\n\n\n"]
SOURCE_FILES = ("opencode-auto/server.js", "opencode-auto/tui.js", "private/opencode-auto/server.mjs",
                "private/opencode-auto/tui.mjs", "private/opencode/handoff.mjs", "skills/compact-handoff/scripts/make_context.py")
FAKE_OPENCODE = """#!/bin/sh
if [ "$1" = "--version" ]; then echo "opencode v%s"; exit 0; fi
echo "auto=${APANA_OPENCODE_AUTO-unset} tokens=${APANA_OPENCODE_AUTO_TOKENS-unset}"
for a in "$@"; do echo "arg:$a"; done
exit ${FAKE_OPENCODE_EXIT-0}
"""


def tree(root):
    """Every file, link and folder under root, with a link's target: what a run left behind."""
    found = []
    for directory, names, files in os.walk(root):
        for name in names + files:
            path = os.path.join(directory, name)
            found.append((os.path.relpath(path, root), os.readlink(path) if os.path.islink(path) else None))
    return sorted(found)


def files_only(root):
    return [entry for entry in tree(root) if not os.path.isdir(os.path.join(root, entry[0])) or os.path.islink(os.path.join(root, entry[0]))]


class Setup(unittest.TestCase):
    version = "2.4.2"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.rc = os.path.join(self.home, ".zshrc")
        self.config = os.path.join(self.home, ".config", "opencode")
        self.link = os.path.join(self.config, "plugins", "apana-auto")
        self.launcher_dir = os.path.join(self.config, "opencode-auto")
        self.state = os.path.join(self.home, ".local", "state", "opencode", "apana", "auto")
        self.enabled = os.path.join(self.state, "enabled")
        self.notes = os.path.join(self.home, ".local", "share", "opencode", "apana", "handoffs", "auto")
        os.makedirs(self.home)
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.fake_opencode(self.version)
        self.env = dict(os.environ, HOME=self.home, PATH=self.bin + os.pathsep + os.environ["PATH"])
        for name in ("ZDOTDIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "APANA_OPENCODE_AUTO", "APANA_OPENCODE_AUTO_TOKENS"):
            self.env.pop(name, None)

    def fake_opencode(self, version):
        path = os.path.join(self.bin, "opencode")
        with open(path, "w") as f:
            f.write(FAKE_OPENCODE % version)
        os.chmod(path, 0o755)

    def run_script(self, script, *args, env=None, home=True):
        return subprocess.run([sys.executable, "-I", script] + (["--home", self.home] if home else []) + list(args),
                              env=env or self.env, capture_output=True, text=True, timeout=120)

    def install(self, *args, **kw):
        return self.run_script(INSTALL, *args, **kw)

    def uninstall(self, *args, **kw):
        return self.run_script(UNINSTALL, *args, **kw)

    def write_rc(self, data):
        with open(self.rc, "wb") as f:
            f.write(data)

    def read_rc(self):
        with open(self.rc, "rb") as f:
            return f.read()

    def ok(self, r, code=0):
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        return r.stdout


class Install(Setup):
    def test_fresh_install_links_the_plugin_copies_the_launcher_enables_and_creates_the_rc(self):
        out = self.ok(self.install())
        self.assertEqual(os.readlink(self.link), os.path.join(REPO, "opencode-auto"))
        self.assertTrue(os.path.isfile(os.path.join(self.link, "server.js")) and os.path.isfile(os.path.join(self.link, "tui.js")))
        dst = os.path.join(self.launcher_dir, "opencode-auto")
        self.assertTrue(filecmp.cmp(dst, LAUNCHER, shallow=False))
        self.assertEqual(stat.S_IMODE(os.stat(dst).st_mode), 0o755)
        self.assertTrue(os.path.isfile(self.enabled))
        rc = self.read_rc().decode()
        self.assertEqual(rc.count(START), 1)
        self.assertIn('export PATH="$HOME/.config/opencode/opencode-auto:$PATH"', rc)
        self.assertIn("opencode 2.4.2", out)
        self.assertIn("200000 tokens", out)                     # the threshold is read from the server part

    def test_second_run_changes_nothing(self):
        self.ok(self.install())
        before, rc = tree(self.home), self.read_rc()
        out = self.ok(self.install())
        self.assertEqual(tree(self.home), before)
        self.assertEqual(self.read_rc(), rc)
        self.assertNotIn(": new", out)
        self.assertNotIn(": updated", out)

    def test_a_stale_launcher_and_a_link_to_another_place_are_updated(self):
        self.ok(self.install())
        dst = os.path.join(self.launcher_dir, "opencode-auto")
        with open(dst, "w") as f:
            f.write("#!/bin/sh\necho old\n")
        os.remove(self.link)
        os.symlink(os.path.join(self.tmp, "elsewhere"), self.link)
        out = self.ok(self.install())
        self.assertTrue(filecmp.cmp(dst, LAUNCHER, shallow=False))
        self.assertEqual(os.readlink(self.link), os.path.join(REPO, "opencode-auto"))
        self.assertEqual(out.count(": updated"), 2)

    def test_the_original_rc_is_saved_once(self):
        self.write_rc(b"export A=1\n")
        self.ok(self.install())
        with open(self.rc + ".opencode-auto.bak", "rb") as f:
            self.assertEqual(f.read(), b"export A=1\n")
        # The second install must have something to do to reach the backup: the block is made old, and a line is added after the first install.
        self.write_rc(self.read_rc().replace(b'export PATH="$HOME/.config/opencode/opencode-auto:$PATH"', b"export PATH=/old:$PATH") + b"export B=2\n")
        out = self.ok(self.install())
        self.assertIn("PATH block updated", out)
        with open(self.rc + ".opencode-auto.bak", "rb") as f:
            self.assertEqual(f.read(), b"export A=1\n")

    def test_a_launcher_copy_with_the_wrong_mode_is_corrected(self):
        self.ok(self.install())
        dst = os.path.join(self.launcher_dir, "opencode-auto")
        os.chmod(dst, 0o644)
        out = self.ok(self.install())
        self.assertEqual(stat.S_IMODE(os.stat(dst).st_mode), 0o755)
        self.assertIn(": updated", out)

    def test_an_old_block_is_updated_in_place(self):
        self.write_rc(("before\n" + START + "\nexport PATH=/old:$PATH\n" + END + "\nafter\n").encode())
        out = self.ok(self.install())
        rc = self.read_rc().decode()
        self.assertEqual(rc.count(START), 1)
        self.assertNotIn("/old", rc)
        self.assertTrue(rc.startswith("before\n") and rc.endswith("after\n"))
        self.assertIn("PATH block updated", out)

    def test_broken_markers_leave_the_rc_untouched(self):
        for text in (START + "\nno end\n", END + "\n" + START + "\n", START + "\n" + END + "\n" + START + "\n" + END + "\n"):
            self.write_rc(text.encode())
            out = self.ok(self.install(), 1)
            self.assertEqual(self.read_rc(), text.encode())
            self.assertIn("markers", out)

    def test_a_symlinked_rc_is_edited_where_it_lives(self):
        real = os.path.join(self.tmp, "dotfiles", "zshrc")
        os.makedirs(os.path.dirname(real))
        with open(real, "w") as f:
            f.write("x\n")
        os.symlink(real, self.rc)
        self.ok(self.install())
        self.assertTrue(os.path.islink(self.rc))
        with open(real) as f:
            self.assertIn(START, f.read())

    def test_rc_permissions_are_kept(self):
        self.write_rc(b"x\n")
        os.chmod(self.rc, 0o600)
        self.ok(self.install())
        self.assertEqual(stat.S_IMODE(os.stat(self.rc).st_mode), 0o600)

    def test_dry_run_writes_nothing(self):
        self.write_rc(b"x\n")
        before = tree(self.home)
        out = self.ok(self.install("--dry-run"))
        self.assertEqual(tree(self.home), before)
        self.assertEqual(self.read_rc(), b"x\n")
        self.assertIn("would", out)
        self.assertIn("dry run", out)

    def test_no_rc_flag_leaves_the_rc_alone(self):
        self.write_rc(b"x\n")
        self.ok(self.install("--no-rc"))
        self.assertEqual(self.read_rc(), b"x\n")
        self.assertTrue(os.path.islink(self.link))

    def test_zdotdir_decides_the_default_rc(self):
        zdot = os.path.join(self.tmp, "zdot")
        os.makedirs(zdot)
        self.ok(self.install(env=dict(self.env, ZDOTDIR=zdot)))
        self.assertFalse(os.path.exists(self.rc))
        with open(os.path.join(zdot, ".zshrc")) as f:
            self.assertEqual(f.read().count(START), 1)

    def test_explicit_rc_flag(self):
        other = os.path.join(self.tmp, "other-rc")
        self.ok(self.install("--rc", other))
        self.assertFalse(os.path.exists(self.rc))
        with open(other) as f:
            self.assertEqual(f.read().count(START), 1)

    def test_a_hand_made_line_is_reported_and_kept(self):
        self.write_rc(b"alias opencode-auto='x'\n")
        out = self.ok(self.install(), 1)
        self.assertIn("mentions opencode-auto outside the block", out)
        self.assertIn(b"alias opencode-auto='x'\n", self.read_rc())

    def test_the_opencode_config_file_is_never_touched(self):
        os.makedirs(self.config)
        path = os.path.join(self.config, "opencode.jsonc")
        with open(path, "w") as f:
            f.write('{ // mine\n  "skills": []\n}\n')
        before = os.stat(path)
        self.ok(self.install())
        self.ok(self.uninstall())
        with open(path) as f:
            self.assertEqual(f.read(), '{ // mine\n  "skills": []\n}\n')
        self.assertEqual(os.stat(path).st_mtime_ns, before.st_mtime_ns)

    def test_missing_opencode_is_reported(self):
        py = os.path.join(self.tmp, "pybin")
        os.makedirs(py)
        os.symlink(sys.executable, os.path.join(py, "python3"))
        out = self.ok(self.install(env=dict(self.env, PATH=py)), 1)
        self.assertIn("`opencode` is not on PATH", out)
        self.assertNotIn("`python3` is not on PATH", out)

    def test_missing_python3_is_reported(self):
        out = self.ok(self.install(env=dict(self.env, PATH=self.bin)), 1)
        self.assertIn("`python3` is not on PATH", out)

    def test_an_opencode_release_other_than_the_measured_one_is_reported(self):
        for version in ("2.3.2", "3.0.1", "2.2.9"):
            self.fake_opencode(version)
            out = self.ok(self.install(), 1)
            self.assertIn("measured on 2.4.x only", out, version)
        self.fake_opencode("2.4.0")
        self.ok(self.install())

    def test_a_plain_folder_where_the_link_goes_is_left_alone(self):
        os.makedirs(os.path.join(self.link, "mine"))
        out = self.ok(self.install(), 1)
        self.assertIn("is not a link", out)
        self.assertTrue(os.path.isdir(os.path.join(self.link, "mine")))
        self.assertFalse(os.path.islink(self.link))

    def test_a_launcher_folder_that_is_a_file_fails_before_anything_else_is_written(self):
        os.makedirs(self.config)
        with open(self.launcher_dir, "w") as f:
            f.write("x")
        out = self.ok(self.install(), 2)
        self.assertIn("is not a plain folder", out)
        self.assertFalse(os.path.exists(self.enabled))

    def test_a_source_that_is_not_a_checkout_fails_before_anything_is_installed(self):
        out = self.ok(self.install("--source", os.path.join(self.tmp, "nothing")), 2)
        self.assertIn("is not an apana checkout", out)
        self.assertEqual(tree(self.home), [])

    def test_source_points_the_link_into_another_checkout(self):
        other = os.path.join(self.tmp, "checkout")
        self.fake_checkout(other)
        self.ok(self.install("--source", other))
        self.assertEqual(os.readlink(self.link), os.path.join(other, "opencode-auto"))

    def test_a_copy_in_the_plugin_cache_links_to_the_marketplace_clone(self):
        cache = os.path.join(self.home, ".claude", "plugins", "cache", "apana-private", "apana", "0.16.0")
        clone = os.path.join(self.home, ".claude", "plugins", "marketplaces", "apana-private")
        self.fake_checkout(cache, with_skill=True)
        self.fake_checkout(clone)
        script = os.path.join(cache, "skills", "install-opencode-auto", "scripts", "install.py")
        self.ok(self.run_script(script))
        self.assertEqual(os.readlink(self.link), os.path.join(clone, "opencode-auto"))

    def test_a_copy_in_the_plugin_cache_without_a_clone_warns_that_the_link_will_break(self):
        cache = os.path.join(self.home, ".claude", "plugins", "cache", "apana-private", "apana", "0.16.0")
        self.fake_checkout(cache, with_skill=True)
        script = os.path.join(cache, "skills", "install-opencode-auto", "scripts", "install.py")
        out = self.ok(self.run_script(script), 1)
        self.assertIn("the link will break", out)
        self.assertEqual(os.readlink(self.link), os.path.join(cache, "opencode-auto"))

    def test_without_home_the_xdg_folders_decide_and_the_real_home_is_not_used(self):
        env = dict(self.env, XDG_CONFIG_HOME=os.path.join(self.tmp, "xc"), XDG_STATE_HOME=os.path.join(self.tmp, "xs"))
        self.ok(self.run_script(INSTALL, "--rc", self.rc, env=env, home=False))
        self.assertTrue(os.path.islink(os.path.join(self.tmp, "xc", "opencode", "plugins", "apana-auto")))
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, "xs", "opencode", "apana", "auto", "enabled")))
        self.assertIn(os.path.join(self.tmp, "xc", "opencode", "opencode-auto"), self.read_rc().decode())
        self.assertFalse(os.path.exists(self.config))

    def test_with_home_the_xdg_folders_are_ignored(self):
        env = dict(self.env, XDG_CONFIG_HOME=os.path.join(self.tmp, "xc"), XDG_STATE_HOME=os.path.join(self.tmp, "xs"))
        self.ok(self.install(env=env))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "xc")) or os.path.exists(os.path.join(self.tmp, "xs")))
        self.assertTrue(os.path.islink(self.link))

    def fake_checkout(self, root, with_skill=False):
        for name in SOURCE_FILES:
            path = os.path.join(root, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write("export const DEFAULTS = Object.freeze({ tokens: 200_000 });\n")
        if with_skill:
            base = os.path.join(root, "skills", "install-opencode-auto")
            shutil.copytree(os.path.join(HERE), os.path.join(base, "scripts"), ignore=shutil.ignore_patterns("__pycache__", "test_setup.py"))
            shutil.copytree(ASSETS, os.path.join(base, "assets"))


class Launcher(Setup):
    def start(self, *args, env=None, path=None):
        return subprocess.run(["/bin/sh", LAUNCHER] + list(args), env=dict(env or self.env, **({"PATH": path} if path else {})),
                              capture_output=True, text=True, timeout=60)

    def test_the_assets_parse(self):
        self.assertEqual(subprocess.run(["/bin/sh", "-n", LAUNCHER]).returncode, 0)
        self.assertTrue(os.access(LAUNCHER, os.X_OK))

    def test_it_sets_the_variable_and_passes_every_argument_on_unchanged(self):
        out = self.ok(self.start("run", "--model", "a b", "it's", "", "$HOME"))
        self.assertEqual(out.splitlines(), ["auto=1 tokens=unset", "arg:run", "arg:--model", "arg:a b", "arg:it's", "arg:", "arg:$HOME"])

    def test_it_passes_the_settings_on(self):
        out = self.ok(self.start(env=dict(self.env, APANA_OPENCODE_AUTO_TOKENS="120000")))
        self.assertIn("tokens=120000", out)

    def test_it_returns_the_exit_code_of_opencode(self):
        self.assertEqual(self.start(env=dict(self.env, FAKE_OPENCODE_EXIT="7")).returncode, 7)

    def test_it_says_so_when_opencode_is_missing(self):
        r = self.start(path="/nonexistent")
        self.assertEqual(r.returncode, 127)
        self.assertIn("`opencode` is not on PATH", r.stderr)

    def test_the_installed_launcher_is_found_on_the_path_and_works(self):
        self.ok(self.install())
        path = self.launcher_dir + os.pathsep + self.env["PATH"]
        r = subprocess.run(["opencode-auto", "x"], env=dict(self.env, PATH=path), capture_output=True, text=True, timeout=60)
        self.assertEqual(r.stdout.splitlines()[0], "auto=1 tokens=unset", r.stdout + r.stderr)


class RoundTrip(Setup):
    def test_install_then_uninstall_gives_the_rc_back(self):
        for original in ORIGINALS:
            with self.subTest(original=original):
                shutil.rmtree(self.home)
                os.makedirs(self.home)
                self.write_rc(original)
                self.ok(self.install())
                self.assertIn(START.encode(), self.read_rc())
                self.ok(self.uninstall())
                # An rc that does not end in a newline gets one when the block is added, and the uninstall cannot tell it from the user's own;
                # the backup is then not identical, so it stays (as in install-claude-auto).
                expected = original if original == b"" or original.endswith(b"\n") else original + b"\n"
                self.assertEqual(self.read_rc(), expected)
                self.assertEqual(os.path.exists(self.rc + ".opencode-auto.bak"), expected != original)

    def test_an_rc_that_did_not_exist_ends_up_empty(self):
        self.ok(self.install())
        self.ok(self.uninstall())
        self.assertEqual(self.read_rc(), b"")

    def test_nothing_but_the_rc_is_left_behind(self):
        self.ok(self.install())
        self.ok(self.uninstall())
        self.assertEqual([entry for entry in files_only(self.home) if entry[0] != ".zshrc"], [])

    def test_the_backup_stays_when_the_rc_changed_after_the_install(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        self.write_rc(self.read_rc() + b"export LATER=1\n")
        out = self.ok(self.uninstall())
        self.assertIn("kept", out)
        self.assertTrue(os.path.exists(self.rc + ".opencode-auto.bak"))
        self.assertEqual(self.read_rc(), b"a\nexport LATER=1\n")

    def test_install_works_again_after_an_uninstall(self):
        self.ok(self.install())
        self.ok(self.uninstall())
        self.ok(self.install())
        self.assertTrue(os.path.islink(self.link) and os.path.isfile(self.enabled))
        self.assertEqual(self.read_rc().decode().count(START), 1)


class Uninstall(Setup):
    def test_second_uninstall_is_a_no_op(self):
        self.ok(self.install())
        self.ok(self.uninstall())
        out = self.ok(self.uninstall())
        self.assertIn("nothing to remove", out)

    def test_uninstall_with_nothing_installed(self):
        out = self.ok(self.uninstall())
        self.assertIn("nothing to remove", out)
        self.assertEqual(tree(self.home), [])

    def test_the_enabled_file_goes_so_handoffs_stop(self):
        self.ok(self.install())
        out = self.ok(self.uninstall())
        self.assertFalse(os.path.exists(self.enabled))
        self.assertIn("handoffs stop at once", out)
        self.assertFalse(os.path.exists(self.state))

    def test_the_link_goes_but_not_the_checkout_behind_it(self):
        self.ok(self.install())
        self.ok(self.uninstall())
        self.assertFalse(os.path.lexists(self.link))
        self.assertTrue(os.path.isfile(os.path.join(REPO, "opencode-auto", "server.js")))

    def test_another_plugin_keeps_the_plugins_folder_alive(self):
        self.ok(self.install())
        other = os.path.join(self.config, "plugins", "other")
        os.makedirs(other)
        self.ok(self.uninstall())
        self.assertTrue(os.path.isdir(other))

    def test_a_folder_where_the_link_was_is_not_ours_and_is_left_alone(self):
        os.makedirs(os.path.join(self.link, "mine"))
        out = self.ok(self.uninstall(), 1)
        self.assertIn("is not a link, so it is not ours", out)
        self.assertTrue(os.path.isdir(os.path.join(self.link, "mine")))

    def test_foreign_files_keep_the_launcher_folder_alive(self):
        self.ok(self.install())
        with open(os.path.join(self.launcher_dir, "mine.sh"), "w") as f:
            f.write("x")
        out = self.ok(self.uninstall(), 1)
        self.assertIn("mine.sh", out)
        self.assertFalse(os.path.exists(os.path.join(self.launcher_dir, "opencode-auto")))
        self.assertTrue(os.path.exists(os.path.join(self.launcher_dir, "mine.sh")))

    def test_a_launcher_folder_that_is_a_link_is_left_alone(self):
        os.makedirs(os.path.join(self.tmp, "real"))
        os.makedirs(self.config)
        os.symlink(os.path.join(self.tmp, "real"), self.launcher_dir)
        out = self.ok(self.uninstall(), 1)
        self.assertIn("is not a plain folder", out)
        self.assertTrue(os.path.islink(self.launcher_dir))

    def test_notes_and_the_log_are_kept_unless_purged(self):
        self.ok(self.install())
        os.makedirs(os.path.join(self.notes, "abc-1"))
        with open(os.path.join(self.notes, "abc-1", "HANDOFF.md"), "w") as f:
            f.write("note")
        with open(os.path.join(self.state, "auto.log"), "w") as f:
            f.write("log")
        out = self.ok(self.uninstall())
        self.assertIn("--purge-notes", out)
        self.assertIn("auto.log kept", out)
        self.assertTrue(os.path.exists(os.path.join(self.notes, "abc-1", "HANDOFF.md")))
        self.assertTrue(os.path.exists(os.path.join(self.state, "auto.log")))
        self.assertFalse(os.path.exists(self.enabled))

    def test_purge_deletes_the_notes_and_the_log_and_the_folders_they_leave_empty(self):
        self.ok(self.install())
        os.makedirs(os.path.join(self.notes, "abc-1"))
        with open(os.path.join(self.notes, "abc-1", "HANDOFF.md"), "w") as f:
            f.write("note")
        with open(os.path.join(self.state, "auto.log"), "w") as f:
            f.write("log")
        self.ok(self.uninstall("--purge-notes"))
        self.assertFalse(os.path.exists(self.notes))
        self.assertFalse(os.path.exists(self.state))

    def test_purge_does_not_follow_a_symlink(self):
        self.ok(self.install())
        target = os.path.join(self.tmp, "precious")
        os.makedirs(target)
        with open(os.path.join(target, "keep"), "w") as f:
            f.write("x")
        os.makedirs(os.path.dirname(self.notes))
        os.symlink(target, self.notes)
        self.ok(self.uninstall("--purge-notes"))
        self.assertFalse(os.path.lexists(self.notes))
        self.assertTrue(os.path.exists(os.path.join(target, "keep")))

    def test_dry_run_removes_nothing(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        before, rc = tree(self.home), self.read_rc()
        out = self.ok(self.uninstall("--dry-run", "--purge-notes"))
        self.assertEqual(tree(self.home), before)
        self.assertEqual(self.read_rc(), rc)
        self.assertIn("would", out)

    def test_broken_markers_leave_the_rc_untouched(self):
        self.write_rc((START + "\nhalf\n").encode())
        out = self.ok(self.uninstall(), 1)
        self.assertEqual(self.read_rc(), (START + "\nhalf\n").encode())
        self.assertIn("markers", out)

    def test_a_hand_made_line_is_reported_and_kept(self):
        self.write_rc(b"alias opencode-auto='x'\n")
        out = self.ok(self.uninstall(), 1)
        self.assertIn("still mentions opencode-auto", out)
        self.assertEqual(self.read_rc(), b"alias opencode-auto='x'\n")

    def xdg_env(self):
        return dict(self.env, XDG_CONFIG_HOME=os.path.join(self.tmp, "xc"), XDG_STATE_HOME=os.path.join(self.tmp, "xs"), XDG_DATA_HOME=os.path.join(self.tmp, "xd"))

    def test_without_home_the_xdg_folders_decide(self):
        env = self.xdg_env()
        self.ok(self.run_script(INSTALL, "--rc", self.rc, env=env, home=False))
        link = os.path.join(self.tmp, "xc", "opencode", "plugins", "apana-auto")
        enabled = os.path.join(self.tmp, "xs", "opencode", "apana", "auto", "enabled")
        self.assertTrue(os.path.islink(link) and os.path.isfile(enabled))
        self.ok(self.run_script(UNINSTALL, "--rc", self.rc, env=env, home=False))
        self.assertFalse(os.path.lexists(link) or os.path.exists(enabled))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "xc", "opencode", "opencode-auto")))

    def test_with_home_the_xdg_folders_are_left_alone(self):
        env = self.xdg_env()
        self.ok(self.run_script(INSTALL, "--rc", self.rc, env=env, home=False))
        before = tree(self.tmp)
        self.ok(self.uninstall(env=env))
        self.assertEqual([e for e in tree(self.tmp) if e[0].startswith(("xc", "xs"))], [e for e in before if e[0].startswith(("xc", "xs"))])

    def test_no_rc_flag_leaves_the_rc_alone(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        before = self.read_rc()
        self.ok(self.uninstall("--no-rc"))
        self.assertEqual(self.read_rc(), before)
        self.assertFalse(os.path.lexists(self.link))


if __name__ == "__main__":
    unittest.main()
