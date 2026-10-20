import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
INSTALL = HERE / "install.py"


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.zdot = self.home / "zsh"
        self.zdot.mkdir()
        (self.zdot / ".zshrc").write_text("# user rc\n")
        self.env = dict(os.environ, HOME=str(self.home), ZDOTDIR=str(self.zdot))

    def tearDown(self):
        self.tmp.cleanup()

    def run_install(self, *args):
        return subprocess.run([sys.executable, str(INSTALL)] + list(args), env=self.env,
                              text=True, capture_output=True, timeout=30)

    def test_installs_executable_and_one_path_block_idempotently(self):
        first = self.run_install()
        self.assertEqual(first.returncode, 0, first.stderr)
        command = self.home / ".claude/claude-scope/claude-scope"
        self.assertTrue(command.is_file())
        self.assertTrue(command.stat().st_mode & stat.S_IXUSR)
        version = subprocess.run([str(command), "--version"], env=self.env, text=True,
                                 capture_output=True, timeout=10)
        self.assertEqual(version.returncode, 0, version.stderr)
        self.assertIn("claude-scope", version.stdout)
        second = self.run_install()
        self.assertEqual(second.returncode, 0, second.stderr)
        rc = (self.zdot / ".zshrc").read_text()
        self.assertEqual(rc.count("# >>> claude-scope >>>"), 1)
        self.assertEqual(rc.count("# <<< claude-scope <<<"), 1)

    def test_dry_run_writes_nothing(self):
        result = self.run_install("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.home / ".claude/claude-scope").exists())
        self.assertEqual((self.zdot / ".zshrc").read_text(), "# user rc\n")

    def test_no_rc_only_installs_command(self):
        result = self.run_install("--no-rc")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / ".claude/claude-scope/claude-scope").exists())
        self.assertEqual((self.zdot / ".zshrc").read_text(), "# user rc\n")


if __name__ == "__main__":
    unittest.main()
