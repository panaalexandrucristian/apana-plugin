#!/usr/bin/env python3
"""Install the pinned Harness² package, not its benchmarks or model providers."""

import argparse
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys


REPO = "https://github.com/google-research/harness2.git"
REV = "6868817518876de8fd170c6a8354daca273b6191"
MARKER = ".apana-harness2-ready"
CLIS = ("harness2", "harness2-demo", "harness2-setup", "harness2-check",
        "harness2-judge", "harness2-report")
GIT_REPO_ENV = (
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
)


def commands(root, git, uv):
    return (
        (git, "clone", "--no-checkout", REPO, str(root)),
        (git, "switch", "--detach", REV),
        (uv, "venv", "--python", "3.12", ".venv"),
        (uv, "pip", "install", "--python", ".venv/bin/python", "-e", ".[render]"),
    )


def output(argv, root):
    return subprocess.check_output(argv, cwd=root, text=True).strip()


def verify(root, git):
    git_dir = root / ".git"
    if git_dir.is_symlink() or not git_dir.is_dir():
        raise ValueError("missing or redirected Git checkout")
    checkout = (git, "--git-dir=.git", "--work-tree=.")
    if output((*checkout, "remote", "get-url", "origin"), root) != REPO:
        raise ValueError("unexpected Git origin")
    if output((*checkout, "rev-parse", "HEAD"), root) != REV:
        raise ValueError("unexpected Git revision")
    venv = root / ".venv"
    bin_dir = venv / "bin"
    if any(path.is_symlink() or not path.is_dir() for path in (venv, bin_dir)):
        raise ValueError("missing or redirected virtual environment")
    venv_config = venv / "pyvenv.cfg"
    if venv_config.is_symlink() or not venv_config.is_file():
        raise ValueError("missing or redirected pyvenv.cfg")
    # Probe the interpreter without loading editable-install .pth files.
    probe = "import platform,sys; print(platform.machine(), *sys.version_info[:2])"
    if output((str(bin_dir / "python"), "-IBS", "-c", probe), root) != "arm64 3 12":
        raise ValueError("expected a native arm64 Python 3.12 interpreter")
    for cli in CLIS:
        path = bin_dir / cli
        if path.is_symlink() or not path.is_file() or shutil.which(str(path)) is None:
            raise ValueError(f"missing or invalid CLI: {cli}")


def status(root, git):
    for path in (*reversed(root.parents), root):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError(f"destination crosses a symlink or non-directory: {path}")
    if not root.exists():
        return False
    marker = root / MARKER
    if marker.is_symlink() or not marker.is_file() or marker.read_text() != REV + "\n":
        raise ValueError("destination is foreign or incomplete")
    verify(root, git)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("check", help="inspect without writing or downloading")
    sub.add_parser("install", help="install after approval or reuse a verified copy").add_argument(
        "--dry-run", action="store_true", help="show planned commands without writes or downloads"
    )
    args = parser.parse_args(argv)
    root = Path.home().resolve() / ".local" / "share" / "apana" / "harness2"
    try:
        if (platform.system(), platform.machine()) != ("Darwin", "arm64"):
            raise ValueError("requires native macOS arm64 (Apple Silicon, not Rosetta)")
        git = shutil.which("git")
        if git is None:
            raise ValueError("Git is required")
        overrides = [name for name in GIT_REPO_ENV if name in os.environ]
        if overrides:
            raise ValueError(f"unset Git checkout overrides first: {', '.join(overrides)}")
        ready = status(root, git)
        uv = shutil.which("uv")
        print(f"Harness²: {'ready' if ready else 'not installed'} at {root}", flush=True)
        print(f"Source: {REPO} @ {REV}", flush=True)
        if ready:
            for cli in CLIS:
                print(root / ".venv" / "bin" / cli)
            return 0
        if uv is None:
            raise ValueError("uv is required; install it separately")
        if not shutil.which("python3"):
            raise ValueError("python3 is required")
        if args.action == "check":
            return 0
        steps = commands(root, git, uv)
        if args.dry_run:
            for argv in steps:
                print(shlex.join(argv))
            return 0
        root.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive reservation; a second invocation must not join a partial install.
        root.mkdir(mode=0o700)
        for index, argv in enumerate(steps):
            subprocess.run(argv, cwd=root.parent if index == 0 else root, check=True)
        verify(root, git)
        with (root / MARKER).open("x") as marker:
            marker.write(REV + "\n")
        print(f"Harness²: installed at {root}")
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        print(f"Harness² stopped at {root}: {error or 'interrupted'}. Existing files were not removed.",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
