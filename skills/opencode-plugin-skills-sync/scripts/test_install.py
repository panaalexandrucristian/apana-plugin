#!/usr/bin/env python3
"""Tests for install.py and the sync script on throw-away home folders.

They never call launchctl, systemctl or schtasks, and they write job files for every system
(--platform with --no-scheduler), so one macOS or Linux machine checks all three; they use symlinks
and /usr/bin/python3, so they do not run on Windows.
What they cannot show: that launchd, systemd or Task Scheduler accept the files, and that
OpenCode follows a Windows junction. Only an earlier version of the macOS job has been seen running.
After every test the real job files, script and links must be unchanged.

    python3 -B -m unittest discover -s skills/opencode-plugin-skills-sync/scripts -p 'test_*.py'
"""
import importlib.util
import io
import json
import os
import plistlib
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
INSTALL = HERE / "install.py"
SOURCE = HERE / "sync-claude-plugin-skills.py"
REAL = Path.home()
NAME = "opencode-plugin-skills-sync"
LINKS = ".config/opencode/claude-plugin-skills"
MARKETPLACE_SKILLS = "~/.claude/plugins/marketplaces/demo-market/skills"


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(root):
    snap = {}
    for path in sorted(root.rglob("*")):
        st = path.lstat()
        snap[str(path.relative_to(root))] = (st.st_mtime_ns, st.st_size, st.st_ino, os.readlink(path) if path.is_symlink() else None)
    return snap


def real_state():
    config = Path(os.environ.get("XDG_CONFIG_HOME") or REAL / ".config") / "opencode"
    files = [REAL / "Library/LaunchAgents/local.opencode-plugin-skills-sync.plist",
             REAL / f".config/systemd/user/{NAME}.service", REAL / f".config/systemd/user/{NAME}.path",
             REAL / f"AppData/Local/{NAME}/task.xml",
             REAL / ".config/opencode/sync-claude-plugin-skills.py", config / "sync-claude-plugin-skills.py"]
    state = {str(p): (p.stat().st_mtime_ns if p.exists() else None) for p in files}
    for out in {REAL / LINKS, config / "claude-plugin-skills"}:
        state[str(out)] = sorted((p.name, os.readlink(p) if p.is_symlink() else None) for p in out.iterdir()) if out.is_dir() else []
    return state


BEFORE = real_state()


def environment(**extra):
    """This process's environment without XDG_CONFIG_HOME, which would point a run at the real config folder."""
    env = {k: v for k, v in os.environ.items() if k != "XDG_CONFIG_HOME"}
    env.update(extra)
    return env


def job_files(home):
    return {
        "darwin": [home / "Library/LaunchAgents/local.opencode-plugin-skills-sync.plist"],
        "linux": [home / f".config/systemd/user/{NAME}.service", home / f".config/systemd/user/{NAME}.path"],
        "windows": [home / f"AppData/Local/{NAME}/task.xml"],
    }


class Home(unittest.TestCase):
    """A throw-away home whose one enabled plugin, demo-plugin@demo-market, has one skill, demo-skill."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="home with space ")
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.write(".claude/settings.json", {"enabledPlugins": {"demo-plugin@demo-market": True}})
        self.plugin("1.0.0")
        self.write(".config/opencode/opencode.jsonc", {"skills": ["~/" + LINKS]})
        self.link = self.home / LINKS / "demo-skill"

    def tearDown(self):
        self.assertEqual(real_state(), BEFORE, "the real job files, script or links changed")

    def write(self, relative, data):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data if isinstance(data, str) else json.dumps(data))
        return path

    def plugin(self, version):
        root = self.home / ".claude/plugins/cache/demo-market/demo-plugin" / version
        self.write(f".claude/plugins/cache/demo-market/demo-plugin/{version}/skills/demo-skill/SKILL.md",
                   "---\nname: demo-skill\ndescription: demo\n---\n")
        self.write(".claude/plugins/installed_plugins.json",
                   {"plugins": {"demo-plugin@demo-market": [{"scope": "user", "installPath": str(root)}]}})

    def install(self, platform="linux", *flags, env=None, home=True):
        command = [sys.executable, "-I", str(INSTALL), "--platform", platform, "--no-scheduler", *flags]
        result = subprocess.run(command + (["--home", str(self.home)] if home else []), capture_output=True, text=True,
                                env=env or environment())
        return result.returncode, result.stdout + result.stderr

    def sync(self, *args, env=None):
        return subprocess.run([sys.executable, "-I", str(SOURCE), *args], capture_output=True, text=True,
                              env=env or environment(HOME=str(self.home), USERPROFILE=str(self.home)))


class Lifecycle(Home):
    """Dry run, check, install, a second install, a plugin update, repairs and a broken link, on each system's job files."""

    def test_darwin(self):
        self.lifecycle("darwin")

    def test_linux(self):
        self.lifecycle("linux")

    def test_windows(self):
        self.lifecycle("windows")

    def lifecycle(self, platform):
        script = self.home / ".config/opencode/sync-claude-plugin-skills.py"

        before = snapshot(self.home)
        code, text = self.install(platform, "--dry-run")
        self.assertEqual((code, snapshot(self.home)), (0, before), "dry-run exits 0 and writes nothing: " + text)
        self.assertTrue("info" in text and "differs" in text, "dry-run reports the missing script and job files: " + text)

        code, text = self.install(platform, "--check")
        self.assertEqual((code, snapshot(self.home)), (1, before), "check on a fresh home exits 1 and writes nothing: " + text)
        self.assertTrue("warn" in text and "differs" in text, "check says the script and the job files are missing: " + text)

        code, text = self.install(platform)
        self.assertEqual(code, 0, text)
        self.assertEqual(script.read_bytes(), SOURCE.read_bytes(), "the installed script is byte-identical to the skill's copy")
        self.assertTrue(all(f.is_file() for f in job_files(self.home)[platform]), "all job files are written")
        self.check_job(platform, script)
        self.assertTrue(os.readlink(self.link).endswith("/1.0.0/skills/demo-skill"))

        before = snapshot(self.home)
        code, text = self.install(platform)
        self.assertEqual((code, snapshot(self.home)), (0, before), "a second install changes no file, no inode and no link: " + text)
        self.assertEqual(self.install(platform, "--check")[0], 0, "check on an installed home exits 0")

        self.plugin("2.0.0")
        code, text = self.install(platform)
        self.assertEqual(code, 0, text)
        self.assertTrue(os.readlink(self.link).endswith("/2.0.0/skills/demo-skill"), "after a plugin update the link points to 2.0.0")

        script.write_text("# changed by hand\n")
        self.assertEqual(self.install(platform, "--check")[0], 1, "check flags a script that differs from the skill's copy")
        code, text = self.install(platform)
        self.assertEqual((code, script.read_bytes()), (0, SOURCE.read_bytes()), "install restores a script that differs: " + text)

        job_files(self.home)[platform][0].write_bytes(b"changed by hand")
        self.assertEqual(self.install(platform, "--check")[0], 1, "check flags a job file that differs")
        self.assertEqual(self.install(platform)[0], 0, "install restores a job file that differs")

        (self.home / LINKS / "dangling").symlink_to(self.home / "does-not-exist")
        code, text = self.install(platform, "--check")
        self.assertTrue(code == 1 and "broken link" in text and "dangling" in text, "check names a broken link: " + text)

    def check_job(self, platform, script):
        files = job_files(self.home)[platform]
        config = str(self.home / ".config/opencode")
        watched = [str(self.home / ".claude/plugins/installed_plugins.json"), str(self.home / ".claude/settings.json")]
        if platform == "darwin":
            data = plistlib.loads(files[0].read_bytes())
            log = str(self.home / "Library/Logs/opencode-plugin-skills-sync.log")
            self.assertEqual(data["ProgramArguments"], ["/usr/bin/python3", "-I", str(script), "--config-dir", config, "--log", log])
            self.assertEqual(data["WatchPaths"], watched)
        elif platform == "linux":
            service, path = (f.read_text() for f in files)
            exec_line = re.search(r"^ExecStart=(.*)$", service, re.M).group(1)
            self.assertRegex(exec_line, r'^(/\S+|"/[^"]+") -I ', "an absolute python with -I")
            self.assertTrue(exec_line.endswith(f' -I "{script}" --config-dir "{config}"'), exec_line)
            self.assertTrue("Type=oneshot" in service and "StartLimitIntervalSec=0" in service, "oneshot, no start limit")
            self.assertEqual(re.findall(r"^PathChanged=(.*)$", path, re.M), watched)
            self.assertTrue(f"Unit={NAME}.service" in path and "WantedBy=default.target" in path, path)
        else:
            raw = files[0].read_bytes()
            text = raw.decode("utf-16")
            self.assertIn(raw[:2], (b"\xff\xfe", b"\xfe\xff"), "the task file is UTF-16 with a byte order mark")
            command, arguments = load_module(INSTALL, "install_under_test").parse_task_xml(text)
            self.assertIn(Path(command).name, ("pythonw.exe", Path(sys.executable).name), "pythonw.exe, or the running python")
            log = str(self.home / f"AppData/Local/{NAME}/sync.log")
            self.assertEqual(arguments, subprocess.list2cmdline(["-I", str(script), "--config-dir", config, "--log", log]))
            self.assertTrue("<LogonTrigger>" in text and "PT15M" in text and "<DisallowStartIfOnBatteries>false" in text,
                            "at logon and every 15 minutes, also on battery")


class OpenCodeConfig(Home):
    """Both global config files, JSONC, the deprecated {"paths": [...]} form, and a file that cannot be read."""

    def test_a_config_without_the_links_folder_is_reported_and_never_edited(self):
        config = self.write(".config/opencode/opencode.jsonc", '{ "skills": [] }')
        code, text = self.install()
        self.assertTrue(code == 1 and "does not list" in text, text)
        self.assertEqual(config.read_text(), '{ "skills": [] }')

    def test_comments_and_trailing_commas_are_read_as_opencode_reads_them(self):
        self.write(".config/opencode/opencode.jsonc", '{\n  "skills": [\n'
                   '    "~/.config/opencode/claude-plugin-skills", // the links, "and a quote"\n'
                   f'    /* "{MARKETPLACE_SKILLS}", */\n'
                   '    "~/a // b/*c*/,]",\n'
                   '  ],\n}\n')
        code, text = self.install()
        self.assertEqual(code, 0, text)
        self.assertTrue(self.link.is_symlink(), "a commented-out marketplace folder does not skip the plugin: " + text)

    def test_a_commented_out_links_folder_is_not_listed(self):
        self.write(".config/opencode/opencode.jsonc", '{\n  "skills": [\n    // "~/.config/opencode/claude-plugin-skills",\n  ],\n}\n')
        code, text = self.install()
        self.assertTrue(code == 1 and "does not list" in text, text)

    def test_opencode_json_alone_is_read(self):
        (self.home / ".config/opencode/opencode.jsonc").unlink()
        self.write(".config/opencode/opencode.json", {"skills": ["~/" + LINKS]})
        code, text = self.install()
        self.assertEqual(code, 0, text)
        self.assertTrue(self.link.is_symlink(), text)

    def test_the_lists_of_both_files_are_combined(self):
        self.write(".config/opencode/opencode.json", {"skills": [MARKETPLACE_SKILLS]})
        code, text = self.install()
        self.assertEqual(code, 0, text)
        self.assertTrue("sync: 0 skills" in text and not os.path.lexists(self.link),
                        "the marketplace folder listed in opencode.json skips the plugin: " + text)

    def test_the_deprecated_paths_form_is_read(self):
        self.write(".config/opencode/opencode.jsonc",
                   {"skills": {"paths": ["~/" + LINKS, MARKETPLACE_SKILLS], "urls": ["https://example.com/skills/"]}})
        code, text = self.install()
        self.assertEqual(code, 0, text)
        self.assertTrue("sync: 0 skills" in text and not os.path.lexists(self.link), "the marketplace folder in paths skips the plugin: " + text)

    def test_a_config_that_is_not_json_is_reported(self):
        self.write(".config/opencode/opencode.jsonc", '{ "skills": [')
        code, text = self.install()
        self.assertTrue(code == 1 and "is not valid JSON or JSONC" in text and "the sync failed" in text, text)


class XdgConfigHome(Home):
    """OpenCode's global config folder is $XDG_CONFIG_HOME/opencode when that is set."""

    def setUp(self):
        super().setUp()
        self.xdg = self.home / "xdg config"
        self.config = self.xdg / "opencode"
        self.write("xdg config/opencode/opencode.jsonc", {"skills": [str(self.config / "claude-plugin-skills")]})

    def test_the_installer_uses_it_and_writes_it_into_the_job(self):
        code, text = self.install(env=environment(HOME=str(self.home), XDG_CONFIG_HOME=str(self.xdg)), home=False)
        self.assertEqual(code, 0, text)
        self.assertEqual((self.config / "sync-claude-plugin-skills.py").read_bytes(), SOURCE.read_bytes())
        self.assertTrue((self.config / "claude-plugin-skills/demo-skill").is_symlink(), text)
        self.assertFalse((self.home / ".config/opencode/sync-claude-plugin-skills.py").exists() or (self.home / LINKS).exists())
        service = (self.home / f".config/systemd/user/{NAME}.service").read_text()
        self.assertIn(f'--config-dir "{self.config}"', service, "the job does not read XDG_CONFIG_HOME, so it is given the folder")

    def test_an_explicit_home_ignores_it(self):
        code, text = self.install(env=environment(XDG_CONFIG_HOME=str(self.xdg)))
        self.assertEqual(code, 0, text)
        self.assertTrue(self.link.is_symlink(), text)
        self.assertFalse((self.config / "claude-plugin-skills").exists() or (self.config / "sync-claude-plugin-skills.py").exists())

    def test_the_sync_script_uses_it_without_config_dir(self):
        result = self.sync(env=environment(HOME=str(self.home), XDG_CONFIG_HOME=str(self.xdg)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.config / "claude-plugin-skills/demo-skill").is_symlink(), result.stdout)
        self.assertFalse((self.home / LINKS).exists())


class MissingClaudeFiles(Home):
    """A file Claude Code has not written yet is a warning for the installer and nothing to link for the sync."""

    def test_without_settings_json(self):
        (self.home / ".claude/settings.json").unlink()
        code, text = self.install("linux", "--check")
        self.assertTrue(code == 1 and "settings.json does not exist" in text, text)
        code, text = self.install()
        self.assertTrue("the sync failed" not in text and "sync: 0 skills" in text, text)

    def test_without_installed_plugins_json(self):
        (self.home / ".claude/plugins/installed_plugins.json").unlink()
        code, text = self.install()
        self.assertTrue("the sync failed" not in text and "sync: 0 skills" in text, text)


class Installer(Home):
    def test_another_systems_job_is_refused_without_no_scheduler(self):
        other = "windows" if sys.platform != "win32" else "linux"
        result = subprocess.run([sys.executable, "-I", str(INSTALL), "--home", str(self.home), "--platform", other],
                                capture_output=True, text=True, env=environment())
        self.assertTrue(result.returncode == 1 and "--no-scheduler" in result.stdout, result.stdout)

    def test_loading_the_systemd_job_resets_a_failed_service(self):
        module = load_module(INSTALL, "install_systemd")
        calls, ok = [], mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(module, "run", side_effect=lambda cmd, env=None: calls.append(cmd[2:]) or ok):
            self.assertIsNone(module.Systemd(self.home, "/usr/bin/python3", ["/sync.py"], []).load())
        self.assertIn(["reset-failed", f"{NAME}.service"], calls)

    def test_systemd_quote_and_task_xml(self):
        module = load_module(INSTALL, "install_helpers")
        self.assertEqual(module.systemd_quote("/usr/bin/python3"), "/usr/bin/python3")
        self.assertEqual(module.systemd_quote("/home/a b/x%y$z.py"), '"/home/a b/x%%y$$z.py"')
        sample = module.task_xml("C:\\Python 3\\pythonw.exe", 'a "b" & <c>').decode("utf-16")
        self.assertEqual(module.parse_task_xml(sample), ("C:\\Python 3\\pythonw.exe", 'a "b" & <c>'))

    def test_a_good_run_clears_the_log_of_an_older_failure(self):
        log = self.write("Library/Logs/opencode-plugin-skills-sync.log", "Traceback (most recent call last):\n")
        code, text = self.install("darwin")
        self.assertTrue(code == 0 and not log.exists(), text)

    def test_a_failed_job_is_loaded_again_after_the_installers_own_sync(self):
        self.assertEqual(self.install("linux")[0], 0)
        module = load_module(INSTALL, "install_main")
        real_run, calls = module.run, []
        argv = ["install.py", "--platform", "linux", "--home", str(self.home)]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(module, "detect_platform", return_value="linux"), \
                mock.patch.object(module, "run", side_effect=lambda cmd, env=None: calls.append("sync") or real_run(cmd, env)), \
                mock.patch.multiple(module.Systemd, unusable=mock.Mock(return_value=None), state=mock.Mock(return_value=(True, "failed")),
                                    load=mock.Mock(side_effect=lambda: calls.append("load"))), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = module.main()
        self.assertEqual((code, calls), (0, ["sync", "load"]), "the sync runs before launchd would start the job: " + out.getvalue())


class Sync(Home):
    """The sync script on its own: --log, a real folder in the way, the apana plugin, the Windows fallbacks and the config reader."""

    def setUp(self):
        super().setUp()
        self.module = load_module(SOURCE, "sync_under_test")

    def test_log_is_written_on_failure_and_deleted_by_a_good_run(self):
        log = self.home / "sync.log"
        result = self.sync("--log", str(log))
        self.assertTrue(result.returncode == 0 and self.link.is_symlink() and not log.exists(), result.stdout)
        self.write(".claude/plugins/installed_plugins.json", "{ not json")
        result = self.sync("--log", str(log))
        self.assertTrue(result.returncode == 1 and "Traceback" in log.read_text() and result.stderr == "", result.stderr)
        self.plugin("1.0.0")
        result = self.sync("--log", str(log))
        self.assertTrue(result.returncode == 0 and not log.exists(), result.stderr)

    def test_a_real_folder_in_the_links_folder_is_kept_and_reported(self):
        self.assertEqual(self.sync().returncode, 0)
        self.link.unlink()
        self.link.mkdir()
        (self.link / "keep.txt").write_text("mine")
        result = self.sync()
        self.assertTrue(result.returncode == 0 and (self.link / "keep.txt").read_text() == "mine" and "is not a link" in result.stdout,
                        result.stdout)

    def test_the_apana_plugin_is_skipped(self):
        root = self.home / ".claude/plugins/cache/apana-private/apana/1.0.0"
        self.write(".claude/plugins/cache/apana-private/apana/1.0.0/skills/review-diff/SKILL.md", "---\nname: review-diff\n---\n")
        self.write(".claude/settings.json", {"enabledPlugins": {"demo-plugin@demo-market": True, "apana@apana-private": True}})
        installed = json.loads((self.home / ".claude/plugins/installed_plugins.json").read_text())
        installed["plugins"]["apana@apana-private"] = [{"scope": "user", "installPath": str(root)}]
        self.write(".claude/plugins/installed_plugins.json", installed)
        result = self.sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.link.is_symlink() and not os.path.lexists(self.home / LINKS / "review-diff"), result.stdout)
        self.assertIn("skipped apana@apana-private: apana's skills reach OpenCode through apana's own OpenCode plugin", result.stdout)

    def test_link_helpers(self):
        self.assertTrue(self.module.same_target("\\\\?\\C:\\a\\b", "C:\\a\\b"), "the \\\\?\\ prefix of a junction target is ignored")
        self.assertFalse(self.module.same_target("/a/b", "/a/c"))
        self.assertIsNone(self.module.link_target(self.home / "missing"))
        self.assertIsNone(self.module.link_target(self.home), "a real folder is not a link")

    def test_make_link_makes_a_junction_only_on_windows(self):
        calls = []
        with mock.patch.object(self.module.os, "symlink", side_effect=OSError("privilege not held")), \
                mock.patch.object(self.module.subprocess, "run", side_effect=lambda cmd, **kw: calls.append(cmd) or mock.Mock(returncode=0)):
            with mock.patch.object(self.module, "IS_WINDOWS", True):
                self.module.make_link(self.home / "x", self.home / "target")
            self.assertEqual(calls, [["cmd", "/c", "mklink", "/J", str(self.home / "x"), str(self.home / "target")]])
            with self.assertRaises(OSError):
                self.module.make_link(self.home / "y", self.home / "target")
            self.assertEqual(len(calls), 1, "off Windows a symlink error is not hidden")

    def test_only_absolute_and_home_paths_name_a_folder(self):
        config = self.home / ".config/opencode"
        self.write(".config/opencode/opencode.jsonc", {"skills": ["~/a", "/b", "https://example.com/skills/", "./c", "d", 7]})
        self.assertEqual(self.module.configured_skill_paths(config, self.home), [(self.home / "a").resolve(), Path("/b").resolve()])
        self.write(".config/opencode/opencode.jsonc", '["skills"]')
        self.assertEqual(self.module.configured_skill_paths(config, self.home), [], "a config that is not an object lists nothing")

    def test_a_bom_an_escaped_quote_and_an_open_comment_are_read_as_opencode_reads_them(self):
        path = self.home / "opencode.jsonc"
        path.write_bytes('\ufeff{"skills": ["a\\" // b", /* c */ "d",],}'.encode("utf-8"))
        self.assertEqual(self.module.read_jsonc(path), {"skills": ['a" // b', "d"]})
        path.write_text('{"skills": []} /* not closed')
        with self.assertRaisesRegex(ValueError, "not valid JSON or JSONC"):
            self.module.read_jsonc(path)


if __name__ == "__main__":
    unittest.main()
