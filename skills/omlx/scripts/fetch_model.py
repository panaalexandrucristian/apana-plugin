#!/usr/bin/env python3
"""Download a Hugging Face model into an oMLX model directory and verify every file.

The repo is pinned to the commit it has when the script starts and files are fetched with a resumable curl.
Every LFS file is checked against the sha256 Hugging Face publishes; every other file against its git blob id
(the sha1 Hugging Face publishes as `blobId`). Re-running resumes and re-verifies.

    python3 -I fetch_model.py <owner/repo> [--dest ~/.omlx/models] [--revision main]

Only public, ungated repos are fetched, with no token. Writes <dest>/<repo name>/ and nothing else.
The folder is named after the repo name only, so it records the repo in `.omlx-source.json`
and refuses to fill a folder that another repo owns.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

SOURCE_FILE = ".omlx-source.json"


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_id(path: str) -> str:
    """Git's object id of the file's content: sha1 over "blob <size>\\0" and the bytes."""
    h = hashlib.sha1(b"blob %d\0" % os.path.getsize(path), usedforsecurity=False)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(path: str, size: int, sha256: str | None, blob_id: str | None = None) -> bool:
    """True when the file has the published size and the published digest: the sha256 for an LFS file, else the git blob id.
    With neither digest only the size is checked."""
    if not (os.path.isfile(path) and os.path.getsize(path) == size):
        return False
    if sha256:
        return sha256_of(path) == sha256
    if blob_id:
        return git_blob_id(path) == blob_id
    return True


def read_source(out: str) -> dict:
    try:
        d = json.load(open(os.path.join(out, SOURCE_FILE)))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write_source(out: str, data: dict) -> None:
    tmp = os.path.join(out, SOURCE_FILE + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, os.path.join(out, SOURCE_FILE))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("repo", help="owner/name on huggingface.co")
    ap.add_argument("--dest", default="~/.omlx/models", help="oMLX model directory (default ~/.omlx/models)")
    ap.add_argument("--revision", default="main")
    args = ap.parse_args()

    try:
        info = json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{args.repo}/revision/{args.revision}?blobs=true", timeout=30))
    except urllib.error.HTTPError as e:
        sys.exit(f"cannot read {args.repo}: HTTP {e.code} (private, gated or misspelled?)")
    if info.get("gated") or info.get("private"):
        sys.exit(f"{args.repo} is gated or private; this script does not use tokens")

    files = [s for s in info["siblings"] if s["rfilename"] != ".gitattributes"]
    out = os.path.realpath(os.path.join(os.path.expanduser(args.dest), args.repo.split("/")[-1]))
    for s in files:  # a name from the server must stay inside the model folder
        if os.path.commonpath([out, os.path.realpath(os.path.join(out, s["rfilename"]))]) != out:
            sys.exit(f"refusing {s['rfilename']!r}: it points outside {out}")
    os.makedirs(out, exist_ok=True)
    owner = read_source(out).get("repo")
    if owner and owner != args.repo:
        sys.exit(f"{out} was downloaded from {owner}, not {args.repo}, and both have the same folder name; move one of them or use another --dest")
    write_source(out, {"repo": args.repo, "sha": info["sha"], "complete": False})
    total = sum(s["size"] for s in files)
    have = sum(os.path.getsize(os.path.join(out, s["rfilename"])) for s in files if os.path.exists(os.path.join(out, s["rfilename"])))
    free = shutil.disk_usage(out).free
    if total - have + 2 * 1024**3 > free:
        sys.exit(f"needs {(total - have) / 2**30:.1f} GiB more plus 2 GiB spare, only {free / 2**30:.1f} GiB free")
    print(f"{args.repo} @ {info['sha'][:12]}: {len(files)} files, {total / 2**30:.1f} GiB -> {out}", flush=True)

    bad = 0
    for s in files:
        name = s["rfilename"]
        path = os.path.join(out, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        lfs = s.get("lfs")
        want = (lfs or {}).get("sha256")
        blob = None if lfs else s.get("blobId")
        if not verify(path, s["size"], want, blob):
            if os.path.exists(path) and os.path.getsize(path) >= s["size"]:
                os.remove(path)  # complete but wrong: resuming it would only fail with 416
            subprocess.run(["curl", "-fL", "--retry", "5", "-C", "-", "-s", "-o", path,
                            f"https://huggingface.co/{args.repo}/resolve/{info['sha']}/{name}"])
        ok = verify(path, s["size"], want, blob)
        bad += not ok
        how = "sha256" if want else "blob id" if blob else "size only"
        print(("OK  " if ok else "BAD ") + f"{name} ({how})", flush=True)
    known = {s["rfilename"] for s in files}
    for extra in sorted(f for f in os.listdir(out) if f.endswith(".safetensors") and f not in known):
        bad += 1  # mlx loads every *.safetensors in the folder, so a leftover shard from another revision corrupts the model
        print(f"STALE {extra} is not part of this revision; delete it by hand (every *.safetensors in the folder gets loaded)", flush=True)
    write_source(out, {"repo": args.repo, "sha": info["sha"], "complete": not bad})
    print(f"DONE bad={bad}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
