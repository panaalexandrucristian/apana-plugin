#!/usr/bin/env python3
"""Tests for install.py and ../../uninstall-claude-auto/scripts/uninstall.py. Every run uses a throw-away HOME.

    python3 -W ignore test_setup.py
"""
import filecmp, os, shutil, stat, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(HERE, "install.py")
UNINSTALL = os.path.join(HERE, "..", "..", "uninstall-claude-auto", "scripts", "uninstall.py")
ASSETS = os.path.join(HERE, "..", "assets")
START, END = "# >>> claude-auto >>>", "# <<< claude-auto <<<"
ORIGINALS = [b"", b"a\n", b"a", b"a\n\n", b"a\nb\n", b"a\r\nb\r\n", b"\xff\xfe=\n", b"export X=1\n\n\n"]


class Setup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.rc = os.path.join(self.home, ".zshrc")
        self.target = os.path.join(self.home, ".claude", "claude-auto")
        os.makedirs(self.home)
        bin_dir = os.path.join(self.tmp, "bin")
        os.makedirs(bin_dir)
        with open(os.path.join(bin_dir, "claude"), "w") as f:
            f.write("#!/bin/sh\necho '9.9.9 (stub)'\n")
        os.chmod(os.path.join(bin_dir, "claude"), 0o755)
        self.env = dict(os.environ, HOME=self.home, PATH=bin_dir + os.pathsep + os.environ["PATH"])
        self.env.pop("ZDOTDIR", None)
        self.fake_apana()

    def fake_apana(self):
        d = os.path.join(self.home, ".claude/plugins/cache/x/apana/1/skills/compact-handoff/scripts")
        os.makedirs(d)
        open(os.path.join(d, "make_context.py"), "w").close()

    def run_script(self, script, *args, env=None):
        return subprocess.run([sys.executable, "-I", script, "--home", self.home] + list(args),
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
    def test_fresh_install_copies_files_and_creates_the_rc(self):
        out = self.ok(self.install())
        for name, mode in (("claude-auto", 0o755), ("test_claude_auto.py", 0o644)):
            p = os.path.join(self.target, name)
            self.assertTrue(filecmp.cmp(p, os.path.join(ASSETS, name), shallow=False), name)
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), mode, name)
        rc = self.read_rc().decode()
        self.assertEqual(rc.count(START), 1)
        self.assertIn('export PATH="$HOME/.claude/claude-auto:$PATH"', rc)
        self.assertIn("9.9.9 (stub)", out)                      # claude-auto --version reached claude
        self.assertIn("100000 tokens", out)                     # the threshold is read from the script
        self.assertFalse(os.path.exists(self.rc + ".claude-auto.bak"))   # there was no rc to save

    def test_second_run_changes_nothing(self):
        self.write_rc(b"export A=1\n")
        self.ok(self.install())
        first = (self.read_rc(), os.stat(self.rc).st_mtime_ns)
        out = self.ok(self.install())
        self.assertEqual((self.read_rc(), os.stat(self.rc).st_mtime_ns), first)
        self.assertIn("already there", out)
        self.assertEqual(out.count("unchanged"), 2)

    def test_stale_install_is_updated(self):
        os.makedirs(self.target)
        for name in ("claude-auto", "test_claude_auto.py"):
            with open(os.path.join(self.target, name), "w") as f:
                f.write("old\n")
        out = self.ok(self.install())
        self.assertEqual(out.count(": updated"), 2)
        self.assertTrue(filecmp.cmp(os.path.join(self.target, "claude-auto"), os.path.join(ASSETS, "claude-auto"), False))
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.target, "claude-auto")).st_mode), 0o755)

    def test_the_original_rc_is_saved_once(self):
        self.write_rc(b"export A=1\n")
        self.ok(self.install())
        self.assertEqual(open(self.rc + ".claude-auto.bak", "rb").read(), b"export A=1\n")
        with open(self.rc, "ab") as f:
            f.write(b"export B=2\n")
        self.ok(self.install())                                 # a re-run must not overwrite the backup
        self.assertEqual(open(self.rc + ".claude-auto.bak", "rb").read(), b"export A=1\n")

    def test_an_old_block_is_updated_in_place(self):
        self.write_rc(("top\n\n%s\nexport PATH=/old\n%s\nbottom\n" % (START, END)).encode())
        out = self.ok(self.install())
        rc = self.read_rc().decode()
        self.assertTrue(rc.startswith("top\n\n" + START) and rc.endswith(END + "\nbottom\n"), rc)
        self.assertEqual(rc.count(START), 1)
        self.assertNotIn("/old", rc)
        self.assertIn("updated", out)

    def test_broken_markers_leave_the_rc_untouched(self):
        for data in (("a\n%s\nb\n" % START).encode(), ("a\n%s\nb\n" % END).encode(),
                     ("%s\n%s\n%s\n%s\n" % (START, END, START, END)).encode(),
                     ("%s\n%s\n" % (END, START)).encode()):
            with self.subTest(data=data):
                self.write_rc(data)
                out = self.ok(self.install(), 1)
                self.assertEqual(self.read_rc(), data)
                self.assertIn("markers", out)
                self.assertTrue(os.path.isfile(os.path.join(self.target, "claude-auto")))   # the files still went in

    def test_symlinked_rc_is_edited_where_it_lives(self):
        real = os.path.join(self.tmp, "dotfiles", "zshrc")
        os.makedirs(os.path.dirname(real))
        with open(real, "w") as f:
            f.write("export A=1\n")
        os.symlink(real, self.rc)
        self.ok(self.install())
        self.assertTrue(os.path.islink(self.rc))
        self.assertIn(START, open(real).read())
        self.assertTrue(os.path.isfile(real + ".claude-auto.bak"))

    def test_rc_permissions_are_kept(self):
        self.write_rc(b"x\n")
        os.chmod(self.rc, 0o600)
        self.ok(self.install())
        self.assertEqual(stat.S_IMODE(os.stat(self.rc).st_mode), 0o600)

    def test_dry_run_writes_nothing(self):
        self.write_rc(b"x\n")
        out = self.ok(self.install("--dry-run"))
        self.assertEqual(self.read_rc(), b"x\n")
        self.assertFalse(os.path.exists(self.target))
        self.assertIn("would", out)

    def test_no_rc_flag_leaves_the_rc_alone(self):
        self.write_rc(b"x\n")
        self.ok(self.install("--no-rc"))
        self.assertEqual(self.read_rc(), b"x\n")
        self.assertTrue(os.path.isfile(os.path.join(self.target, "claude-auto")))

    def test_zdotdir_decides_the_default_rc(self):
        zd = os.path.join(self.tmp, "zd")
        os.makedirs(zd)
        self.ok(self.install(env=dict(self.env, ZDOTDIR=zd)))
        self.assertIn(START, open(os.path.join(zd, ".zshrc")).read())
        self.assertFalse(os.path.exists(self.rc))

    def test_explicit_rc_flag(self):
        other = os.path.join(self.tmp, "other-rc")
        self.ok(self.install("--rc", other))
        self.assertIn(START, open(other).read())
        self.assertFalse(os.path.exists(self.rc))

    def test_a_hand_made_line_is_reported_and_kept(self):
        self.write_rc(b"alias claude-auto=foo\n")
        out = self.ok(self.install(), 1)
        self.assertIn(".zshrc:1 mentions claude-auto", out)
        self.assertTrue(self.read_rc().startswith(b"alias claude-auto=foo\n"))

    def test_missing_claude_and_missing_apana_are_reported(self):
        shutil.rmtree(os.path.join(self.home, ".claude/plugins"))
        env = dict(self.env, PATH="/usr/bin:/bin")
        out = self.ok(self.install(env=env), 1)
        self.assertIn("`claude` is not on PATH", out)
        self.assertIn("make_context.py", out)
        self.assertTrue(os.path.isfile(os.path.join(self.target, "claude-auto")))

    def test_the_assets_compile(self):
        compile(open(os.path.join(ASSETS, "claude-auto")).read(), "claude-auto", "exec")

    def test_the_installed_script_runs(self):
        self.ok(self.install())
        r = subprocess.run([os.path.join(self.target, "claude-auto"), "--version"], env=self.env, capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "9.9.9 (stub)"))


class RoundTrip(Setup):
    def test_install_then_uninstall_gives_the_rc_back(self):
        for orig in ORIGINALS:
            with self.subTest(orig=orig):
                shutil.rmtree(self.target, True)
                if os.path.exists(self.rc + ".claude-auto.bak"):     # kept by the previous case; one backup per rc
                    os.remove(self.rc + ".claude-auto.bak")
                self.write_rc(orig)
                self.ok(self.install())
                self.assertIn(START.encode(), self.read_rc())
                self.ok(self.uninstall())
                expected = orig if orig == b"" or orig.endswith(b"\n") else orig + b"\n"
                self.assertEqual(self.read_rc(), expected)
                # identical to the backup, so the backup is gone; the one added "\n" of a no-newline rc keeps it
                self.assertEqual(os.path.exists(self.rc + ".claude-auto.bak"), expected != orig)
                self.assertFalse(os.path.exists(self.target))

    def test_an_rc_that_did_not_exist_ends_up_empty(self):
        self.ok(self.install())
        self.ok(self.uninstall())
        self.assertEqual(self.read_rc(), b"")

    def test_the_backup_stays_when_the_rc_changed_after_the_install(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        with open(self.rc, "ab") as f:
            f.write(b"later\n")
        out = self.ok(self.uninstall())
        self.assertEqual(self.read_rc(), b"a\nlater\n")
        self.assertTrue(os.path.isfile(self.rc + ".claude-auto.bak"))
        self.assertIn("kept", out)

    def test_install_works_again_after_an_uninstall(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        self.ok(self.uninstall())
        self.ok(self.install())
        self.assertEqual(self.read_rc().count(START.encode()), 1)
        self.assertTrue(os.path.isfile(os.path.join(self.target, "claude-auto")))


class Uninstall(Setup):
    def test_second_uninstall_is_a_no_op(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        self.ok(self.uninstall())
        out = self.ok(self.uninstall())
        self.assertIn("nothing to remove", out)
        self.assertEqual(self.read_rc(), b"a\n")

    def test_uninstall_with_nothing_installed(self):
        out = self.ok(self.uninstall())
        self.assertIn("uninstalled", out)

    def test_foreign_files_keep_the_folder_alive(self):
        self.ok(self.install())
        mine = os.path.join(self.target, "my-notes.txt")
        open(mine, "w").write("keep me")
        out = self.ok(self.uninstall(), 1)
        self.assertTrue(os.path.isfile(mine))
        self.assertFalse(os.path.exists(os.path.join(self.target, "claude-auto")))
        self.assertIn("my-notes.txt", out)

    def test_pycache_is_cleaned(self):
        self.ok(self.install())
        os.makedirs(os.path.join(self.target, "__pycache__"))
        self.ok(self.uninstall())
        self.assertFalse(os.path.exists(self.target))

    def test_dry_run_does_not_count_pycache_as_a_foreign_file(self):
        self.ok(self.install())
        os.makedirs(os.path.join(self.target, "__pycache__"))
        out = self.ok(self.uninstall("--dry-run"))
        self.assertIn("would remove the folder", out)

    def test_a_target_that_is_a_symlink_or_a_file_is_left_alone(self):
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        open(os.path.join(elsewhere, "claude-auto"), "w").write("not ours")
        os.makedirs(os.path.dirname(self.target), exist_ok=True)
        os.symlink(elsewhere, self.target)
        out = self.ok(self.uninstall(), 1)
        self.assertTrue(os.path.isfile(os.path.join(elsewhere, "claude-auto")))
        self.assertTrue(os.path.islink(self.target))
        self.assertIn("not a plain folder", out)
        os.remove(self.target)
        open(self.target, "w").write("a file")
        self.ok(self.uninstall(), 1)
        self.assertEqual(open(self.target).read(), "a file")

    def test_install_refuses_a_target_that_is_a_file(self):
        os.makedirs(os.path.dirname(self.target), exist_ok=True)
        open(self.target, "w").write("a file")
        out = self.ok(self.install(), 2)
        self.assertIn("not a folder", out)
        self.assertEqual(open(self.target).read(), "a file")
        self.assertFalse(os.path.exists(self.rc))

    def test_notes_are_kept_unless_purged(self):
        self.ok(self.install())
        notes = os.path.join(self.home, ".claude/handoffs/auto")
        os.makedirs(os.path.join(notes, "20261018"))
        open(os.path.join(notes, "20261018", "HANDOFF.md"), "w").write("n")
        open(os.path.join(notes, "auto.log"), "w").write("l")
        out = self.ok(self.uninstall())
        self.assertTrue(os.path.isdir(notes))
        self.assertIn("--purge-notes", out)
        self.ok(self.uninstall("--purge-notes"))
        self.assertFalse(os.path.exists(notes))

    def test_purge_does_not_follow_a_symlink(self):
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        open(os.path.join(elsewhere, "precious"), "w").write("x")
        os.makedirs(os.path.join(self.home, ".claude/handoffs"))
        os.symlink(elsewhere, os.path.join(self.home, ".claude/handoffs/auto"))
        self.ok(self.uninstall("--purge-notes"))
        self.assertTrue(os.path.isfile(os.path.join(elsewhere, "precious")))

    def test_dry_run_removes_nothing(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        before = self.read_rc()
        out = self.ok(self.uninstall("--dry-run", "--purge-notes"))
        self.assertEqual(self.read_rc(), before)
        self.assertTrue(os.path.isfile(os.path.join(self.target, "claude-auto")))
        self.assertIn("would", out)

    def test_broken_markers_leave_the_rc_untouched(self):
        data = ("a\n%s\nb\n" % START).encode()
        self.write_rc(data)
        self.ok(self.install(), 1)
        out = self.ok(self.uninstall(), 1)
        self.assertEqual(self.read_rc(), data)
        self.assertIn("markers", out)
        self.assertFalse(os.path.exists(os.path.join(self.target, "claude-auto")))   # the files are still removed

    def test_a_hand_made_line_is_reported_and_kept(self):
        self.write_rc(b"alias claude-auto=foo\n")
        self.ok(self.install(), 1)
        out = self.ok(self.uninstall(), 1)
        self.assertEqual(self.read_rc(), b"alias claude-auto=foo\n")
        self.assertIn("still mentions claude-auto", out)

    def test_settings_json_is_read_only(self):
        s = os.path.join(self.home, ".claude/settings.json")
        os.makedirs(os.path.dirname(s), exist_ok=True)
        open(s, "w").write('{"hooks": "claude-auto __hook"}')
        out = self.ok(self.uninstall(), 1)
        self.assertEqual(open(s).read(), '{"hooks": "claude-auto __hook"}')
        self.assertIn("settings.json", out)

    def test_a_running_wrapper_is_reported(self):
        self.ok(self.install())
        fake = os.path.join(self.target, "claude-auto")
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", fake])
        self.addCleanup(proc.kill)
        out = self.ok(self.uninstall(), 1)
        self.assertIn("still running", out)
        self.assertFalse(os.path.exists(fake))

    def test_no_rc_flag_leaves_the_rc_alone(self):
        self.write_rc(b"a\n")
        self.ok(self.install())
        before = self.read_rc()
        self.ok(self.uninstall("--no-rc"))
        self.assertEqual(self.read_rc(), before)
        self.assertFalse(os.path.exists(self.target))


if __name__ == "__main__":
    unittest.main()
