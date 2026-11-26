#!/usr/bin/env python3
"""Install or check the background job that keeps Claude Code plugin skills linked into OpenCode.

It copies sync-claude-plugin-skills.py (next to this file) to OpenCode's global config folder
($XDG_CONFIG_HOME/opencode, or ~/.config/opencode), writes the job definition for this system, runs
the sync once and loads the job:

  macOS    LaunchAgent in ~/Library/LaunchAgents: runs the sync when a watched file changes, and at login
  Linux    systemd user units in ~/.config/systemd/user: a path unit runs the sync when a watched file changes
  Windows  Task Scheduler task: runs the sync at logon and every 15 minutes (Windows cannot watch files)

A job does not start from the shell, so it does not see XDG_CONFIG_HOME: the folder found here is
written into the job. It is idempotent: a file or a job that is already right is left alone. It never
edits OpenCode's config.

  --check         report only; change nothing and do not run the sync
  --dry-run       show what would change; write nothing
  --no-scheduler  write the files but do not call launchctl, systemctl or schtasks
                  (for tests, or a system without a user session)
  --platform P    darwin, linux or windows: write that system's job files (for tests; needs --no-scheduler)
  --home DIR      use another home folder (for tests); the config folder is then DIR/.config/opencode,
                  whatever XDG_CONFIG_HOME says, so a throw-away home never reaches the real one
"""
import argparse
import html
import importlib.util
import os
import plistlib
import re
import shutil
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

NAME = "opencode-plugin-skills-sync"
LABEL = f"local.{NAME}"
SCRIPT_NAME = "sync-claude-plugin-skills.py"
SOURCE = Path(__file__).resolve().parent / SCRIPT_NAME
POLL_MINUTES = 15
problems = 0


def say(kind, text):
    global problems
    if kind in ("warn", "fail"):
        problems += 1
    print(f"{kind} {text}")


def run(cmd, env=None):
    return subprocess.run(cmd, capture_output=True, text=True, env=env)


def detect_platform():
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform == "win32":
        return "windows"
    return "linux"


def job_python(platform):
    """The interpreter the job runs: a system one that a package manager does not replace, where there is one."""
    if platform == "darwin":
        return "/usr/bin/python3"
    if platform == "linux":
        for candidate in ("/usr/bin/python3", shutil.which("python3")):
            if candidate and os.access(candidate, os.X_OK):
                return candidate
        return sys.executable
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    return str(pythonw if pythonw.is_file() else sys.executable)


def load_sync():
    """The sync script as a module, so that the check here reads OpenCode's config the way the job does."""
    sys.dont_write_bytecode = True  # no __pycache__ next to SOURCE, which may be the plugin cache
    spec = importlib.util.spec_from_file_location("sync_claude_plugin_skills", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Job:
    """What one system needs: files to write, a way to ask if the job is loaded, a way to load it."""

    name = NAME
    log = None
    files = []

    def same(self, path, data):
        return path.is_file() and path.read_bytes() == data

    def unusable(self):
        return None

    def state(self):
        raise NotImplementedError

    def load(self):
        raise NotImplementedError


class Launchd(Job):
    name = LABEL

    def __init__(self, home, python, sync, watch):
        self.plist = home / "Library/LaunchAgents" / f"{LABEL}.plist"
        self.log = home / "Library/Logs/opencode-plugin-skills-sync.log"
        self.data = {
            "Label": LABEL,
            "ProgramArguments": [python, "-I", *sync, "--log", str(self.log)],
            "WatchPaths": [str(p) for p in watch],
            "RunAtLoad": True,
            "ThrottleInterval": 10,
            "StandardOutPath": "/dev/null",
            "StandardErrorPath": str(self.log),
        }
        self.files = [(self.plist, plistlib.dumps(self.data, fmt=plistlib.FMT_XML))]

    def same(self, path, data):
        try:
            return plistlib.loads(path.read_bytes()) == self.data
        except (OSError, plistlib.InvalidFileException, ValueError):
            return False

    def state(self):
        result = run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"])
        if result.returncode != 0:
            return False, None
        code = "(unknown)"
        for line in result.stdout.splitlines():
            if line.strip().startswith("last exit code ="):
                code = line.split("=", 1)[1].strip()
        if code in ("0", "(never exited)"):
            return True, None
        return True, f"last exit code of the job is {code}; read {self.log}"

    def load(self):
        domain = f"gui/{os.getuid()}"
        run(["launchctl", "bootout", f"{domain}/{LABEL}"])
        result = run(["launchctl", "bootstrap", domain, str(self.plist)])
        return None if result.returncode == 0 else (result.stderr.strip() or result.stdout.strip())


def systemd_quote(text):
    """One word of an ExecStart line: quoted when it has a space or a character systemd treats as special."""
    if not re.search(r"[\s\"'\\$%]", text):
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


class Systemd(Job):
    def __init__(self, home, python, sync, watch):
        unit_dir = home / ".config/systemd/user"
        self.name = f"{NAME}.path"
        self.service_name = f"{NAME}.service"
        service = (
            "[Unit]\n"
            "Description=Link the skills of Claude Code plugins into OpenCode\n"
            "StartLimitIntervalSec=0\n"
            "\n"
            "[Service]\n"
            "Type=oneshot\n"
            f"ExecStart={' '.join(systemd_quote(word) for word in [python, '-I', *sync])}\n"
            "\n"
            "[Install]\n"
            "WantedBy=default.target\n"
        )
        watched = "".join(f"PathChanged={str(p).replace('%', '%%')}\n" for p in watch)
        path = (
            "[Unit]\n"
            "Description=Watch the Claude Code plugin files and refresh the OpenCode skill links\n"
            "\n"
            "[Path]\n"
            f"{watched}"
            f"Unit={self.service_name}\n"
            "\n"
            "[Install]\n"
            "WantedBy=default.target\n"
        )
        self.files = [(unit_dir / self.service_name, service.encode()), (unit_dir / self.name, path.encode())]

    def systemctl(self, *args):
        return run(["systemctl", "--user", *args])

    def unusable(self):
        if not shutil.which("systemctl"):
            return "systemctl not found: this Linux has no systemd. Run the sync from cron instead (see SKILL.md)"
        if self.systemctl("show-environment").returncode != 0:
            return "no systemd user session (a container, or an ssh login without one). Run the sync from cron instead (see SKILL.md)"
        return None

    def state(self):
        if self.systemctl("is-active", self.name).stdout.strip() != "active":
            return False, None
        if self.systemctl("is-failed", self.service_name).returncode == 0:
            return True, f"the sync service failed the last time; read: journalctl --user -u {self.service_name} -n 20"
        return True, None

    def load(self):
        for args in (("daemon-reload",), ("enable", self.name, self.service_name), ("restart", self.name)):
            result = self.systemctl(*args)
            if result.returncode != 0:
                return f"systemctl --user {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}"
        self.systemctl("reset-failed", self.service_name)  # a failed oneshot stays failed until reset; restarting the path unit does not reset it
        return None


def task_xml(command, arguments):
    text = f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Link the skills of Claude Code plugins into OpenCode</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT{POLL_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(command)}</Command>
      <Arguments>{escape(arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
"""
    return text.encode("utf-16")


def parse_task_xml(text):
    """(command, arguments) of the first action of a task XML, or None."""
    command = re.search(r"<Command>(.*?)</Command>", text, re.DOTALL)
    arguments = re.search(r"<Arguments>(.*?)</Arguments>", text, re.DOTALL)
    if not command:
        return None
    return html.unescape(command.group(1).strip()), html.unescape(arguments.group(1).strip() if arguments else "")


class TaskScheduler(Job):
    def __init__(self, home, python, sync, watch):
        base = home / "AppData/Local" / NAME
        self.xml = base / "task.xml"
        self.log = base / "sync.log"
        self.command = python
        self.arguments = subprocess.list2cmdline(["-I", *sync, "--log", str(self.log)])
        self.files = [(self.xml, task_xml(self.command, self.arguments))]

    def state(self):
        result = run(["schtasks", "/Query", "/TN", NAME, "/XML"])
        if result.returncode != 0:
            return False, None
        if parse_task_xml(result.stdout) != (self.command, self.arguments):
            return False, None
        return True, None

    def load(self):
        result = run(["schtasks", "/Create", "/TN", NAME, "/XML", str(self.xml), "/F"])
        return None if result.returncode == 0 else (result.stderr.strip() or result.stdout.strip())


JOBS = {"darwin": Launchd, "linux": Systemd, "windows": TaskScheduler}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-scheduler", action="store_true")
    parser.add_argument("--platform", choices=sorted(JOBS))
    parser.add_argument("--home", type=Path)
    args = parser.parse_args()
    home = (args.home or Path.home()).expanduser().absolute()
    write = not (args.check or args.dry_run)
    use_scheduler = not args.no_scheduler
    platform = args.platform or detect_platform()

    if args.home is None and os.environ.get("XDG_CONFIG_HOME"):
        config_dir = Path(os.environ["XDG_CONFIG_HOME"]).expanduser().absolute() / "opencode"
    else:
        config_dir = home / ".config/opencode"
    script = config_dir / SCRIPT_NAME
    out_dir = config_dir / "claude-plugin-skills"
    sync = [str(script), "--config-dir", str(config_dir)]
    watch = [home / ".claude/plugins/installed_plugins.json", home / ".claude/settings.json"]
    python = job_python(platform)

    if not SOURCE.is_file():
        say("fail", f"{SOURCE} is missing; the skill folder is incomplete")
        return 1
    if use_scheduler and platform != detect_platform():
        say("fail", f"--platform {platform} on {detect_platform()} needs --no-scheduler; the job could not be loaded here")
        return 1
    if not os.access(python, os.X_OK):
        say("fail", f"{python} is not executable; the job could not start")
        return 1

    for path in watch:
        if not path.is_file():
            say("warn", f"{path} does not exist; Claude Code has not written it yet, so the job has nothing to watch")
    try:
        listed = out_dir.resolve() in load_sync().configured_skill_paths(config_dir, home)
    except ValueError as error:
        say("warn", str(error))
    else:
        if not listed:
            say("warn", f"OpenCode's config in {config_dir} (opencode.json, opencode.jsonc) does not list {out_dir} in \"skills\"; "
                        "OpenCode will not read the links. Add it by hand; this script never edits the config")

    wanted = SOURCE.read_bytes()
    if script.is_file() and script.read_bytes() == wanted:
        say("ok", f"{script} is up to date")
    elif write:
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_bytes(wanted)
        say("ok", f"installed {script}")
    else:
        say("warn" if args.check else "info", f"{script} is missing or differs from the skill's copy")

    job = JOBS[platform](home, python, sync, watch)
    changed = False
    for path, data in job.files:
        if job.same(path, data):
            say("ok", f"{path} is up to date")
            continue
        changed = True
        if write:
            path.parent.mkdir(parents=True, exist_ok=True)
            if job.log:
                job.log.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            say("ok", f"wrote {path}")
        else:
            say("warn" if args.check else "info", f"{path} is missing or differs from the expected one")

    # The sync runs before the job is loaded: launchd starts the job at load, and two syncs at once can make or remove the same link.
    if write and script.is_file():
        interpreter = sys.executable if platform == "windows" else python
        env = dict(os.environ, HOME=str(home), USERPROFILE=str(home))
        result = run([interpreter, "-I", *sync], env=env)
        if result.returncode != 0:
            say("fail", f"the sync failed: {result.stderr.strip()[-300:]}")
        else:
            say("info", f"sync: {result.stdout.strip().splitlines()[-1] if result.stdout.strip() else 'no output'}")
            if job.log:
                job.log.unlink(missing_ok=True)  # a good run clears an older failure, as the job's own good run does

    if use_scheduler:
        reason = job.unusable()
        if reason:
            say("fail", reason)
        else:
            loaded, problem = job.state()
            if write and (changed or not loaded or problem):  # a job whose last run failed is loaded again; launchd runs it at load
                error = job.load()
                if error:
                    say("fail", f"loading job {job.name} failed: {error}")
                else:
                    say("ok", f"job {job.name} loaded")
            elif not loaded:
                say("warn" if args.check else "info", f"job {job.name} is not loaded")
            else:
                say("ok", f"job {job.name} is loaded")
                if problem:
                    say("warn", problem)
    if job.log and job.log.is_file() and job.log.stat().st_size > 0:
        say("warn", f"{job.log} is not empty ({job.log.stat().st_size} bytes); read it")

    links = []
    if out_dir.is_dir():
        for entry in out_dir.iterdir():
            try:
                os.readlink(entry)
            except (OSError, ValueError):
                continue
            links.append(entry)
    broken = sorted(p.name for p in links if not p.exists())
    if broken:
        say("warn", f"{len(broken)} broken link(s) in {out_dir}: {', '.join(broken)}")
    else:
        say("ok", f"{len(links)} link(s) in {out_dir}, none broken")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
