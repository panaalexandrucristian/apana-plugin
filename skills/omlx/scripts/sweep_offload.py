#!/usr/bin/env python3
"""Measure which MoE expert-offload resident fraction is fastest for one model on a running oMLX server.

For every fraction it sets the model's offload settings through the admin API, reloads the model,
sends one warm-up request and then measured streaming requests, and prints time to first token,
decode tokens/s and the expert-cache hit rate from the server log. At the end it restores the
original settings, or leaves the best fraction in place with --apply-best.

    python3 -I sweep_offload.py --model-id <dir-name> --fractions 0.25,0.375,0.1875 [--apply-best]

The API key is read from $OMLX_API_KEY, else from ~/.omlx/api_key. There is no --api-key flag: a flag shows up in `ps`.
Only the two offload fields are changed.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PROMPT = (
    "Explain, in about 150 words, how a mixture-of-experts language model routes each token "
    "to a few experts and why that makes inference cheaper than a dense model of the same size."
)
HIT_RE = re.compile(r"MoE offload: request=\S+ hit_rate=([0-9.]+)")


class Api:
    def __init__(self, base: str, key: str | None):
        self.base = base.rstrip("/")
        self.key = key
        self.headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def login(self) -> None:
        # oMLX 0.7.0 answers 401 to a Bearer key on /admin/api/*; the key is accepted by POST /admin/api/login (session cookie)
        req = urllib.request.Request(
            self.base + "/admin/api/login", method="POST", headers={"Content-Type": "application/json"},
            data=json.dumps({"api_key": self.key, "remember": False}).encode(),
        )
        try:
            self.opener.open(req, timeout=30).read()
        except urllib.error.HTTPError as e:
            raise SystemExit(f"admin login -> HTTP {e.code}: wrong or missing API key (set $OMLX_API_KEY)")

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 900):
        for attempt in (0, 1):
            req = urllib.request.Request(
                self.base + path, method=method, headers=self.headers,
                data=None if body is None else json.dumps(body).encode(),
            )
            try:
                with self.opener.open(req, timeout=timeout) as r:
                    return json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0 and self.key and path.startswith("/admin/"):
                    self.login()
                    continue
                raise SystemExit(f"{method} {path} -> HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")

    def stream_chat(self, model: str, prompt: str, max_tokens: int, timeout: float = 900) -> dict:
        body = {
            "model": model, "stream": True, "max_tokens": max_tokens, "temperature": 0,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": prompt}],
        }
        req = urllib.request.Request(self.base + "/v1/chat/completions", method="POST", headers=self.headers, data=json.dumps(body).encode())
        start = time.monotonic()
        first = None
        chunks = 0
        tokens = None
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode(errors="replace").strip()
                if not line.startswith("data:") or line.endswith("[DONE]"):
                    continue
                event = json.loads(line[5:])
                if event.get("usage"):
                    tokens = event["usage"].get("completion_tokens")
                for choice in event.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if any(delta.get(k) for k in ("content", "reasoning_content", "reasoning")):
                        chunks += 1
                        first = first or time.monotonic()
        end = time.monotonic()
        if first is None:
            raise SystemExit("the model returned no tokens")
        n = tokens or chunks
        return {"ttft_s": first - start, "tokens": n, "decode_tps": (n - 1) / (end - first) if n > 1 and end > first else 0.0}


def find_model(api: Api, model_id: str) -> dict:
    models = api.call("GET", "/admin/api/models")
    entries = models.get("models", models) if isinstance(models, dict) else models
    for e in entries:
        if e.get("id") == model_id:
            return e
    ids = ", ".join(str(e.get("id")) for e in entries)
    raise SystemExit(f"model {model_id!r} not found; available: {ids}")


def load_and_wait(api: Api, model_id: str, timeout: float = 900) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        entry = find_model(api, model_id)
        if entry.get("loaded"):
            return
        if entry.get("is_loading"):
            time.sleep(2)
            continue
        try:
            api.call("POST", f"/admin/api/models/{model_id}/load")  # returns once the engine is loaded
        except SystemExit as e:
            if "409" not in str(e):  # 409 = another request is already loading it
                raise
            time.sleep(2)
    raise SystemExit("timed out waiting for the model to load")


def load_key() -> str | None:
    key = os.environ.get("OMLX_API_KEY", "").strip()
    if key:
        return key
    try:
        return (Path.home() / ".omlx" / "api_key").read_text().strip() or None
    except OSError:
        return None


def fetch_logs(api: Api) -> str:
    return api.call("GET", "/admin/api/logs?lines=400").get("logs", "")


def new_log_text(before: str, after: str) -> str:
    """The lines of `after` that `before` did not have. Server log lines start with a timestamp, so a line seen before is old."""
    seen = set(before.splitlines())
    return "\n".join(line for line in after.splitlines() if line not in seen)


def last_hit_rate(api: Api, before: str) -> float | None:
    """The newest hit rate the server logged after the `before` snapshot of the log."""
    hits = HIT_RE.findall(new_log_text(before, fetch_logs(api)))
    return float(hits[-1]) if hits else None


def set_offload(api: Api, model_id: str, enabled: bool, fraction: float) -> None:
    api.call("PUT", f"/admin/api/models/{model_id}/settings",
             {"moe_expert_offload_enabled": enabled, "moe_expert_offload_resident_fraction": fraction})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-id", required=True, help="model id as listed by GET /admin/api/models (the directory name)")
    ap.add_argument("--fractions", default="0.25", help="comma-separated resident fractions, e.g. 0.375,0.25,0.1875")
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--prompt-file", help="file with a realistic prompt (a long coding prompt shows the TTFT cost)")
    ap.add_argument("--max-tokens", type=int, default=128)
    ap.add_argument("--runs", type=int, default=2, help="measured runs per fraction, after one warm-up")
    ap.add_argument("--objective", choices=("decode", "ttft"), default="decode")
    ap.add_argument("--apply-best", action="store_true", help="leave the best fraction set instead of restoring the original settings")
    args = ap.parse_args()

    fractions = [float(x) for x in args.fractions.split(",") if x.strip()]
    if not fractions or any(not 0 < f <= 1 for f in fractions):
        sys.exit("--fractions must be numbers in (0, 1]")
    prompt = open(args.prompt_file).read() if args.prompt_file else DEFAULT_PROMPT
    api = Api(args.base_url, load_key())

    entry = find_model(api, args.model_id)
    if not entry.get("moe_expert_offload_supported"):
        sys.exit("oMLX reports expert offload is not supported for this model (see reference/memory-and-offload.md)")
    current = entry.get("settings") or {}
    if current.get("mtp_enabled"):
        sys.exit("mtp_enabled is on for this model, and expert offload refuses it for most families: switch it off first (admin chat page, or PUT the model settings), then sweep")
    original = (bool(current.get("moe_expert_offload_enabled", False)), float(current.get("moe_expert_offload_resident_fraction", 0.25)))

    rows = []
    settled = False
    try:
        for f in fractions:
            print(f"fraction {f:.4f}: reloading ...", flush=True)
            set_offload(api, args.model_id, True, f)
            load_and_wait(api, args.model_id)
            api.stream_chat(args.model_id, prompt, args.max_tokens)  # warm-up fills the expert cache
            before = fetch_logs(api)
            runs = [api.stream_chat(args.model_id, prompt, args.max_tokens) for _ in range(args.runs)]
            row = {
                "fraction": f,
                "ttft_s": statistics.median(r["ttft_s"] for r in runs),
                "decode_tps": statistics.median(r["decode_tps"] for r in runs),
                "hit_rate": last_hit_rate(api, before),
            }
            rows.append(row)
            print(f"  ttft {row['ttft_s']:.2f}s  decode {row['decode_tps']:.2f} tok/s  hit rate {row['hit_rate']}", flush=True)
    finally:
        best = None
        if rows:
            best = max(rows, key=lambda r: r["decode_tps"]) if args.objective == "decode" else min(rows, key=lambda r: r["ttft_s"])
        try:
            if args.apply_best and best:
                set_offload(api, args.model_id, True, best["fraction"])
            else:
                set_offload(api, args.model_id, *original)
            settled = True
        except (Exception, SystemExit) as e:  # do not hide the error that ended the sweep
            print(f"warning: could not set the final offload settings ({e}); the model keeps the last swept fraction. Original: enabled={original[0]}, fraction={original[1]}", file=sys.stderr)

    print("\nfraction  ttft_s  decode_tok/s  hit_rate")
    for r in rows:
        mark = "  <- best" if r is best else ""
        hit = "n/a" if r["hit_rate"] is None else f"{r['hit_rate']:.2f}"
        print(f"{r['fraction']:<8.4f}  {r['ttft_s']:<6.2f}  {r['decode_tps']:<12.2f}  {hit}{mark}")
    print("\n" + ("The final offload settings could not be set; see the warning above." if not settled else
                  f"Left fraction {best['fraction']} applied." if args.apply_best and best else "Original settings restored."))


if __name__ == "__main__":
    main()
