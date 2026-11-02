"""Uninstaller CLI runs with no Claude, native host or credentials."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
import claude_copilot as c


class UninstallCliTests(unittest.TestCase):
    def test_owned_absent_foreign_malformed_symlink_preview_and_removal(self):
        for kind in ('owned', 'absent', 'foreign', 'malformed', 'symlink'):
            for option in ('--dry-run', '--yes'):
                with self.subTest(kind=kind, option=option), tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary).resolve()
                    state, launcher, rc = c.layout(home)
                    if kind != 'absent':
                        c.configure(home, sys.executable)
                        (state / 'auth/keep').write_text('private fixture')
                    if kind == 'foreign': launcher.write_text('#!/bin/sh\nexit 0\n')
                    if kind == 'malformed': rc.write_text(c.BEGIN)
                    if kind == 'symlink':
                        launcher.unlink(); launcher.symlink_to(rc)
                    before = {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()}
                    env = dict(os.environ, HOME=str(home), PATH='')
                    result = subprocess.run([sys.executable, '-I', str(Path(c.__file__)), 'uninstall', option],
                                            env=env, capture_output=True, text=True)
                    valid = kind in ('owned', 'absent')
                    self.assertEqual(result.returncode, 0 if valid else 1, result.stderr)
                    after = {str(p): p.read_bytes() for p in home.rglob('*') if p.is_file()}
                    if option == '--dry-run' or not valid: self.assertEqual(before, after)
                    elif kind == 'owned':
                        self.assertFalse(launcher.exists())
                        self.assertNotIn(c.BEGIN, rc.read_text())
                        self.assertEqual((state / 'auth/keep').read_text(), 'private fixture')
                        self.assertTrue((state / 'zshrc.before').exists())

    def test_cli_requires_explicit_removal(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); c.configure(home, sys.executable)
            result = subprocess.run([sys.executable, '-I', c.__file__, 'uninstall'],
                                    env=dict(os.environ, HOME=str(home), PATH=''), capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertTrue(c.layout(home)[1].exists())

    def test_owned_previous_alias_can_be_updated_or_removed(self):
        # t=2 INFERENCE: the previous path quoting must retain ownership for both operations.
        for operation in ('update', 'remove'):
            for spelling in ('plain', 'with space', "with'quote", 'with$cash;semi'):
                with self.subTest(operation=operation, spelling=spelling), tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary).resolve() / spelling
                    home.mkdir()
                    state, launcher, rc = c.layout(home)
                    rc.write_text('export KEEP=yes\n')
                    c.configure(home, sys.executable)
                    previous = c.BEGIN + '\nalias claude-copilot=' + shlex.quote(str(launcher)) + '\n' + c.END
                    rc.write_text(rc.read_text().replace(c.shell_block(launcher), previous))
                    before = (state / 'zshrc.before').read_bytes()
                    if operation == 'update':
                        c.configure(home, sys.executable)
                        self.assertIn(c.shell_block(launcher), rc.read_text())
                    else:
                        c.uninstall(home)
                        self.assertFalse(launcher.exists())
                        self.assertNotIn(c.BEGIN, rc.read_text())
                    self.assertIn('export KEEP=yes', rc.read_text())
                    self.assertEqual((state / 'zshrc.before').read_bytes(), before)

    def test_alias_in_fresh_shell_uses_installed_copy(self):
        import shutil
        shell = shutil.which('zsh') or '/bin/sh'
        # t=1 INFERENCE: path spelling is the only factor in shell alias quoting.
        with tempfile.TemporaryDirectory() as temporary:
            for spelling in ('plain', 'with space', "with'quote", 'with$cash;semi'):
                with self.subTest(spelling=spelling):
                    home = Path(temporary).resolve() / spelling
                    home.mkdir()
                    state = c.configure(home, sys.executable)
                    c.configure(home, sys.executable)
                    c.private_write(state / 'claude_copilot.py',
                                    'import json, sys\nprint(json.dumps(sys.argv[1:]))\n', 0o700)
                    result = subprocess.run([shell, '-f', '-c',
                        '. "$HOME/.zshrc"; eval \'claude-copilot -- "literal value"\''],
                        env=dict(os.environ, HOME=str(home)), capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), ['run', '--', 'literal value'])


if __name__ == '__main__': unittest.main()
