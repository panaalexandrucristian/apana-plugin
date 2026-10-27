import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).parent
SCRIPT = ROOT / 'claude_openai.py'


class UninstallCliTests(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location('claude_openai', SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def snapshot(self, home):
        return {str(path.relative_to(home)): path.read_bytes()
                for path in home.rglob('*') if path.is_file()}

    def run_cli(self, home, dry_run):
        args = [sys.executable, '-B', str(SCRIPT), 'uninstall']
        if dry_run:
            args.append('--dry-run')
        return subprocess.run(
            args, cwd=home, capture_output=True, text=True, timeout=20,
            env={'HOME': str(home), 'PATH': str(home / 'empty-path'),
                 'PYTHONDONTWRITEBYTECODE': '1'},
        )

    def test_cli_modes_across_installation_states(self):
        mod = self.module()
        for installation in ('owned', 'absent', 'foreign', 'malformed'):
            for dry_run in (True, False):
                with self.subTest(installation=installation, dry_run=dry_run):
                    with tempfile.TemporaryDirectory() as td:
                        home = Path(td)
                        rc = home / '.zshrc'
                        launcher = home / '.local/bin/claude-openai'
                        rc.write_text('# unrelated prefix\n')
                        if installation != 'absent':
                            state = mod.configure(home, sys.executable)
                            (state / 'auth/test.json').write_text('{"test": "dummy credential"}\n')
                            rc.write_text(rc.read_text() + '# unrelated suffix\n')
                            os.chmod(rc, 0o640)
                        if installation == 'foreign':
                            launcher.write_text('# foreign executable\n')
                        if installation == 'malformed':
                            rc.write_text(rc.read_text().replace(mod.END, 'missing-end-marker'))
                        before = self.snapshot(home)
                        mode_before = rc.stat().st_mode

                        result = self.run_cli(home, dry_run)
                        after = self.snapshot(home)
                        if installation in ('foreign', 'malformed'):
                            self.assertEqual(result.returncode, 1, result.stderr)
                            self.assertIn('claude-openai:', result.stderr)
                            self.assertEqual(after, before)
                            continue

                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stderr, '')
                        if dry_run:
                            self.assertIn('Would remove owned launcher and shell alias', result.stdout)
                            self.assertEqual(after, before)
                            continue

                        self.assertEqual(result.stdout, '')
                        self.assertFalse(launcher.exists())
                        self.assertNotIn(mod.BEGIN, rc.read_text())
                        self.assertNotIn(mod.END, rc.read_text())
                        self.assertIn('# unrelated prefix\n', rc.read_text())
                        self.assertEqual(rc.stat().st_mode, mode_before)
                        if installation == 'owned':
                            self.assertIn('# unrelated suffix\n', rc.read_text())
                        for name, content in before.items():
                            if name not in ('.zshrc', '.local/bin/claude-openai'):
                                self.assertEqual(after[name], content, name)
                        repeated = self.run_cli(home, False)
                        self.assertEqual(repeated.returncode, 0, repeated.stderr)
                        self.assertEqual(self.snapshot(home), after)


if __name__ == '__main__':
    unittest.main()
