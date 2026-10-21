import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
UNINSTALL = HERE / "uninstall.py"


class UninstallScopeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.zdot = self.home / "zsh"
        self.zdot.mkdir()
        self.rc = self.zdot / ".zshrc"
        self.original = "export TOKEN=secret\n# user setting\n"
        self.rc.write_text(self.original)
        self.env = dict(os.environ, HOME=str(self.home), ZDOTDIR=str(self.zdot))

    def tearDown(self):
        self.tmp.cleanup()

    def run_command(self, script, *args):
        return subprocess.run([sys.executable, str(script), *args], env=self.env,
                              text=True, capture_output=True, timeout=30)

    def install_legacy_fixture(self):
        target = self.home / ".claude/claude-scope"
        target.mkdir(parents=True, exist_ok=True)
        command = target / "claude-scope"
        command.write_text('#!/usr/bin/env python3\n"""claude-scope: guarded implementation workflow for tests"""\nMIN_CLAUDE_VERSION = (2, 1, 295)\n')
        command.chmod(0o700)
        backup = pathlib.Path(str(self.rc) + ".claude-scope.bak")
        backup.write_text(self.original)
        self.rc.write_text(self.original + '\n# >>> claude-scope >>>\nexport PATH="$HOME/.claude/claude-scope:$PATH"\n# <<< claude-scope <<<\n')

    def install(self, *args):
        self.install_legacy_fixture()

    def uninstall(self, *args):
        return self.run_command(UNINSTALL, *args)

    def test_removes_only_installer_artifacts_and_allows_reinstall(self):
        self.install()
        installed = self.home / ".claude/claude-scope/claude-scope"
        backup = pathlib.Path(str(self.rc) + ".claude-scope.bak")
        self.assertTrue(installed.is_file())
        self.assertTrue(backup.is_file())
        result = self.uninstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rc.read_text(), self.original)
        self.assertFalse(installed.exists())
        self.assertFalse(backup.exists())
        self.assertFalse((self.home / ".claude/claude-scope").exists())
        self.install()
        self.assertTrue(installed.is_file())

    def test_keeps_foreign_files_and_changed_rc_backup(self):
        self.install()
        folder = self.home / ".claude/claude-scope"
        foreign = folder / "user-note.txt"
        foreign.write_text("keep\n")
        self.rc.write_text(self.rc.read_text() + "alias mine=1\n")
        result = self.uninstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(foreign.exists())
        self.assertTrue(pathlib.Path(str(self.rc) + ".claude-scope.bak").exists())
        self.assertNotIn("# >>> claude-scope >>>", self.rc.read_text())
        self.assertIn("alias mine=1", self.rc.read_text())

    def test_keeps_unknown_same_named_command_and_unbalanced_rc(self):
        folder = self.home / ".claude/claude-scope"
        folder.mkdir(parents=True)
        command = folder / "claude-scope"
        command.write_text("#!/bin/sh\necho user command\n")
        self.rc.write_text(self.original + "# >>> claude-scope >>>\n")
        result = self.uninstall()
        self.assertEqual(result.returncode, 1)
        self.assertTrue(command.exists())
        self.assertIn("# >>> claude-scope >>>", self.rc.read_text())

    def test_dry_run_is_non_mutating_and_no_rc_leaves_rc(self):
        self.install()
        before_rc = self.rc.read_text()
        command = self.home / ".claude/claude-scope/claude-scope"
        dry = self.uninstall("--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(self.rc.read_text(), before_rc)
        self.assertTrue(command.exists())
        no_rc = self.uninstall("--no-rc")
        self.assertEqual(no_rc.returncode, 0, no_rc.stderr)
        self.assertEqual(self.rc.read_text(), before_rc)
        self.assertFalse(command.exists())

    def test_second_uninstall_is_idempotent(self):
        self.install()
        self.assertEqual(self.uninstall().returncode, 0)
        second = self.uninstall()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("nothing to remove", second.stdout)


if __name__ == "__main__":
    unittest.main()
