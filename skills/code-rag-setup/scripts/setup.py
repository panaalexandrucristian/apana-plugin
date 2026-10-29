#!/usr/bin/env python3
"""Install or check the environment of the code-rag skill.

  setup.py check   [--json]            report what is installed; changes nothing
  setup.py install [--skip-model] [--dry-run]

The environment is one Python 3.12 venv under $CODE_RAG_HOME (default ~/.cache/code-rag) plus the
Qwen3-Embedding-0.6B weights in the Hugging Face cache. It touches no settings file, no hook and no
shell profile.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PYTHON_VERSION = "3.12"
MODEL = "Qwen/Qwen3-Embedding-0.6B"
REQUIREMENTS = Path(__file__).resolve().parent / "requirements.txt"
EXIT_NO_UV = 3

SMOKE = r"""
import json, sys
import numpy as np, bm25s, torch
from llama_index.core.node_parser import CodeSplitter
from sentence_transformers import SentenceTransformer
CodeSplitter(language="kotlin").split_text("fun a() { return 1 }\n")
if len(sys.argv) < 2:
    print(json.dumps({"imports": "ok"})); sys.exit(0)
device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
m = SentenceTransformer(sys.argv[1], device=device, tokenizer_kwargs={"padding_side": "left"})
v = m.encode(["fun total(items: List<Item>): Int", "sum the prices"], normalize_embeddings=True)
print(json.dumps({"device": device, "dim": int(v.shape[1]), "norm": round(float(np.linalg.norm(v[0])), 3)}))
"""


def code_rag_home():
    return Path(os.environ.get("CODE_RAG_HOME") or Path.home() / ".cache" / "code-rag")


def venv_python(home):
    return home / "venv" / "bin" / "python"


def find_uv():
    return shutil.which("uv") or next((str(p) for p in [Path.home() / ".local/bin/uv"] if p.exists()), None)


def read_pins(path=REQUIREMENTS):
    pins = {}
    for line in path.read_text().splitlines():
        line = line.split("#")[0].strip()
        if "==" in line:
            name, version = line.split("==", 1)
            pins[name.strip().lower().replace("_", "-")] = version.strip()
    return pins


def hf_cache():
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    return Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"


def model_cached(model=MODEL):
    snaps = hf_cache() / ("models--" + model.replace("/", "--")) / "snapshots"
    if not snaps.is_dir():
        return False
    return any((s / "config.json").exists() and any(s.glob("*.safetensors")) for s in snaps.iterdir())


def installed_versions(python):
    code = ("import importlib.metadata as m, json, sys\nout = {}\n"
            "for n in sys.argv[1:]:\n    try: out[n] = m.version(n)\n    except Exception: pass\n"
            "print(json.dumps(out))")
    try:
        done = subprocess.run([str(python), "-I", "-c", code, *read_pins()], capture_output=True, text=True,
                              timeout=60, check=True)
        return {k.lower().replace("_", "-"): v for k, v in json.loads(done.stdout).items()}
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def check(home=None):
    home = home or code_rag_home()
    python = venv_python(home)
    pins = read_pins()
    report = {"home": str(home), "uv": find_uv(), "venv": python.exists(), "model": MODEL,
              "model_cached": model_cached(), "missing": [], "wrong": []}
    versions = installed_versions(python) if python.exists() else None
    if versions is not None:
        for name, want in pins.items():
            have = versions.get(name)
            if have is None:
                report["missing"].append(name)
            elif have != want:
                report["wrong"].append({"package": name, "want": want, "have": have})
    report["ready"] = bool(versions is not None and not report["missing"] and not report["wrong"]
                           and report["model_cached"])
    return report


def plan(home, uv, skip_model):
    python = venv_python(home)
    steps = [[uv, "venv", "--python", PYTHON_VERSION, str(home / "venv")],
             [uv, "pip", "install", "--python", str(python), "-r", str(REQUIREMENTS)]]
    if not skip_model:
        steps.append([str(python), "-I", "-c",
                      f"from huggingface_hub import snapshot_download; print(snapshot_download({MODEL!r}))"])
    steps.append([str(python), "-I", "-c", SMOKE] + ([] if skip_model else [MODEL]))
    return steps


def install(skip_model=False, dry_run=False):
    home = code_rag_home()
    uv = find_uv()
    if not uv:
        print(json.dumps({"error": "uv_missing", "hint": "install uv first (brew install uv), then run again"}))
        return EXIT_NO_UV
    steps = plan(home, uv, skip_model)
    if dry_run:
        for step in steps:
            print(" ".join(step[:6]) + (" ..." if len(step) > 6 else ""))
        return 0
    home.mkdir(parents=True, exist_ok=True)
    for step in steps:
        shown = " ".join(step[:5]) + (" ..." if len(step) > 5 else "")
        print(f"$ {shown}", flush=True)
        done = subprocess.run(step, capture_output=step is steps[-1], text=True)
        if done.returncode != 0:
            print((done.stderr or "")[-2000:], file=sys.stderr)
            print(json.dumps({"error": "step_failed", "step": shown, "code": done.returncode}))
            return 1
        if step is steps[-1]:
            smoke = json.loads(done.stdout.strip().splitlines()[-1])
    report = check(home)
    report["smoke"] = smoke
    (home / "installed.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    return 0 if report["ready"] or skip_model else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").add_argument("--json", action="store_true")
    ins = sub.add_parser("install")
    ins.add_argument("--skip-model", action="store_true")
    ins.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "check":
        print(json.dumps(check()))
        return 0
    return install(args.skip_model, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
