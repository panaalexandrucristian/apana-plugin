"""Offline tests for the omlx skill scripts.

    python3 -B -W ignore::ResourceWarning -m unittest discover -s skills/omlx/scripts -p 'test_*.py'
"""
import contextlib
import hashlib
import io
import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_model as fm  # noqa: E402
import omlx_ctl as ctl  # noqa: E402
import propose_config as pc  # noqa: E402
import sweep_offload as sw  # noqa: E402

GIB = pc.GIB


def argparse_ns(**kw):
    import argparse
    return argparse.Namespace(**kw)


def write_safetensors(path: Path, tensors: dict, truncate_to: int | None = None) -> None:
    """A safetensors file with a real header and a sparse data section: the file has the length the header declares, but no bytes are written for the tensors."""
    header, offset = {}, 0
    for name, nbytes in tensors.items():
        header[name] = {"dtype": "U32", "shape": [nbytes // 4], "data_offsets": [offset, offset + nbytes]}
        offset += nbytes
    blob = json.dumps(header).encode()
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(blob)) + blob)
        f.truncate(8 + len(blob) + offset if truncate_to is None else truncate_to)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def sleeper(*cmd):
    """A real child process to stand in for the server."""
    proc = subprocess.Popen(list(cmd) or ["sleep", "60"], start_new_session=True)
    try:
        yield proc
    finally:
        proc.kill()
        proc.wait()


def hardware(ram_gib=16, metal_gib=10.7, tier_free=100):
    return {
        "chip": "Apple M3", "ram_bytes": int(ram_gib * GIB), "macos": "15.5", "wired_limit_mb": 0,
        "metal_limit_bytes": int(metal_gib * GIB), "metal_limit_source": "given",
        "disk_free_bytes": tier_free * GIB, "xcode_metal_toolchain": True,
    }


def model(total_gib, expert_gib, **kw):
    m = {
        "model_type": "qwen3_5_moe", "num_experts": 256, "top_k": 8, "quant_bits": 4, "max_position": 262144,
        "total_bytes": int(total_gib * GIB), "expert_bytes": int(expert_gib * GIB), "mtp_bytes": 0, "vision_bytes": 0,
        "has_mtp_head": False,
        # the layer pattern of Qwen3.6-35B-A3B: every fourth of 40 layers keeps a growing KV cache
        "text_config": {"num_hidden_layers": 40, "layer_types": (["linear_attention"] * 3 + ["full_attention"]) * 10,
                        "num_key_value_heads": 2, "head_dim": 256},
    }
    m.update(kw)
    return m


class ProposeConfig(unittest.TestCase):
    def test_tier_reserve_matches_oMLX_clamps(self):
        self.assertEqual(pc.tier_reserve("balanced", 16 * GIB), 3 * GIB)  # 8% = 1.3 GiB, raised to the 3 GiB minimum
        self.assertEqual(pc.tier_reserve("safe", 16 * GIB), 6 * GIB)
        self.assertEqual(pc.tier_reserve("aggressive", 16 * GIB), int(1.5 * GIB))
        self.assertEqual(pc.tier_reserve("balanced", 128 * GIB), 8 * GIB)  # 8% = 10.2 GiB, capped at 8

    def test_tensor_classes(self):
        tensors = [
            ("language_model.model.layers.0.mlp.switch_mlp.gate_proj.weight", 100),
            ("language_model.model.layers.0.mlp.shared_expert.gate_proj.weight", 10),
            ("language_model.model.layers.0.mlp.gate.weight", 1),
            ("language_model.mtp.layers.0.mlp.switch_mlp.up_proj.weight", 7),
            ("visual.blocks.0.attn.qkv.weight", 5),
            ("model.layers.1.block_sparse_moe.experts.3.w1.weight", 50),
        ]
        m = pc.analyze({"model_type": "qwen3_5_moe", "text_config": {"num_experts": 4, "num_experts_per_tok": 2}, "quantization": {"bits": 4}}, tensors)
        self.assertEqual((m["expert_bytes"], m["mtp_bytes"], m["vision_bytes"]), (150, 7, 5))
        self.assertEqual(m["total_bytes"] - m["expert_bytes"], 10 + 1 + 7 + 5)  # shared expert, router, MTP head and vision stay resident
        self.assertTrue(m["has_mtp_head"])

    def test_kv_counts_only_growing_layers(self):
        tc = model(1, 1)["text_config"]
        self.assertEqual(pc.kv_bytes(tc, 32768), 2 * 2 * 256 * 2 * 10 * 32768)  # 10 of 40 layers are full attention

    def test_moe_larger_than_ram_offloads_at_a_fraction_that_fits(self):
        hw, m = hardware(), model(19.0, 16.9)
        p = pc.plan(hw, m, "balanced", 32768)
        self.assertEqual(p["mode"], "offload")
        self.assertEqual(p["fraction"], 0.25)
        self.assertLessEqual(p["resident_bytes"], p["budget_bytes"])
        self.assertIn(0.25, p["sweep_fractions"])

    def test_more_ram_means_larger_fraction_and_big_enough_ram_means_resident(self):
        small = pc.plan(hardware(16, 10.7), model(19, 16.9), "balanced", 32768)
        mid = pc.plan(hardware(32, 21.4), model(19, 16.9), "balanced", 32768)
        big = pc.plan(hardware(48, 32.0), model(19, 16.9), "balanced", 32768)
        self.assertEqual((small["mode"], mid["mode"], big["mode"]), ("offload", "offload", "resident"))
        self.assertGreater(mid["fraction"], small["fraction"])

    def test_dense_model_too_big_is_not_offloaded(self):
        p = pc.plan(hardware(), model(30, 0, num_experts=0, top_k=0), "balanced", 32768)
        self.assertEqual(p["mode"], "too_big")

    def test_unsupported_family_is_not_offloaded(self):
        p = pc.plan(hardware(), model(19, 16.9, model_type="mixtral"), "balanced", 32768)
        self.assertEqual(p["mode"], "too_big")

    def test_nothing_fits_even_at_smallest_fraction(self):
        p = pc.plan(hardware(8, 5.3), model(120, 118), "balanced", 32768)
        self.assertEqual(p["mode"], "too_big_even_offloaded")

    def test_mtp_never_proposed_with_offload_but_proposed_when_resident(self):
        args = (hardware(), {"temperature": 0.7}, "m", "balanced", 32768)
        m = model(19, 16.9, has_mtp_head=True)
        offload = pc.propose(args[0], m, pc.plan(args[0], m, "balanced", 32768), *args[1:])
        self.assertTrue(offload["model_settings"]["moe_expert_offload_enabled"])
        self.assertNotIn("mtp_enabled", offload["model_settings"])
        hw = hardware(64, 48)
        resident = pc.propose(hw, m, pc.plan(hw, m, "balanced", 32768), *args[1:])
        self.assertTrue(resident["model_settings"]["mtp_enabled"])
        self.assertNotIn("moe_expert_offload_enabled", resident["model_settings"])

    def test_the_report_has_no_command_that_would_carry_the_api_key(self):
        hw, m = hardware(), model(19.0, 16.9)
        p = pc.plan(hw, m, "balanced", 32768)
        out = pc.propose(hw, m, p, {}, "m", "balanced", 32768)
        text = pc.report(hw, m, p, out, "m", "balanced", 32768) + json.dumps(out)
        for forbidden in ("curl", "Bearer", "OMLX_API_KEY", "--api-key"):
            self.assertNotIn(forbidden, text)

    def test_local_directory_is_read_from_headers_only(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "config.json").write_text(json.dumps({
                "model_type": "qwen3_5_moe", "quantization": {"bits": 4},
                "text_config": {"num_experts": 8, "num_experts_per_tok": 2, "num_hidden_layers": 4},
            }))
            write_safetensors(d / "model-00001-of-00002.safetensors", {"model.layers.0.mlp.switch_mlp.up_proj.weight": 4000})
            write_safetensors(d / "model-00002-of-00002.safetensors", {"model.embed_tokens.weight": 1000})
            config, gen, tensors, name = pc.load_model(str(d))
            m = pc.analyze(config, tensors)
            self.assertEqual((m["expert_bytes"], m["total_bytes"], gen), (4000, 5000, {}))

    def test_bad_model_argument_exits(self):
        with self.assertRaises(SystemExit):
            pc.load_model("/definitely/not/a/dir/or/repo id")

    def test_remote_files_are_read_at_the_commit_the_listing_returned(self):
        urls = []

        def fake_get(url, rng=None, limit=1 << 20):
            urls.append(url)
            if url.endswith("/api/models/o/r"):
                return json.dumps({"sha": "abc123", "siblings": [{"rfilename": "model.safetensors"}]}).encode()
            if url.endswith("config.json"):
                return b"{}"
            if url.endswith("generation_config.json"):
                return b"{}"
            header = json.dumps({"w": {"dtype": "U32", "shape": [1], "data_offsets": [0, 4]}}).encode()
            return struct.pack("<Q", len(header)) + header
        with mock.patch.object(pc, "http_get", fake_get):
            pc.load_model("o/r")
        reads = [u for u in urls if "/resolve/" in u]
        self.assertEqual(len(reads), 3)
        self.assertTrue(all("/resolve/abc123/" in u for u in reads), reads)


class FetchModel(unittest.TestCase):
    def test_digests_match_independent_vectors(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "f"
            p.write_bytes(b"abc")
            self.assertEqual(fm.sha256_of(str(p)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")  # FIPS 180-2 test vector
            self.assertEqual(fm.git_blob_id(str(p)), "f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f")  # printf abc | git hash-object --stdin

    def test_verify_checks_size_and_the_published_digest(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "f"
            p.write_bytes(b"abc")
            sha, blob = fm.sha256_of(str(p)), fm.git_blob_id(str(p))
            self.assertTrue(fm.verify(str(p), 3, sha))
            self.assertTrue(fm.verify(str(p), 3, None, blob))  # a non-LFS file is checked by its git blob id
            self.assertTrue(fm.verify(str(p), 3, None))  # no digest published: size only
            self.assertFalse(fm.verify(str(p), 4, sha))
            self.assertFalse(fm.verify(str(p), 3, "0" * 64))
            self.assertFalse(fm.verify(str(p), 3, None, "0" * 40))
            self.assertFalse(fm.verify(str(Path(d) / "missing"), 3, None))
            p.write_bytes(b"abd")  # same size, different bytes
            self.assertFalse(fm.verify(str(p), 3, None, blob))

    def run_fetch(self, dest, siblings, served, repo="o/Name"):
        """Run main() against a fake Hub: `siblings` is the manifest, `served` maps file name to the bytes the fake curl writes."""
        manifest = {"sha": "c0ffee" * 6 + "abcd", "siblings": siblings}

        def fake_curl(cmd, **kw):
            name = cmd[-1].split("/resolve/", 1)[1].split("/", 1)[1]
            Path(cmd[cmd.index("-o") + 1]).write_bytes(served[name])
            return subprocess.CompletedProcess(cmd, 0)
        out = io.StringIO()
        argv = ["fetch_model.py", repo, "--dest", str(dest)]
        with mock.patch.object(fm.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(json.dumps(manifest).encode())), \
                mock.patch.object(fm.subprocess, "run", fake_curl), mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as cm:
                fm.main()
        return cm.exception.code, out.getvalue()

    @staticmethod
    def entry(name, data, lfs=False):
        blob = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
        return {"rfilename": name, "size": len(data), "blobId": blob, **({"lfs": {"sha256": hashlib.sha256(data).hexdigest()}} if lfs else {})}

    def test_downloads_verifies_both_kinds_of_file_and_records_the_repo(self):
        with tempfile.TemporaryDirectory() as d:
            sibs = [self.entry("config.json", b'{"a": 1}'), self.entry("w.safetensors", b"x" * 64, lfs=True)]
            code, out = self.run_fetch(d, sibs, {"config.json": b'{"a": 1}', "w.safetensors": b"x" * 64})
            self.assertEqual(code, 0, out)
            self.assertIn("config.json (blob id)", out)
            self.assertIn("w.safetensors (sha256)", out)
            record = json.loads((Path(d) / "Name" / fm.SOURCE_FILE).read_text())
            self.assertEqual((record["repo"], record["complete"]), ("o/Name", True))

    def test_a_non_lfs_file_with_the_right_size_but_wrong_bytes_is_bad(self):
        with tempfile.TemporaryDirectory() as d:
            sibs = [self.entry("config.json", b'{"a": 1}')]
            code, out = self.run_fetch(d, sibs, {"config.json": b'{"a": 2}'})
            self.assertEqual(code, 1)
            self.assertIn("BAD config.json", out)
            self.assertFalse(json.loads((Path(d) / "Name" / fm.SOURCE_FILE).read_text())["complete"])

    def test_a_shard_left_over_from_another_revision_fails_the_run(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "Name").mkdir()
            (Path(d) / "Name" / "model-00009-of-00009.safetensors").write_bytes(b"old")
            code, out = self.run_fetch(d, [self.entry("config.json", b"{}")], {"config.json": b"{}"})
            self.assertEqual(code, 1)
            self.assertIn("STALE model-00009-of-00009.safetensors", out)
            self.assertFalse(json.loads((Path(d) / "Name" / fm.SOURCE_FILE).read_text())["complete"])
            self.assertTrue((Path(d) / "Name" / "model-00009-of-00009.safetensors").exists())  # never deleted for the user

    def test_another_repo_with_the_same_folder_name_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "Name").mkdir()
            (Path(d) / "Name" / fm.SOURCE_FILE).write_text(json.dumps({"repo": "other/Name"}))
            code, out = self.run_fetch(d, [self.entry("config.json", b"{}")], {"config.json": b"{}"})
            self.assertIn("other/Name", str(code))  # sys.exit(message)
            self.assertFalse((Path(d) / "Name" / "config.json").exists())

    def test_a_file_name_that_leaves_the_model_folder_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            code, out = self.run_fetch(d, [self.entry("../evil", b"x")], {"../evil": b"x"})
            self.assertIn("outside", str(code))
            self.assertFalse((Path(d) / "evil").exists())


class FakeOmlx(BaseHTTPRequestHandler):
    """Just enough of the oMLX admin and chat API for the sweep."""

    state = {}

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def _admin_ok(self):
        # like oMLX 0.7.0: /admin/api/* wants the session cookie from /admin/api/login, a Bearer key alone gets 401
        if self.path.startswith("/admin/") and "omlx_admin_session=ok" not in self.headers.get("Cookie", ""):
            self._json({"detail": "Admin authentication required"}, 401)
            return False
        return True

    def do_GET(self):
        s = self.state
        if not self._admin_ok():
            return
        if self.path == "/admin/api/models":
            self._json({"models": [{"id": "m", "loaded": s["loaded"], "is_loading": False, "moe_expert_offload_supported": s["supported"],
                                    "settings": {"moe_expert_offload_enabled": s["enabled"], "moe_expert_offload_resident_fraction": s["fraction"],
                                                 "mtp_enabled": s["mtp"]}}]})
        elif self.path.startswith("/admin/api/logs"):
            self._json({"logs": "\n".join(s["log"])})
        else:
            self._json({}, 404)

    def do_PUT(self):
        if not self._admin_ok():
            return
        s, b = self.state, self._body()
        s["puts"].append(b)
        if s["fail_put_from"] and len(s["puts"]) >= s["fail_put_from"]:
            return self._json({"detail": "boom"}, 500)
        s["enabled"], s["fraction"], s["loaded"] = b["moe_expert_offload_enabled"], b["moe_expert_offload_resident_fraction"], False
        self._json({"success": True})

    def do_POST(self):
        s = self.state
        if self.path == "/admin/api/login":
            if self._body().get("api_key") != "k":
                return self._json({"detail": "Invalid API key"}, 401)
            s["logins"] = s.get("logins", 0) + 1
            self.send_response(200)
            self.send_header("Set-Cookie", "omlx_admin_session=ok; Path=/")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
        elif not self._admin_ok():
            return
        elif self.path.endswith("/load"):
            s["loaded"] = True
            self._json({"status": "ok"})
        elif self.path == "/v1/chat/completions":
            self._body()
            s["n"] += 1  # every request logs one line of its own, with a counter standing in for the timestamp
            s["log"].append(f"t{s['n']} MoE offload: request=r{s['n']} hit_rate={s['fraction']:.2f} hits=1 misses=1")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            delay = 0.002 + 0.02 * (1 - s["fraction"])  # a larger resident fraction decodes faster
            for _ in range(20):
                time.sleep(delay)
                self.wfile.write(b'data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
                self.wfile.flush()
            self.wfile.write(b'data: {"choices":[],"usage":{"completion_tokens":20}}\n\ndata: [DONE]\n\n')


class Sweep(unittest.TestCase):
    def run_sweep(self, supported=True, extra=(), key="k", mtp=False, fail_put_from=None):
        FakeOmlx.state = {"loaded": True, "enabled": False, "fraction": 0.25, "supported": supported, "puts": [], "mtp": mtp, "n": 0,
                          "fail_put_from": fail_put_from, "log": ["t0 MoE offload: request=old hit_rate=0.99 hits=1 misses=1"]}  # a stale line from an earlier run
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOmlx)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        argv = ["sweep_offload.py", "--model-id", "m", "--fractions", "0.125,0.5", "--max-tokens", "20", "--runs", "1",
                "--base-url", f"http://127.0.0.1:{server.server_port}", *extra]
        out, err = io.StringIO(), io.StringIO()
        try:
            with mock.patch.object(sys, "argv", argv), mock.patch.dict(os.environ, {"OMLX_API_KEY": key}), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                sw.main()
        finally:
            server.shutdown()
            server.server_close()
        self.err = err.getvalue()
        return out.getvalue(), FakeOmlx.state

    def test_picks_the_faster_fraction_and_restores_original_settings(self):
        out, state = self.run_sweep()
        self.assertIn("0.5000", out.split("<- best")[0].splitlines()[-1])
        self.assertIn("Original settings restored", out)
        self.assertEqual((state["enabled"], state["fraction"]), (False, 0.25))

    def test_apply_best_leaves_the_best_fraction(self):
        out, state = self.run_sweep(extra=["--apply-best"])
        self.assertEqual((state["enabled"], state["fraction"]), (True, 0.5))

    def test_logs_in_once_when_admin_rejects_the_bearer_key(self):
        out, state = self.run_sweep()
        self.assertEqual(state["logins"], 1)

    def test_wrong_key_exits_with_a_clear_message(self):
        with self.assertRaises(SystemExit) as cm:
            self.run_sweep(key="wrong")
        self.assertIn("API key", str(cm.exception))

    def test_there_is_no_api_key_flag(self):
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
            self.run_sweep(extra=["--api-key", "k"])
        self.assertEqual(cm.exception.code, 2)  # argparse: unrecognized arguments

    def test_the_key_file_is_the_fallback_when_the_variable_is_unset(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / ".omlx").mkdir()
            (Path(d) / ".omlx" / "api_key").write_text("from-file\n")
            with mock.patch.dict(os.environ, {"OMLX_API_KEY": ""}), mock.patch.object(sw.Path, "home", return_value=Path(d)):
                self.assertEqual(sw.load_key(), "from-file")
            with mock.patch.dict(os.environ, {"OMLX_API_KEY": ""}), mock.patch.object(sw.Path, "home", return_value=Path(d) / "none"):
                self.assertIsNone(sw.load_key())

    def test_hit_rate_comes_from_lines_written_after_the_snapshot_not_from_the_stale_tail(self):
        out, state = self.run_sweep()
        self.assertNotIn("0.99", out)
        self.assertNotIn("n/a", out)
        self.assertEqual(sw.new_log_text("a\nb", "b\nc\nd"), "c\nd")

    def test_refuses_when_server_says_offload_is_unsupported(self):
        with self.assertRaises(SystemExit):
            self.run_sweep(supported=False)

    def test_refuses_while_mtp_is_on(self):
        with self.assertRaises(SystemExit) as cm:
            self.run_sweep(mtp=True)
        self.assertIn("mtp_enabled", str(cm.exception))
        self.assertEqual(FakeOmlx.state["puts"], [])  # nothing was changed

    def test_a_failed_restore_is_reported_and_not_called_restored(self):
        out, state = self.run_sweep(fail_put_from=3)  # puts 1 and 2 set the swept fractions, 3 is the restore
        self.assertIn("could not set the final offload settings", self.err)
        self.assertNotIn("Original settings restored", out)
        self.assertIn("could not be set", out)

    def test_bad_fraction_is_rejected(self):
        with mock.patch.object(sys, "argv", ["x", "--model-id", "m", "--fractions", "1.5"]), self.assertRaises(SystemExit):
            sw.main()


class Home(unittest.TestCase):
    """A private ~/.omlx and a port nobody listens on."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / ".omlx"
        for p in (mock.patch.object(ctl, "OMLX_HOME", self.home), mock.patch.object(ctl, "BASE", f"http://127.0.0.1:{free_port()}")):
            p.start()
            self.addCleanup(p.stop)


class Ctl(unittest.TestCase):
    def test_pick_dmg_takes_the_newest_plain_release_with_a_digest(self):
        def rel(tag, **kw):
            return {"tag_name": tag, **kw, "assets": [
                {"name": f"oMLX-{tag[1:]}-macos15-sequoia.dmg", "browser_download_url": f"u15-{tag}", "digest": "sha256:aa"},
                {"name": f"oMLX-{tag[1:]}-macos26-27.dmg", "browser_download_url": f"u26-{tag}", "digest": "sha256:bb"}]}
        releases = [rel("v0.7.1rc1"), rel("v0.7.1.dev2"), rel("v0.7.0"), rel("v0.6.9")]
        self.assertEqual(ctl.pick_dmg(releases, 15), ("v0.7.0", "oMLX-0.7.0-macos15-sequoia.dmg", "u15-v0.7.0", "aa"))
        self.assertEqual(ctl.pick_dmg(releases, 26)[2], "u26-v0.7.0")
        self.assertEqual(ctl.pick_dmg([rel("v0.7.0", prerelease=True), rel("v0.7.0", draft=True)], 15), None)
        self.assertEqual(ctl.pick_dmg([rel("v0.7.1rc1")], 15), None)

    def test_model_complete_needs_every_shard_whole(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            self.assertFalse(ctl.model_complete(d))
            (d / "config.json").write_text("{}")
            (d / "model.safetensors.index.json").write_text(json.dumps(
                {"metadata": {"total_size": 100}, "weight_map": {"a": "s1.safetensors", "b": "s2.safetensors"}}))
            write_safetensors(d / "s1.safetensors", {"a": 60})
            self.assertFalse(ctl.model_complete(d))  # second shard missing
            write_safetensors(d / "s2.safetensors", {"b": 40}, truncate_to=8 + 100)  # present but shorter than its header declares
            self.assertFalse(ctl.model_complete(d))
            write_safetensors(d / "s2.safetensors", {"b": 40})
            self.assertTrue(ctl.model_complete(d))

    def test_a_header_only_or_truncated_weight_file_is_not_complete(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.safetensors"
            write_safetensors(p, {"a": 4000})
            self.assertTrue(ctl.safetensors_complete(p))
            write_safetensors(p, {"a": 4000}, truncate_to=p.stat().st_size - 1)
            self.assertFalse(ctl.safetensors_complete(p))  # one byte short
            blob_len = struct.unpack("<Q", p.read_bytes()[:8])[0]
            write_safetensors(p, {"a": 4000}, truncate_to=8 + blob_len)
            self.assertFalse(ctl.safetensors_complete(p))  # header only
            write_safetensors(p, {"a": 4000}, truncate_to=8 + blob_len + 4001)
            self.assertFalse(ctl.safetensors_complete(p))  # longer than declared
            p.write_bytes(b"not a safetensors file at all")
            self.assertFalse(ctl.safetensors_complete(p))
            p.write_bytes(b"\xff" * 8 + b"{}")
            self.assertFalse(ctl.safetensors_complete(p))  # absurd header length

    def test_a_folder_filled_by_another_repo_is_a_conflict(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            self.assertIsNone(ctl.source_conflict(d, "a/m"))  # no record: taken as it is
            (d / fm.SOURCE_FILE).write_text(json.dumps({"repo": "a/m"}))
            self.assertIsNone(ctl.source_conflict(d, "a/m"))
            self.assertIn("a/m", ctl.source_conflict(d, "b/m"))
            (d / fm.SOURCE_FILE).write_text(json.dumps({"repo": "a/m", "complete": False}))
            self.assertIn("not finished", ctl.source_conflict(d, "a/m"))  # a running or failed download, or a stale shard
            (d / fm.SOURCE_FILE).write_text(json.dumps({"repo": "a/m", "complete": True}))
            self.assertIsNone(ctl.source_conflict(d, "a/m"))
            (d / fm.SOURCE_FILE).write_text("[1]")
            self.assertIsNone(ctl.source_conflict(d, "b/m"))  # an unreadable record does not block

    def test_attempts_try_the_planned_tier_then_aggressive_then_smaller_fractions(self):
        self.assertEqual(ctl.build_attempts("balanced", 0.25, [0.1875, 0.125]),
                         [("balanced", 0.25), ("aggressive", 0.25), ("aggressive", 0.1875), ("aggressive", 0.125)])
        self.assertEqual(ctl.build_attempts("aggressive", None, []), [("aggressive", None)])

    def test_exclusive_resets_switch_off_only_what_the_model_has_on(self):
        self.assertEqual(ctl.exclusive_resets({"mtp_enabled": True}, offload=True), {"mtp_enabled": False})
        self.assertEqual(ctl.exclusive_resets({"moe_expert_offload_enabled": True}, offload=False), {"moe_expert_offload_enabled": False})
        self.assertEqual(ctl.exclusive_resets({"mtp_enabled": False}, offload=True), {})
        self.assertEqual(ctl.exclusive_resets({"mtp_enabled": True}, offload=False), {})
        self.assertEqual(ctl.exclusive_resets({}, offload=True), {})


class KeyFile(Home):
    def test_a_new_key_is_private_and_long_enough(self):
        ctl.ensure_key()
        self.assertEqual(stat.S_IMODE(ctl.key_file().stat().st_mode), 0o600)
        self.assertGreaterEqual(len(ctl.key_value()), 32)

    def test_an_existing_key_that_others_can_read_is_made_private_and_kept(self):
        self.home.mkdir()
        ctl.key_file().write_text("keep-me")
        ctl.key_file().chmod(0o644)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            ctl.ensure_key()
        self.assertEqual(stat.S_IMODE(ctl.key_file().stat().st_mode), 0o600)
        self.assertEqual(ctl.key_value(), "keep-me")
        self.assertIn("mode is now 600", err.getvalue())

    def test_an_empty_key_file_is_refused(self):
        self.home.mkdir()
        ctl.key_file().write_text("  \n")
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            ctl.ensure_key()


class StateFile(Home):
    def test_an_unreadable_state_file_is_kept_when_the_next_save_replaces_it(self):
        self.home.mkdir()
        ctl.state_file().write_text("{broken")
        with contextlib.redirect_stderr(io.StringIO()) as err:
            state = ctl.load_state()
        self.assertEqual((state["models"], state["notes"]), ({}, []))
        self.assertIn("unreadable", err.getvalue())
        ctl.save_state(state)
        self.assertEqual(json.loads(ctl.state_file().read_text())["models"], {})
        kept = list(self.home.glob("skill-state.corrupt-*.json"))
        self.assertEqual([k.read_text() for k in kept], ["{broken"])

    def test_concurrent_updates_are_all_kept(self):
        def add(i):
            ctl.update_state(lambda st: st["notes"].append(f"n{i}"))
        threads = [threading.Thread(target=add, args=(i,)) for i in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(ctl.load_state()["notes"]), sorted(f"n{i}" for i in range(12)))
        self.assertEqual(list(self.home.glob("*.tmp")), [])

    def test_remember_keeps_a_note_per_model_and_global(self):
        with contextlib.redirect_stdout(io.StringIO()):
            ctl.cmd_remember(argparse_ns(note="a", model=None))
            ctl.cmd_remember(argparse_ns(note="b", model="x/m"))
        st = ctl.load_state()
        self.assertTrue(st["notes"][0].endswith(": a"))
        self.assertTrue(st["models"]["x/m"]["notes"][0].endswith(": b"))


class ServerIdentity(Home):
    def serve(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        p = mock.patch.object(ctl, "BASE", f"http://127.0.0.1:{server.server_port}")
        p.start()
        self.addCleanup(p.stop)

    @staticmethod
    def handler(accept):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                code = 200 if accept(self.headers.get("Authorization")) else 401
                self.send_response(code)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")
        return H

    def test_nothing_listening_is_down(self):
        self.assertEqual(ctl.server_state(), "down")

    def test_a_server_that_needs_no_key_is_not_ours(self):
        self.home.mkdir()
        ctl.key_file().write_text("testkey")
        self.serve(self.handler(lambda auth: True))
        self.assertEqual(ctl.server_state(), "open")

    def record_this_process_as_the_server(self):
        """The fake servers run inside the test process, so this process plays the recorded server that listens on the port."""
        self.home.mkdir(exist_ok=True)
        ctl.write_pid_record(os.getpid())
        p = mock.patch.object(ctl, "listener_pids", lambda: {os.getpid()})
        p.start()
        self.addCleanup(p.stop)

    def test_a_server_that_takes_our_key_is_ours(self):
        self.home.mkdir()
        ctl.key_file().write_text("testkey")
        self.record_this_process_as_the_server()
        self.serve(self.handler(lambda auth: auth == "Bearer testkey"))
        self.assertEqual(ctl.server_state(), "ours")

    def test_a_server_that_rejects_our_key_needs_a_key(self):
        self.home.mkdir()
        ctl.key_file().write_text("testkey")
        self.record_this_process_as_the_server()
        self.serve(self.handler(lambda auth: auth == "Bearer another"))
        self.assertEqual(ctl.server_state(), "needs_key")

    def test_the_key_is_never_sent_to_a_listener_that_is_not_the_recorded_process(self):
        self.home.mkdir()
        ctl.key_file().write_text("testkey")
        seen = []
        self.serve(self.handler(lambda auth: seen.append(auth) or auth == "Bearer testkey"))
        with sleeper() as other:
            ctl.write_pid_record(other.pid)  # the record names a different, live process
            with mock.patch.object(ctl, "listener_pids", lambda: {os.getpid()}):
                self.assertEqual(ctl.server_state(), "needs_key")
        self.assertEqual(seen, [None])  # one anonymous probe, no Authorization header ever

    def test_without_a_record_the_key_is_not_sent_either(self):
        self.home.mkdir()
        ctl.key_file().write_text("testkey")
        seen = []
        self.serve(self.handler(lambda auth: seen.append(auth) or auth == "Bearer testkey"))
        with mock.patch.object(ctl, "listener_pids", lambda: {os.getpid()}):
            self.assertEqual(ctl.server_state(), "needs_key")
        self.assertEqual(seen, [None])

    def test_a_child_of_the_recorded_process_counts_as_the_listener(self):
        self.assertEqual(ctl.parent_pid(os.getpid()), os.getppid())
        with mock.patch.object(ctl, "listener_pids", lambda: {os.getpid()}):
            self.assertTrue(ctl.port_owned_by(os.getppid()))  # we are a child of the recorded pid
            self.assertTrue(ctl.port_owned_by(os.getpid()))
            self.assertFalse(ctl.port_owned_by(1))
            self.assertFalse(ctl.port_owned_by(None))

    def test_lsof_output_is_read_as_pids(self):
        with mock.patch.object(ctl.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "p123\nf4\np456\nf5\n", "")):
            self.assertEqual(ctl.listener_pids(), {123, 456})

    def test_a_port_that_accepts_but_never_answers_is_busy_not_down(self):
        with socket.socket() as s, mock.patch.object(ctl, "PROBE_TIMEOUT", 0.3):
            s.bind(("127.0.0.1", 0))
            s.listen(1)  # the kernel completes the connection; nobody ever replies
            with mock.patch.object(ctl, "BASE", f"http://127.0.0.1:{s.getsockname()[1]}"):
                self.assertEqual(ctl.server_state(), "busy")


class Pid(Home):
    def test_a_recorded_live_process_is_recognised(self):
        self.home.mkdir()
        with sleeper() as proc:
            ctl.write_pid_record(proc.pid)
            self.assertEqual(ctl.managed_pid(), proc.pid)

    def test_a_pid_with_another_start_time_is_not_reported_and_stop_leaves_it_alone(self):
        self.home.mkdir()
        with sleeper() as proc:
            ctl.pid_file().write_text(f"{proc.pid}\nMon Jan  1 00:00:00 2001\n")  # the pid now belongs to a different process
            self.assertIsNone(ctl.managed_pid())
            with contextlib.redirect_stdout(io.StringIO()) as out:
                ctl.cmd_stop(argparse_ns(force=True))
            self.assertIn("no server running", out.getvalue())
            self.assertIsNone(proc.poll())  # never signalled
            self.assertFalse(ctl.pid_file().exists())

    def test_pid_one_a_dead_pid_and_the_old_bare_format_are_ignored(self):
        self.home.mkdir()
        ctl.pid_file().write_text("1\nanything\n")
        self.assertIsNone(ctl.managed_pid())
        with sleeper() as proc:
            ctl.pid_file().write_text(f"{proc.pid}")  # no start time recorded
            self.assertIsNone(ctl.managed_pid())
        ctl.pid_file().write_text("999999\nMon Jan  1 00:00:00 2001\n")
        self.assertIsNone(ctl.managed_pid())

    def test_stop_pid_ends_the_process_and_removes_the_record(self):
        self.home.mkdir()
        with sleeper() as proc:
            ctl.write_pid_record(proc.pid)
            self.assertEqual(ctl.stop_pid(proc.pid, grace=5), "stopped")
            self.assertEqual(proc.wait(timeout=5), -signal_number("SIGTERM"))
            self.assertFalse(ctl.pid_file().exists())

    def test_a_server_that_ignores_sigterm_needs_force(self):
        self.home.mkdir()
        with sleeper("sh", "-c", "trap '' TERM; while :; do sleep 1; done") as proc:
            time.sleep(0.3)  # let the shell install its trap
            ctl.write_pid_record(proc.pid)
            self.assertIsNone(ctl.stop_pid(proc.pid, grace=0.6))
            self.assertEqual(ctl.managed_pid(), proc.pid)
            self.assertEqual(ctl.stop_pid(proc.pid, force=True, grace=0.6), "killed")
            self.assertEqual(proc.wait(timeout=5), -signal_number("SIGKILL"))


def signal_number(name):
    import signal
    return int(getattr(signal, name))


class Install(unittest.TestCase):
    def test_replace_app_swaps_in_the_new_copy_and_drops_the_old_one(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "oMLX.app").mkdir()
            (d / "oMLX.app" / "v").write_text("old")
            (d / "oMLX.app.new").mkdir()
            (d / "oMLX.app.new" / "v").write_text("new")
            ctl.replace_app(d / "oMLX.app.new", d / "oMLX.app")
            self.assertEqual((d / "oMLX.app" / "v").read_text(), "new")
            self.assertEqual(sorted(p.name for p in d.iterdir()), ["oMLX.app"])

    def test_replace_app_works_when_nothing_is_installed_yet(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "oMLX.app.new").mkdir()
            ctl.replace_app(d / "oMLX.app.new", d / "oMLX.app")
            self.assertTrue((d / "oMLX.app").is_dir())

    def test_a_failed_swap_puts_the_old_app_back(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "oMLX.app").mkdir()
            (d / "oMLX.app" / "v").write_text("old")
            with self.assertRaises(OSError):
                ctl.replace_app(d / "missing.new", d / "oMLX.app")
            self.assertEqual((d / "oMLX.app" / "v").read_text(), "old")
            self.assertFalse((d / "oMLX.app.old").exists())

    def test_gatekeeper_needs_a_zero_exit_status_and_a_notarized_developer_id(self):
        def verdict(code, text):
            with mock.patch.object(ctl.subprocess, "run", return_value=subprocess.CompletedProcess([], code, "", text)):
                return ctl.gatekeeper_verdict(Path("/x.app"))[0]
        good = "/x.app: accepted\nsource=Notarized Developer ID"
        self.assertTrue(verdict(0, good))
        self.assertFalse(verdict(3, good))  # the text says accepted but spctl failed
        self.assertFalse(verdict(0, "/x.app: accepted\nsource=Developer ID"))  # signed but not notarized
        self.assertFalse(verdict(3, "/x.app: rejected\nsource=no usable signature"))


class FakeStart(BaseHTTPRequestHandler):
    """The part of oMLX that `omlx_ctl.py start` talks to; a load is refused until the guard and fraction are loose enough."""

    state = {}

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def _authorized(self):
        bearer = self.headers.get("Authorization") == "Bearer testkey"
        cookie = "omlx_admin_session=ok" in self.headers.get("Cookie", "")
        if self.path.startswith("/admin/") and self.path != "/admin/api/login" and not cookie:
            self._json({"detail": "Admin authentication required"}, 401)
            return False
        if self.path.startswith("/v1/") and not bearer:
            self._json({"detail": "API key required"}, 401)
            return False
        return True

    def do_GET(self):
        s = self.state
        if not self._authorized():
            return
        if self.path == "/v1/models":
            self._json({"data": []})
        elif self.path == "/admin/api/models":
            self._json({"models": [{"id": s["name"], "loaded": s["loaded"], "is_loading": False, "moe_expert_offload_supported": True, "settings": s["settings"]}]})
        elif self.path.startswith("/admin/api/logs"):
            self._json({"logs": "\n".join(s["log"])})
        else:
            self._json({}, 404)

    def do_PUT(self):
        if not self._authorized():
            return
        body = self._body()
        self.state["fraction"] = body.get("moe_expert_offload_resident_fraction")
        self.state["puts"].append(body)
        if not self.state["drop_offload"]:
            self.state["settings"].update(body)
        self._json({"success": True})

    def do_POST(self):
        s = self.state
        if self.path == "/admin/api/login":
            if self._body().get("api_key") != "testkey":
                return self._json({"detail": "Invalid API key"}, 401)
            self.send_response(200)
            self.send_header("Set-Cookie", "omlx_admin_session=ok; Path=/")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
        elif not self._authorized():
            return
        elif self.path == "/admin/api/global-settings":
            body = self._body()
            s["globals"].append(body)
            if "memory_guard_tier" in body:
                s["tier"] = body["memory_guard_tier"]
                s["tiers"].append(s["tier"])
            self._json({"success": True, "runtime_applied": s["live"]})
        elif self.path.endswith("/load"):
            if s["tier"] != "aggressive" or (s["fraction"] or 0) > s["max_fraction"]:
                self._json({"detail": "Model 'm' (7.29GB) does not fit under the dynamic memory ceiling (3.75GB). Close other apps."}, 500)
            else:
                s["loaded"] = True
                if s["writes_log"]:  # a counter stands in for the timestamp every real log line starts with
                    s["n"] += 1
                    s["log"] += [f"t{s['n']} - moe expert offload: wrapped 40 layers at {s['fraction'] * 100:.1f}% residency (expert tables: 18.12 GB total, 4.53 GB resident)",
                                 f"t{s['n']} - Loaded model: m (actual: 6.66GB, local estimate: 7.29GB, full model: 19.95GB, total: 7.29GB)"]
                self._json({"status": "ok"})
        elif self.path == "/v1/chat/completions":
            self._json({"choices": [{"message": {"content": "Hello!"}}], "usage": {"completion_tokens": min(self._body()["max_tokens"], 40)}})


class Start(unittest.TestCase):
    NAME = "Fake-35B-A3B-4bit"
    STALE_WRAPPED = "t0 - moe expert offload: wrapped 40 layers at 25.0% residency (expert tables: 18.12 GB total, 4.53 GB resident)"

    def run_start(self, home, max_fraction=1.0, extra=(), settings=None, log=(), writes_log=True, drop_offload=False, patches=()):
        FakeStart.state = {"name": self.NAME, "loaded": False, "tier": "balanced", "tiers": [], "fraction": None, "puts": [], "max_fraction": max_fraction,
                           "settings": dict(settings or {}), "log": list(log), "writes_log": writes_log, "drop_offload": drop_offload, "n": 0,
                           "globals": [], "live": ["max_concurrent_requests"]}
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeStart)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        out = io.StringIO()
        all_patches = [mock.patch.object(ctl, "BASE", f"http://127.0.0.1:{server.server_port}"), mock.patch.object(ctl, "OMLX_HOME", home),
                       mock.patch.object(ctl, "APP", home), mock.patch.object(pc, "detect_hardware", lambda a: hardware(16, 10.7)),
                       mock.patch.object(ctl, "listener_pids", lambda: {os.getpid()}),
                       mock.patch.object(sys, "argv", ["omlx_ctl.py", "start", "--model", f"x/{self.NAME}", *extra]), *patches]
        try:
            for p in all_patches:
                p.start()
            ctl.write_pid_record(os.getpid())  # this process plays the recorded server that the fake listens as
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                ctl.main()
        finally:
            for p in all_patches:
                p.stop()
            server.shutdown()
            server.server_close()
        return out.getvalue(), FakeStart.state

    def make_home(self, d):
        home = Path(d) / ".omlx"
        mdir = home / "models" / self.NAME
        mdir.mkdir(parents=True)
        (home / "api_key").write_text("testkey")
        (home / "api_key").chmod(0o600)
        (mdir / "config.json").write_text(json.dumps({
            "model_type": "qwen3_5_moe", "quantization": {"bits": 4},
            "text_config": {"num_experts": 256, "num_experts_per_tok": 8, "num_hidden_layers": 40, "num_key_value_heads": 2, "head_dim": 256,
                            "layer_types": (["linear_attention"] * 3 + ["full_attention"]) * 10}}))
        write_safetensors(mdir / "model.safetensors", {"model.layers.0.mlp.switch_mlp.up_proj.weight": 17 * GIB, "model.embed_tokens.weight": 2 * GIB})
        return home

    def test_refused_at_balanced_then_loads_at_aggressive_and_remembers_it(self):
        with tempfile.TemporaryDirectory() as d:
            home = self.make_home(d)
            out, state = self.run_start(home)
            self.assertEqual(state["tiers"], ["balanced", "aggressive"])
            self.assertEqual(state["fraction"], 0.25)
            self.assertIn("READY", out)
            self.assertIn("/admin/chat", out)
            self.assertIn(f"file://{home / 'api_key'}", out)
            self.assertNotIn("testkey", out)
            remembered = json.loads((home / "skill-state.json").read_text())
            self.assertEqual(remembered["default_model"], f"x/{self.NAME}")
            entry = remembered["models"][f"x/{self.NAME}"]
            self.assertEqual((entry["tier"], entry["fraction"]), ("aggressive", 0.25))
            self.assertEqual(entry["context"], 32768)
            self.assertIsNotNone(entry["tok_s"])  # the 64-token request produced 40 tokens, enough to time
            self.assertEqual(entry["loaded_gb"], 6.66)
            out, state = self.run_start(home)  # the second start begins with what worked
            self.assertEqual(state["tiers"], ["aggressive"])

    def test_smaller_fraction_when_aggressive_is_still_refused(self):
        with tempfile.TemporaryDirectory() as d:
            out, state = self.run_start(self.make_home(d), max_fraction=0.2)
            self.assertEqual(state["fraction"], 0.1875)
            self.assertTrue(state["loaded"])

    def test_gives_up_with_advice_and_closes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                self.run_start(self.make_home(d), max_fraction=0.01)
            self.assertIn("Close large apps", str(cm.exception))

    def test_refuses_a_model_that_is_not_fully_downloaded(self):
        with tempfile.TemporaryDirectory() as d:
            home = self.make_home(d)
            (home / "models" / self.NAME / "model.safetensors").unlink()
            with self.assertRaises(SystemExit) as cm:
                self.run_start(home)
            self.assertIn("fetch_model.py", str(cm.exception))

    def test_refuses_a_model_whose_weights_are_cut_short(self):
        with tempfile.TemporaryDirectory() as d:
            home = self.make_home(d)
            path = home / "models" / self.NAME / "model.safetensors"
            with open(path, "r+b") as f:
                f.truncate(path.stat().st_size - 1)
            with self.assertRaises(SystemExit) as cm:
                self.run_start(home)
            self.assertIn("incomplete", str(cm.exception))

    def test_refuses_a_folder_that_another_repo_filled(self):
        with tempfile.TemporaryDirectory() as d:
            home = self.make_home(d)
            (home / "models" / self.NAME / fm.SOURCE_FILE).write_text(json.dumps({"repo": "other/" + self.NAME}))
            with self.assertRaises(SystemExit) as cm:
                self.run_start(home)
            self.assertIn("other/", str(cm.exception))

    def test_refuses_a_port_held_by_a_server_that_is_not_ours(self):
        for state, words in (("open", "without any key"), ("needs_key", "is not the server this skill started"), ("busy", "did not answer")):
            with self.subTest(state), tempfile.TemporaryDirectory() as d:
                with self.assertRaises(SystemExit) as cm:
                    self.run_start(self.make_home(d), patches=[mock.patch.object(ctl, "server_state", return_value=state)])
                self.assertIn(words, str(cm.exception))
                self.assertEqual(FakeStart.state["puts"], [])  # the key was never used on it

    def test_a_server_started_by_a_run_that_fails_is_stopped_again(self):
        procs = []

        def fake_spawn(glob):
            proc = subprocess.Popen(["sleep", "60"], start_new_session=True)
            procs.append(proc)
            ctl.write_pid_record(proc.pid)
            return proc
        answers = iter(["down"])
        try:
            with tempfile.TemporaryDirectory() as d:
                home = self.make_home(d)
                with self.assertRaises(SystemExit):
                    self.run_start(home, max_fraction=0.01, patches=[mock.patch.object(ctl, "spawn_server", fake_spawn),
                                                                     mock.patch.object(ctl, "server_state", lambda: next(answers, "ours"))])
                self.assertEqual(procs[0].wait(timeout=10), -signal_number("SIGTERM"))
                self.assertFalse((home / "skill-server.pid").exists())
        finally:
            for p in procs:
                p.kill()
                p.wait()

    def test_a_server_that_exits_before_it_answers_ends_the_wait_at_once(self):
        def fake_spawn(glob):
            proc = subprocess.Popen(["false"], start_new_session=True)
            proc.wait()
            ctl.write_pid_record(proc.pid)
            return proc
        with tempfile.TemporaryDirectory() as d:
            started = time.monotonic()
            with self.assertRaises(SystemExit) as cm:
                self.run_start(self.make_home(d), patches=[mock.patch.object(ctl, "spawn_server", fake_spawn),
                                                           mock.patch.object(ctl, "server_state", return_value="down")])
            self.assertIn("exited with code 1", str(cm.exception))
            self.assertLess(time.monotonic() - started, 10)

    def test_a_reused_server_gets_the_plans_other_globals_and_the_answer_says_what_applied(self):
        with tempfile.TemporaryDirectory() as d:
            out, state = self.run_start(self.make_home(d))
            self.assertIn("reusing it", out)
            self.assertIn("applied now: max_concurrent_requests", out)
            self.assertIn("take effect when the server is next started", out)
            sent = state["globals"][0]
            self.assertEqual(sent["max_concurrent_requests"], 2)  # 16 GB Mac, offload
            self.assertNotIn("memory_guard_tier", sent)  # the guard goes through the load attempts
            self.assertTrue(sent["ssd_cache_dir"].startswith("/"))  # ~ expanded

    def test_a_server_this_run_spawned_is_not_sent_the_globals_again(self):
        procs = []

        def fake_spawn(glob):
            proc = subprocess.Popen(["sleep", "60"], start_new_session=True)
            procs.append(proc)
            return proc
        answers = iter(["down"])
        try:
            with tempfile.TemporaryDirectory() as d:
                out, state = self.run_start(self.make_home(d), patches=[mock.patch.object(ctl, "spawn_server", fake_spawn),
                                                                        mock.patch.object(ctl, "server_state", lambda: next(answers, "ours"))])
            self.assertIn("READY", out)
            self.assertEqual(state["globals"], [{"memory_guard_tier": "balanced"}, {"memory_guard_tier": "aggressive"}])
        finally:
            for pr in procs:
                pr.kill()
                pr.wait()

    def test_refuses_a_folder_whose_download_did_not_finish(self):
        with tempfile.TemporaryDirectory() as d:
            home = self.make_home(d)
            (home / "models" / self.NAME / fm.SOURCE_FILE).write_text(json.dumps({"repo": f"x/{self.NAME}", "complete": False}))
            with self.assertRaises(SystemExit) as cm:
                self.run_start(home)
            self.assertIn("not finished", str(cm.exception))

    def test_mtp_that_is_on_is_switched_off_before_an_offload_load(self):
        with tempfile.TemporaryDirectory() as d:
            out, state = self.run_start(self.make_home(d), settings={"mtp_enabled": True})
            self.assertTrue(state["puts"])
            self.assertTrue(all(b.get("mtp_enabled") is False for b in state["puts"]), state["puts"])
            self.assertFalse(state["settings"]["mtp_enabled"])

    def test_an_old_offload_line_in_the_log_does_not_prove_this_load(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                self.run_start(self.make_home(d), log=[self.STALE_WRAPPED], writes_log=False, drop_offload=True)
            self.assertIn("NOT applied", str(cm.exception))

    def test_a_model_already_loaded_with_these_settings_is_accepted_with_a_note(self):
        with tempfile.TemporaryDirectory() as d:
            out, state = self.run_start(self.make_home(d), log=[self.STALE_WRAPPED], writes_log=False)
            self.assertIn("READY", out)
            self.assertIn("no new offload line", out)

    def test_only_the_lines_this_load_wrote_are_read(self):
        with tempfile.TemporaryDirectory() as d:
            stale = "t0 - Loaded model: m (actual: 99.00GB, local estimate: 1GB, full model: 1GB, total: 1GB)"
            out, _ = self.run_start(self.make_home(d), log=[stale, self.STALE_WRAPPED])
            self.assertIn("model loaded as 6.66 GB", out)
            self.assertNotIn("99.00", out)


class SkillFile(unittest.TestCase):
    """SKILL.md must satisfy the Agent Skills format (agentskills.io): name equals the folder, description at most 1024 characters, body under 500 lines."""

    def test_frontmatter_and_size(self):
        skill = Path(__file__).resolve().parent.parent / "SKILL.md"
        front, body = skill.read_text().split("---\n", 2)[1:]
        fields = dict(line.split(": ", 1) for line in front.splitlines() if ": " in line)
        self.assertEqual(fields["name"], skill.parent.name)
        desc = fields["description"].strip('"')
        self.assertLessEqual(len(desc), 1024)
        self.assertIn("Use whenever", desc)
        self.assertLess(len(body.splitlines()), 500)

    def test_every_script_named_in_allowed_tools_exists(self):
        skill = Path(__file__).resolve().parent.parent / "SKILL.md"
        text = skill.read_text()
        allowed = next(line for line in text.splitlines() if line.startswith("allowed-tools:"))
        names = set(re.findall(r"scripts/(\w+\.py)", allowed))
        self.assertEqual(names, {"omlx_ctl.py", "propose_config.py", "fetch_model.py", "sweep_offload.py"})
        for n in names:
            self.assertTrue((skill.parent / "scripts" / n).is_file(), n)


if __name__ == "__main__":
    unittest.main()
