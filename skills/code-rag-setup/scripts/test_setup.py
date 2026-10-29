import contextlib
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import setup


def env(home, **extra):
    base = {"CODE_RAG_HOME": str(home / "crh"), "HF_HOME": str(home / "hf"), "HOME": str(home), "PATH": ""}
    base.update(extra)
    return mock.patch.dict(os.environ, base, clear=True)


def fake_python(path, versions):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\necho '" + json.dumps(versions) + "'\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def fake_model(home):
    snap = home / "hf" / "hub" / "models--Qwen--Qwen3-Embedding-0.6B" / "snapshots" / "abc"
    snap.mkdir(parents=True)
    (snap / "config.json").write_text("{}")
    (snap / "model.safetensors").write_text("x")


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_pins_cover_the_measured_environment(self):
        pins = setup.read_pins()
        for name in ("torch", "sentence-transformers", "bm25s", "llama-index-core", "tree-sitter-language-pack",
                     "numpy", "transformers"):
            self.assertRegex(pins[name], r"^\d+\.\d+\.\d+$", name)

    def test_nothing_installed_is_not_ready(self):
        with env(self.tmp):
            report = setup.check()
        self.assertFalse(report["ready"])
        self.assertFalse(report["venv"])
        self.assertFalse(report["model_cached"])
        self.assertIsNone(report["uv"])

    def test_model_needs_config_and_weights(self):
        with env(self.tmp):
            snap = self.tmp / "hf" / "hub" / "models--Qwen--Qwen3-Embedding-0.6B" / "snapshots" / "abc"
            snap.mkdir(parents=True)
            (snap / "config.json").write_text("{}")
            self.assertFalse(setup.model_cached())
            (snap / "model.safetensors").write_text("x")
            self.assertTrue(setup.model_cached())

    def test_hub_cache_variable_wins_over_hf_home(self):
        with env(self.tmp, HF_HUB_CACHE=str(self.tmp / "elsewhere")):
            self.assertEqual(setup.hf_cache(), self.tmp / "elsewhere")

    def test_wrong_and_missing_packages_are_reported(self):
        versions = dict(setup.read_pins())
        versions["torch"] = "1.0.0"
        del versions["bm25s"]
        with env(self.tmp):
            fake_python(self.tmp / "crh" / "venv" / "bin" / "python", versions)
            fake_model(self.tmp)
            report = setup.check()
        self.assertEqual(report["missing"], ["bm25s"])
        self.assertEqual(report["wrong"], [{"package": "torch", "want": setup.read_pins()["torch"], "have": "1.0.0"}])
        self.assertFalse(report["ready"])

    def test_exact_pins_and_cached_model_are_ready(self):
        with env(self.tmp):
            fake_python(self.tmp / "crh" / "venv" / "bin" / "python", setup.read_pins())
            fake_model(self.tmp)
            self.assertTrue(setup.check()["ready"])

    def test_install_without_uv_stops_with_code_3_and_changes_nothing(self):
        out = io.StringIO()
        with env(self.tmp), contextlib.redirect_stdout(out):
            code = setup.install()
        self.assertEqual(code, setup.EXIT_NO_UV)
        self.assertEqual(json.loads(out.getvalue())["error"], "uv_missing")
        self.assertFalse((self.tmp / "crh").exists())

    def test_dry_run_prints_the_plan_and_runs_nothing(self):
        uv = self.tmp / "bin" / "uv"
        fake_python(uv, {})
        out = io.StringIO()
        with env(self.tmp, PATH=str(uv.parent)), contextlib.redirect_stdout(out), \
                mock.patch.object(setup.subprocess, "run") as run:
            code = setup.install(dry_run=True)
        self.assertEqual(code, 0)
        run.assert_not_called()
        lines = out.getvalue().splitlines()
        self.assertIn("venv --python 3.12", lines[0])
        self.assertIn("pip install --python", lines[1])
        self.assertTrue(any("snapshot_download" in step for step in setup.plan(self.tmp, "uv", False)[2]))
        self.assertFalse(any("snapshot_download" in " ".join(s) for s in setup.plan(self.tmp, "uv", True)))

    def test_setup_script_edits_no_settings_hooks_or_shell_profile(self):
        source = Path(setup.__file__).read_text()
        for forbidden in ("settings.json", "hooks.json", ".zshrc", ".bashrc", ".zprofile"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
