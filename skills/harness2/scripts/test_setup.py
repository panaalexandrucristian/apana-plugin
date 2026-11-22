"""Offline installer checks; no cloned repository, model, or home writes."""

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import setup


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.home = Path(temp).resolve()
        self.enterContext(patch.dict(os.environ, clear=True))
        self.root = self.home / ".local/share/apana/harness2"
        self.enterContext(patch.object(setup.Path, "home", return_value=self.home))
        self.enterContext(patch.object(setup.platform, "system", return_value="Darwin"))
        self.machine = self.enterContext(patch.object(setup.platform, "machine", return_value="arm64"))
        self.which = self.enterContext(patch.object(setup.shutil, "which", side_effect=self.resolve))
        self.run = self.enterContext(patch.object(setup.subprocess, "run"))
        self.probe = self.enterContext(patch.object(setup.subprocess, "check_output",
                                                 side_effect=self.probe_result))

    def resolve(self, name):
        return name if name.startswith("/") and Path(name).exists() else (
            f"/tools/{name}" if name in {"git", "python3", "uv"} else None
        )

    def probe_result(self, argv, **kwargs):
        if argv[3:4] == ("remote",):
            self.assertEqual(argv[1:3], ("--git-dir=.git", "--work-tree=."))
            return setup.REPO + "\n"
        if argv[3:4] == ("rev-parse",):
            self.assertEqual(argv[1:3], ("--git-dir=.git", "--work-tree=."))
            return setup.REV + "\n"
        self.assertEqual(argv[0], str(self.root / ".venv/bin/python"))
        self.assertEqual(argv[1:3], ("-IBS", "-c"))
        return "arm64 3 12\n"

    def invoke(self, *args):
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = setup.main(args)
        return code, out.getvalue() + err.getvalue()

    def cli_files(self):
        bin_dir = self.root / ".venv/bin"
        bin_dir.mkdir(parents=True)
        (self.root / ".git").mkdir()
        (bin_dir.parent / "pyvenv.cfg").touch()
        for cli in setup.CLIS:
            (bin_dir / cli).touch()

    def test_missing_install_check_and_preview_are_read_only(self):
        self.assertEqual(self.invoke("check")[0], 0)
        code, text = self.invoke("install", "--dry-run")
        self.assertEqual(code, 0, text)
        self.assertIn(setup.REV, text)
        self.assertIn("uv pip install", text)
        self.assertEqual(list(self.home.iterdir()), [])
        self.run.assert_not_called()
        self.probe.assert_not_called()

    def test_missing_uv_or_non_native_platform_stops_before_writes(self):
        self.which.side_effect = lambda name: None if name == "uv" else self.resolve(name)
        code, text = self.invoke("install")
        self.assertEqual(code, 1)
        self.assertIn("uv is required", text)
        self.machine.return_value = "x86_64"
        code, text = self.invoke("install")
        self.assertEqual(code, 1)
        self.assertIn("requires native macOS arm64", text)
        self.assertEqual(list(self.home.iterdir()), [])
        self.run.assert_not_called()

    def test_install_verifies_and_reuses_without_writes_or_downloads(self):
        def finish(argv, **kwargs):
            if argv[1:3] == ("pip", "install"):
                self.cli_files()

        self.run.side_effect = finish
        self.assertEqual(self.invoke("install")[0], 0)
        steps = [entry.args[0] for entry in self.run.call_args_list]
        self.assertEqual(steps, list(setup.commands(self.root, "/tools/git", "/tools/uv")))
        marker = self.root / setup.MARKER
        self.assertEqual(marker.read_text(), setup.REV + "\n")
        stamp = marker.stat().st_mtime_ns
        self.run.reset_mock()
        code, text = self.invoke("install")
        self.assertEqual(code, 0, text)
        self.assertIn(str(self.root / ".venv/bin/harness2-demo"), text)
        self.assertEqual(marker.stat().st_mtime_ns, stamp)
        self.run.assert_not_called()

    def test_failed_install_stays_unmarked_and_is_not_overwritten(self):
        self.run.side_effect = subprocess.CalledProcessError(1, ["git"])
        self.assertEqual(self.invoke("install")[0], 1)
        self.assertFalse((self.root / setup.MARKER).exists())
        retained = self.root / "retained"
        retained.write_text("keep\n")
        self.run.reset_mock()
        code, text = self.invoke("install")
        self.assertEqual(code, 1)
        self.assertIn("foreign or incomplete", text)
        self.assertEqual(retained.read_text(), "keep\n")
        self.run.assert_not_called()

    def test_broken_symlink_destination_is_not_followed(self):
        self.root.parent.mkdir(parents=True)
        target = self.home / "other"
        self.root.symlink_to(target)
        code, text = self.invoke("install")
        self.assertEqual(code, 1)
        self.assertIn("symlink", text)
        self.assertFalse(target.exists())
        self.run.assert_not_called()

    def test_marker_does_not_override_origin_revision_or_required_clis(self):
        self.cli_files()
        (self.root / setup.MARKER).write_text(setup.REV + "\n")
        for command, message in (("remote", "unexpected Git origin"),
                                 ("rev-parse", "unexpected Git revision")):
            self.probe.side_effect = lambda argv, **kw: (
                "other" if argv[3:4] == (command,) else self.probe_result(argv, **kw)
            )
            self.assertIn(message, self.invoke("install")[1])
        self.probe.side_effect = self.probe_result
        (self.root / ".venv/bin/harness2-demo").unlink()
        self.assertIn("missing or invalid CLI", self.invoke("install")[1])
        (self.root / ".venv/pyvenv.cfg").unlink()
        self.assertIn("missing or redirected pyvenv.cfg", self.invoke("install")[1])
        self.run.assert_not_called()

    def test_marker_does_not_allow_missing_or_redirected_git_checkout(self):
        self.root.mkdir(parents=True)
        (self.root / setup.MARKER).write_text(setup.REV + "\n")
        git_dir = self.root / ".git"
        for target in (None, self.root.parent / ".git"):
            with self.subTest(target=target):
                if target is not None:
                    target.mkdir()
                    git_dir.symlink_to(target, target_is_directory=True)
                code, text = self.invoke("check")
                self.assertEqual(code, 1)
                self.assertIn("missing or redirected Git checkout", text)
        self.probe.assert_not_called()
        self.run.assert_not_called()

    def test_git_checkout_overrides_stop_before_any_git_command(self):
        with patch.dict(os.environ, GIT_DIR="/foreign/.git", GIT_INDEX_FILE="/foreign/index"):
            code, text = self.invoke("install")
        self.assertEqual(code, 1)
        self.assertIn("unset Git checkout overrides first: GIT_DIR, GIT_INDEX_FILE", text)
        self.assertEqual(list(self.home.iterdir()), [])
        self.probe.assert_not_called()
        self.run.assert_not_called()
