#!/usr/bin/env python3
"""Install, start and stop oMLX on this Mac, and remember what worked.

    python3 -I omlx_ctl.py status [--model owner/repo]
    python3 -I omlx_ctl.py install [--force]
    python3 -I omlx_ctl.py start --model owner/repo [--tier T] [--fraction F] [--context N] [--system-prompt TEXT]
    python3 -I omlx_ctl.py stop [--force]
    python3 -I omlx_ctl.py remember --note TEXT [--model owner/repo]

`start` needs the model already downloaded (fetch_model.py). It computes the offload plan with propose_config.py,
starts the server detached (it survives the session), applies the settings, loads the model, retries with the
`aggressive` memory guard and smaller resident fractions when the load is refused for lack of RAM, proves the
offload from the lines this load wrote to the server log, times short chats and prints the chat link and the key file
link. A server this run started is stopped again when the run fails. What worked is kept in ~/.omlx/skill-state.json.
The API key is never printed and never put on a command line.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_model as fm  # noqa: E402
import propose_config as pc  # noqa: E402
import sweep_offload as sw  # noqa: E402

DEFAULT_MODEL = "froggeric/Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-4bit"
APP = Path("/Applications/oMLX.app")
OMLX_HOME = Path.home() / ".omlx"
BASE = "http://127.0.0.1:8000"
RELEASES = "https://api.github.com/repos/jundot/omlx/releases?per_page=30"
STABLE_TAG = re.compile(r"v\d+\.\d+\.\d+")
CEILING_MSG = "dynamic memory ceiling"
OFFLOAD_LOG = re.compile(r"moe expert offload: wrapped (\d+) layers at ([\d.]+)% residency \(expert tables: ([\d.]+) GB total, ([\d.]+) GB resident\)")
MEASURE_PROMPT = "Explain in three sentences what a mixture-of-experts language model is."
MIN_MEASURED_TOKENS = 32
MEASURE_RUNS = 3
LOADED_LOG = re.compile(r"Loaded model: .*?\(actual: ([\d.]+)GB")
MAX_SAFETENSORS_HEADER = 100 * 1024 * 1024
PROBE_TIMEOUT = 3  # seconds a probe of port 8000 may take before the server counts as busy


def cli_path() -> Path:
    return APP / "Contents" / "MacOS" / "omlx-cli"


def key_file() -> Path:
    return OMLX_HOME / "api_key"


def state_file() -> Path:
    return OMLX_HOME / "skill-state.json"


def pid_file() -> Path:
    return OMLX_HOME / "skill-server.pid"


def log_file() -> Path:
    return OMLX_HOME / "logs" / "skill-serve.log"


def models_dir() -> Path:
    return OMLX_HOME / "models"


@contextlib.contextmanager
def file_lock(name: str):
    """Hold an exclusive lock on ~/.omlx/<name>.lock until the block ends, so two runs of the skill do not interleave. Not reentrant."""
    OMLX_HOME.mkdir(parents=True, exist_ok=True)
    with open(OMLX_HOME / f"{name}.lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


# --- remembered state -------------------------------------------------------------------

def load_state() -> dict:
    try:
        state = json.loads(state_file().read_text())
        if not isinstance(state, dict):
            raise ValueError("not a JSON object")
    except FileNotFoundError:
        state = {}
    except (OSError, ValueError) as e:
        print(f"warning: {state_file()} is unreadable ({e}); using empty state. The next save keeps a copy of it next to it.", file=sys.stderr)
        state = {}
    state.setdefault("models", {})
    state.setdefault("notes", [])
    return state


def save_state(state: dict) -> None:
    """Replace the state file atomically (a private temp file, fsynced). An unreadable old file is kept as skill-state.corrupt-<time>.json."""
    OMLX_HOME.mkdir(parents=True, exist_ok=True)
    try:
        if not isinstance(json.loads(state_file().read_text()), dict):
            raise ValueError
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        shutil.copy2(state_file(), state_file().with_name(f"skill-state.corrupt-{int(time.time())}.json"))
    fd, tmp = tempfile.mkstemp(dir=OMLX_HOME, prefix="skill-state.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, state_file())
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def update_state(change) -> None:
    """Read, change and write the state under a lock, so a run that took minutes does not overwrite what another run saved meanwhile."""
    with file_lock("skill-state"):
        state = load_state()
        change(state)
        save_state(state)


# --- pure helpers -----------------------------------------------------------------------

def safetensors_complete(path: Path) -> bool:
    """True when the file is exactly as long as its own header says (8 + header length + the end of the last tensor); a truncated or header-only file is not."""
    try:
        with open(path, "rb") as f:
            raw = f.read(8)
            if len(raw) < 8:
                return False
            (n,) = struct.unpack("<Q", raw)
            if n > MAX_SAFETENSORS_HEADER:
                return False
            header = json.loads(f.read(n))
        end = max((v["data_offsets"][1] for k, v in header.items() if k != "__metadata__"), default=0)
        return path.stat().st_size == 8 + n + end
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
        return False


def model_complete(d: Path) -> bool:
    """True when the model directory holds a config and every weight file is complete: each safetensors file has the length its own header declares."""
    if not (d / "config.json").is_file():
        return False
    index = d / "model.safetensors.index.json"
    if not index.is_file():
        files = sorted(d.glob("*.safetensors"))
        return bool(files) and not any(d.glob("model-*-of-*.safetensors")) and all(safetensors_complete(f) for f in files)
    try:
        meta = json.loads(index.read_text())
    except ValueError:
        return False
    shards = set(meta.get("weight_map", {}).values())
    if not shards or not all((d / s).is_file() and safetensors_complete(d / s) for s in shards):
        return False
    total = (meta.get("metadata") or {}).get("total_size")
    return total is None or sum((d / s).stat().st_size for s in shards) >= total


def source_conflict(d: Path, repo: str) -> str | None:
    """Why `d` cannot be `repo`: fetch_model.py records which repo filled the folder, and the folder is named after the repo name only."""
    try:
        record = json.loads((d / fm.SOURCE_FILE).read_text())
        src = record.get("repo")
    except (OSError, ValueError, AttributeError):
        return None  # a folder without the record (copied by hand) is taken as it is
    if src not in (None, repo):
        return f"{d} was downloaded from {src}, not {repo}: both repos have the same folder name"
    if record.get("complete") is False:  # fetch_model.py marks the folder unfinished while it fills it and when a file failed or a stale shard is left
        return f"{d} is not finished (a download is running or failed, or a shard from another revision is left): run fetch_model.py {repo} and delete what it reports as STALE"
    return None


def pick_dmg(releases: list[dict], macos_major: int) -> tuple[str, str, str, str] | None:
    """(tag, asset name, url, sha256) of the newest plain vX.Y.Z release for this macOS; rc and dev tags are skipped."""
    suffix = "macos26-27.dmg" if macos_major >= 26 else "macos15-sequoia.dmg"
    for r in releases:
        if r.get("draft") or r.get("prerelease") or not STABLE_TAG.fullmatch(r.get("tag_name", "")):
            continue
        for a in r.get("assets", []):
            if a["name"].endswith(suffix):
                return r["tag_name"], a["name"], a["browser_download_url"], (a.get("digest") or "").removeprefix("sha256:")
    return None


def build_attempts(tier: str, fraction: float | None, lower: list[float]) -> list[tuple[str, float | None]]:
    """Load attempts in order: the planned tier, then `aggressive`, then smaller resident fractions under `aggressive`."""
    tiers = [tier] + (["aggressive"] if tier != "aggressive" else [])
    return [(t, fraction) for t in tiers] + [("aggressive", f) for f in lower]


def exclusive_resets(current: dict, offload: bool) -> dict:
    """Fields to switch off in the PUT: a PUT changes only what it names, and oMLX refuses offload next to MTP (for most families)."""
    if offload and current.get("mtp_enabled"):
        return {"mtp_enabled": False}
    if not offload and current.get("moe_expert_offload_enabled"):
        return {"moe_expert_offload_enabled": False}
    return {}


def read_key() -> str:
    try:
        return key_file().read_text().strip()
    except OSError:
        return ""


def key_value() -> str:
    key = read_key()
    if not key:
        sys.exit(f"{key_file()} is missing or empty; delete it and run start again to create a new key")
    return key


def ensure_key() -> None:
    """Create the key file (mode 600) when missing; make an existing one private; refuse an empty one."""
    kf = key_file()
    if not kf.exists():
        import secrets
        OMLX_HOME.mkdir(parents=True, exist_ok=True)
        fd = os.open(kf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_urlsafe(32))
        except BaseException:
            kf.unlink(missing_ok=True)
            raise
    elif kf.stat().st_mode & 0o077:
        kf.chmod(0o600)
        print(f"fixed: {kf} could be read by other users; its mode is now 600", file=sys.stderr)
    key_value()


# --- server ---------------------------------------------------------------------------------

def server_state() -> str:
    """down | busy (the port is taken but nothing answered in time) | open (answers without a key, so it is not our server) |
    needs_key (wants a key and is not the server this skill recorded, or rejects our key) | ours (the recorded server, and it accepts our key)"""
    def probe(headers: dict) -> int | None:
        try:
            return urllib.request.urlopen(urllib.request.Request(BASE + "/v1/models", headers=headers), timeout=PROBE_TIMEOUT).status
        except urllib.error.HTTPError as e:
            return e.code
        except OSError as e:  # URLError is an OSError
            return None if isinstance(getattr(e, "reason", e), ConnectionRefusedError) else -1
    anon = probe({})
    if anon is None:
        return "down"
    if anon == -1:
        return "busy"
    if anon == 200:
        return "open"
    key = read_key()
    if key and port_owned_by(managed_pid()):  # never hand the key to a listener this skill did not start
        with_key = probe({"Authorization": f"Bearer {key}"})
        if with_key == 200:
            return "ours"
        if with_key == -1:
            return "busy"
    return "needs_key"


def parent_pid(pid: int) -> int | None:
    r = subprocess.run(["ps", "-p", str(pid), "-o", "ppid="], capture_output=True, text=True)
    return int(r.stdout) if r.returncode == 0 and r.stdout.strip().isdigit() else None


def listener_pids() -> set[int]:
    """Pids that listen on the port of BASE (lsof sees the processes of this user)."""
    port = urllib.parse.urlparse(BASE).port
    r = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"], capture_output=True, text=True)
    return {int(line[1:]) for line in r.stdout.splitlines() if line[:1] == "p" and line[1:].isdigit()}


def port_owned_by(owner: int | None) -> bool:
    """True when the recorded server, or a child of it, is what listens on the port. Only then does the key go to it."""
    if owner is None:
        return False
    return any(pid == owner or parent_pid(pid) == owner for pid in listener_pids())


def process_start(pid: int) -> str | None:
    """The start time `ps` prints for a live process (a zombie counts as gone), else None. Together with the pid it identifies the process."""
    r = subprocess.run(["ps", "-p", str(pid), "-o", "stat=,lstart="], capture_output=True, text=True)
    fields = r.stdout.split(None, 1)
    if r.returncode != 0 or len(fields) != 2 or fields[0].startswith("Z"):
        return None
    return fields[1].strip()


def write_pid_record(pid: int) -> None:
    pid_file().write_text(f"{pid}\n{process_start(pid) or ''}\n")


def managed_pid() -> int | None:
    """The pid of the server this skill started, or None. It counts only while the process still has the start time recorded with it,
    so a pid the OS has reused for another program is never reported, and never signalled."""
    try:
        pid_text, _, start = pid_file().read_text().strip().partition("\n")
        pid = int(pid_text)
    except (OSError, ValueError):
        return None
    if pid <= 1 or not start.strip() or process_start(pid) != start.strip():
        return None
    return pid


def stop_pid(pid: int, force: bool = False, grace: float = 20.0) -> str | None:
    """SIGTERM the server this skill started and wait for it: "stopped", or "killed" after SIGKILL when `force`; None when it is still running after `grace` seconds."""
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        time.sleep(0.2)
        if managed_pid() is None:
            pid_file().unlink(missing_ok=True)
            return "stopped"
    if not force:
        return None
    if managed_pid() == pid:  # a shutdown can hang while the process still holds its wired Metal memory
        os.kill(pid, signal.SIGKILL)
    pid_file().unlink(missing_ok=True)
    return "killed"


def stop_started(proc: subprocess.Popen) -> None:
    """Take down the server this run spawned, after the run failed, so no daemon is left behind."""
    if managed_pid() == proc.pid:
        stop_pid(proc.pid, force=True, grace=10)
        print(f"the server this run started (pid {proc.pid}) was stopped again", file=sys.stderr)
    pid_file().unlink(missing_ok=True)


def spawn_server(glob: dict) -> subprocess.Popen:
    OMLX_HOME.mkdir(parents=True, exist_ok=True)
    log_file().parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(cli_path()), "serve", "--model-dir", str(models_dir()), "--memory-guard", glob["memory_guard_tier"],
           "--max-concurrent-requests", str(glob["max_concurrent_requests"]), "--hot-cache-max-size", glob["hot_cache_max_size"],
           "--paged-ssd-cache-dir", str(Path(glob["ssd_cache_dir"]).expanduser()), "--paged-ssd-cache-max-size", glob["ssd_cache_max_size"]]
    with open(log_file(), "ab") as log:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                                env={**os.environ, "OMLX_API_KEY": key_value()})
    write_pid_record(proc.pid)
    return proc


def wait_ready(proc: subprocess.Popen, timeout: float = 120) -> None:
    """Wait until the server we spawned accepts our key; stop waiting as soon as it has exited."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            sys.exit(f"the server exited with code {proc.returncode} before it accepted the key; see {log_file()}")
        if server_state() == "ours":
            return
        time.sleep(1)
    sys.exit(f"the server did not accept this skill's key within {timeout:.0f}s; see {log_file()}")


def installed_version() -> str | None:
    if not cli_path().exists():
        return None
    try:
        out = subprocess.run([str(cli_path()), "--version"], capture_output=True, text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.splitlines()[-1] if out else None


# --- commands -----------------------------------------------------------------------------------

def cmd_status(args) -> None:
    state = load_state()
    repo = args.model or state.get("default_model") or DEFAULT_MODEL
    d = models_dir() / repo.split("/")[-1]
    hw = pc.detect_hardware(argparse.Namespace(chip=None, ram_gb=None, metal_limit_gb=None))
    clash = source_conflict(d, repo)
    print(json.dumps({
        "installed": APP.exists(),
        "version": installed_version(),
        "server": server_state(),
        "managed_pid": managed_pid(),
        "key_file": str(key_file()),
        "key_exists": key_file().exists(),
        "hardware": {"chip": hw["chip"], "ram_gib": round(hw["ram_bytes"] / pc.GIB, 1), "macos": hw["macos"],
                     "disk_free_gib": round(hw["disk_free_bytes"] / pc.GIB, 1)},
        "model": {"repo": repo, "dir": str(d), "downloaded": model_complete(d) and not clash, "conflict": clash},
        "default_model": state.get("default_model") or DEFAULT_MODEL,
        "remembered_models": state["models"],
        "notes": state["notes"],
    }, indent=2))


def gatekeeper_verdict(app: Path) -> tuple[bool, str]:
    gate = subprocess.run(["spctl", "-a", "-vv", str(app)], capture_output=True, text=True)
    verdict = (gate.stdout + gate.stderr).strip()
    return gate.returncode == 0 and "accepted" in verdict and "Notarized Developer ID" in verdict, verdict


def replace_app(staged: Path, app: Path) -> None:
    """Move `staged` (same volume as `app`) into place. The old app is kept aside until the new one is in; if the move fails the old one comes back."""
    backup = app.with_name(app.name + ".old")
    if backup.exists():
        shutil.rmtree(backup)
    had_old = app.exists()
    if had_old:
        app.rename(backup)
    try:
        staged.rename(app)
    except BaseException:
        if had_old:
            backup.rename(app)
        raise
    if had_old:
        shutil.rmtree(backup, ignore_errors=True)


def cmd_install(args) -> None:
    if APP.exists() and not args.force:
        print(f"already installed: oMLX {installed_version()} at {APP}")
        return
    if platform.machine() != "arm64":
        sys.exit("oMLX needs Apple Silicon")
    major = int(platform.mac_ver()[0].split(".")[0])
    if major < 15:
        sys.exit("oMLX needs macOS 15 or newer")
    if shutil.disk_usage(Path.home()).free < 4 * 1024**3:
        sys.exit("less than 4 GiB free; the installer needs about 3 GiB")
    if APP.exists() and managed_pid() is not None:
        sys.exit("the server this skill started runs from the installed app; run: omlx_ctl.py stop")
    pick = pick_dmg(json.load(urllib.request.urlopen(RELEASES, timeout=30)), major)
    if not pick or not pick[3]:
        sys.exit("no stable release with a published sha256 found; not installing an unverified download")
    tag, name, url, want = pick
    tmp = Path(tempfile.mkdtemp(prefix="omlx-install-"))
    mnt = tmp / "mnt"
    staged = APP.with_name(APP.name + ".new")
    try:
        print(f"downloading {name} ({tag}) ...", flush=True)
        h = hashlib.sha256()
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "omlx-skill"}), timeout=60) as r, open(tmp / name, "wb") as f:
            for chunk in iter(lambda: r.read(1 << 20), b""):
                f.write(chunk)
                h.update(chunk)
        if h.hexdigest() != want:
            sys.exit("sha256 of the download does not match the one GitHub publishes; nothing installed")
        mnt.mkdir()
        subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mnt), str(tmp / name)], check=True, capture_output=True)
        try:
            if not (mnt / "oMLX.app").is_dir():
                sys.exit("oMLX.app not found in the disk image")
            shutil.rmtree(staged, ignore_errors=True)
            subprocess.run(["cp", "-R", str(mnt / "oMLX.app"), str(staged)], check=True)
        finally:
            if subprocess.run(["hdiutil", "detach", str(mnt), "-quiet"]).returncode != 0:
                subprocess.run(["hdiutil", "detach", str(mnt), "-force", "-quiet"])
            if os.path.ismount(mnt):
                print(f"warning: the disk image is still mounted at {mnt}", file=sys.stderr)
        ok, verdict = gatekeeper_verdict(staged)
        if not ok:
            sys.exit(f"Gatekeeper did not accept the new app; nothing was installed and any existing app is untouched:\n{verdict}")
        replace_app(staged, APP)
    finally:
        shutil.rmtree(staged, ignore_errors=True)  # nothing left after a successful move
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"installed oMLX {installed_version()} at {APP} (sha256 matches GitHub, notarized by Apple)")


def chat_once(key: str, model: str, system_prompt: str | None, prompt: str, max_tokens: int) -> tuple[str, float, int]:
    messages = ([{"role": "system", "content": system_prompt}] if system_prompt else []) + [{"role": "user", "content": prompt}]
    req = urllib.request.Request(BASE + "/v1/chat/completions", method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
                                 data=json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens}).encode())
    t = time.monotonic()
    d = json.load(urllib.request.urlopen(req, timeout=600))
    msg = d["choices"][0]["message"]  # a thinking model may spend all the tokens on reasoning and leave content empty
    return (msg.get("content") or msg.get("reasoning_content") or "").strip(), time.monotonic() - t, d["usage"]["completion_tokens"]


def cmd_start(args) -> None:
    if not APP.exists():
        sys.exit("oMLX is not installed; run: omlx_ctl.py install")
    repo = args.model
    name = repo.split("/")[-1]
    mdir = models_dir() / name
    if not model_complete(mdir):
        sys.exit(f"{mdir} is missing or incomplete; run: fetch_model.py {repo}")
    if clash := source_conflict(mdir, repo):
        sys.exit(clash)
    state = load_state()
    prior = state["models"].get(repo, {})
    context = args.context or prior.get("context") or 32768

    hw = pc.detect_hardware(argparse.Namespace(chip=None, ram_gb=None, metal_limit_gb=None))
    config, gen, tensors, _ = pc.load_model(str(mdir))
    m = pc.analyze(config, tensors)
    tier = args.tier or prior.get("tier") or "balanced"
    asked = tier
    p = pc.plan(hw, m, tier, context)
    if p["mode"] in ("too_big", "too_big_even_offloaded") and tier != "aggressive":
        tier, p = "aggressive", pc.plan(hw, m, "aggressive", context)
        print(f"note: the {asked} memory guard leaves too little room for this model; planning with aggressive", flush=True)
    out = pc.propose(hw, m, p, gen, name, tier, context)
    if p["mode"] in ("too_big", "too_big_even_offloaded"):
        sys.exit("; ".join(out["warnings"]) or "the model does not fit this Mac")
    offload = p["mode"] == "offload"
    if args.fraction and not offload:
        print("note: --fraction is ignored, this model fits fully resident", flush=True)
    fraction = args.fraction or (prior.get("fraction") if offload else None) or p["fraction"]
    floor = max(0.05, m["top_k"] / m["num_experts"]) if offload else 1
    lower = [x for x in pc.LADDER if floor <= x < fraction][:2] if offload else []
    print(f"plan: {p['mode']}" + (f" at {fraction:.1%} resident" if offload else "") + f", memory guard {tier}, context {context}", flush=True)

    with file_lock("skill-server"):  # one start or stop at a time
        ensure_key()
        st = server_state()
        refusal = {
            "needs_key": f"something on {BASE} asks for a key but is not the server this skill started (or rejects its key, {key_file()}); stop that server first (lsof -nP -iTCP:8000)",
            "open": f"something on {BASE} answers without any key, so it is not this skill's server; stop it first (lsof -nP -iTCP:8000)",
            "busy": f"something holds port 8000 but did not answer in time (a server may still be loading); wait and run start again, or check lsof -nP -iTCP:8000",
        }.get(st)
        if refusal:
            sys.exit(refusal)
        spawned = None
        try:
            if st == "down":
                spawned = spawn_server(out["global_settings"] | {"memory_guard_tier": tier})
                print(f"server started (pid {spawned.pid}, log {log_file()})", flush=True)
                wait_ready(spawned)
            else:
                print("server already running with this skill's key; reusing it", flush=True)

            key = key_value()
            api = sw.Api(BASE, key)
            if spawned is None:  # a new server got these as flags; a running one gets them through the API
                glob = {k: v for k, v in out["global_settings"].items() if k != "memory_guard_tier"}
                glob["ssd_cache_dir"] = str(Path(glob["ssd_cache_dir"]).expanduser())
                live = api.call("POST", "/admin/api/global-settings", glob).get("runtime_applied") or []
                print(f"concurrency and cache settings of the plan sent to the running server; applied now: {', '.join(live) or 'none'}; "
                      "the others are saved and take effect when the server is next started", flush=True)
            entry = sw.find_model(api, name)
            if offload and not entry.get("moe_expert_offload_supported"):
                sys.exit("oMLX reports expert offload is not supported for this model; see reference/memory-and-offload.md")
            current = entry.get("settings") or {}
            before = sw.fetch_logs(api)

            last = ""
            for t, f in build_attempts(tier, fraction if offload else None, lower):
                api.call("POST", "/admin/api/global-settings", {"memory_guard_tier": t})
                settings = dict(out["model_settings"]) | exclusive_resets(current, offload)
                if f:
                    settings["moe_expert_offload_resident_fraction"] = f
                api.call("PUT", f"/admin/api/models/{name}/settings", settings)
                try:
                    api.call("POST", f"/admin/api/models/{name}/load")
                except SystemExit as e:
                    if CEILING_MSG not in str(e) and "HTTP 507" not in str(e):
                        raise
                    last = str(e)
                    print(f"  refused at guard {t}" + (f", {f:.1%} resident" if f else "") + ": not enough reclaimable RAM", flush=True)
                    continue
                tier, fraction = t, f
                break
            else:
                sys.exit("the load was refused every time for lack of reclaimable RAM: other apps hold it. Close large apps "
                         f"(browsers, editors) and run start again; nothing was closed here.\nlast answer: {last}")

            all_logs = sw.fetch_logs(api)
            logs = sw.new_log_text(before, all_logs)  # only lines this load wrote; an old 'wrapped' line proves nothing about it
            wrapped = OFFLOAD_LOG.findall(logs)
            loaded = LOADED_LOG.findall(logs)
            if offload and not wrapped:
                now = sw.find_model(api, name).get("settings") or {}
                same = now.get("moe_expert_offload_enabled") and abs(float(now.get("moe_expert_offload_resident_fraction") or 0) - fraction) < 1e-9
                if not (same and OFFLOAD_LOG.findall(all_logs)):
                    sys.exit("the model loaded but this load wrote no 'moe expert offload: wrapped' line to the log, so offload is NOT applied; check the log")
                wrapped = OFFLOAD_LOG.findall(all_logs)  # already loaded with these settings: the earlier line is the one that applies
                print("note: this load wrote no new offload line (the model was already loaded with these settings); showing the last one", flush=True)
            speeds, reply = [], ""
            for _ in range(MEASURE_RUNS):  # the first request after a fresh start can be slower, so only the last one counts
                reply, secs, n = chat_once(key, name, args.system_prompt, MEASURE_PROMPT, 64)
                speeds.append(round(n / secs, 1) if n >= MIN_MEASURED_TOKENS and secs else None)
        except BaseException:
            if spawned is not None:
                stop_started(spawned)
            raise
    tps = speeds[-1]

    def remember_run(st: dict) -> None:
        entry = st["models"].setdefault(repo, {})
        entry.update({"fraction": fraction, "tier": tier, "context": context, "tok_s": tps if tps is not None else entry.get("tok_s"),
                      "loaded_gb": float(loaded[-1]) if loaded else entry.get("loaded_gb"), "mode": p["mode"],
                      "hardware": f"{hw['chip']} {hw['ram_bytes'] / pc.GIB:.0f} GB", "date": date.today().isoformat()})
        st["default_model"] = repo
    update_state(remember_run)

    print("\nREADY")
    if wrapped:
        layers, pct, total, resident = wrapped[-1]
        print(f"offload: {layers} layers at {pct}% resident ({resident} of {total} GB of expert tables)")
    if loaded:
        print(f"memory: model loaded as {loaded[-1]} GB, guard {tier}")
    print(f"speed: {speeds} tok/s over {MEASURE_RUNS} runs of one 64-token answer, prefill included (short answers read lower than long ones; the first request after a fresh server start can be slower); the last one is remembered")
    print(f"reply: {reply[:80]!r}")
    print(f"chat:      {BASE}/admin/chat   (log in with the key; the page has a System Prompt field)")
    print(f"api:       {BASE}/v1   model id: {name}")
    print(f"key file:  file://{key_file()}   (copy it with: pbcopy < {key_file()})")
    print(f"stop:      omlx_ctl.py stop     log: {log_file()}")


def cmd_stop(args) -> None:
    with file_lock("skill-server"):
        pid = managed_pid()
        if pid is None:
            pid_file().unlink(missing_ok=True)
            if server_state() != "down":
                sys.exit("a server answers on port 8000 but this skill did not start it; stop it yourself (lsof -nP -iTCP:8000)")
            print("no server running")
            return
        result = stop_pid(pid, force=args.force)
        if result is None:
            sys.exit(f"pid {pid} did not exit within 20s; run stop --force to kill it")
        print(f"{result} (pid {pid})")


def cmd_remember(args) -> None:
    def add(state: dict) -> None:
        target = state["models"].setdefault(args.model, {}) if args.model else state
        target.setdefault("notes", []).append(f"{date.today().isoformat()}: {args.note}")
    update_state(add)
    print("remembered")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("status")
    s.add_argument("--model")
    s.set_defaults(fn=cmd_status)
    s = sub.add_parser("install")
    s.add_argument("--force", action="store_true", help="replace an existing /Applications/oMLX.app (the new copy is verified before the old one is moved aside)")
    s.set_defaults(fn=cmd_install)
    s = sub.add_parser("start")
    s.add_argument("--model", required=True, help="owner/repo; the directory under ~/.omlx/models is the repo name")
    s.add_argument("--tier", choices=sorted(pc.TIER_RESERVE))
    s.add_argument("--fraction", type=float, help="resident expert fraction, default: remembered, else the proposal (ignored when the model fits resident)")
    s.add_argument("--context", type=int, help="context window in tokens, default: remembered, else 32768")
    s.add_argument("--system-prompt", help="the model card's required system prompt, used for the test chat")
    s.set_defaults(fn=cmd_start)
    s = sub.add_parser("stop")
    s.add_argument("--force", action="store_true", help="SIGKILL when the server does not exit within 20 s")
    s.set_defaults(fn=cmd_stop)
    s = sub.add_parser("remember")
    s.add_argument("--note", required=True)
    s.add_argument("--model")
    s.set_defaults(fn=cmd_remember)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
