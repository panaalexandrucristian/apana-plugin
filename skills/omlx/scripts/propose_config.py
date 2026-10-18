#!/usr/bin/env python3
"""Propose oMLX settings for this Mac and one model.

Reads the hardware (chip, RAM, free disk, Metal working-set limit), reads the model's
config.json and safetensors headers (local directory or Hugging Face repo; a remote read is the
first 256 KiB of each file, which holds the header, so the weights are not downloaded) and prints the oMLX settings that fit: resident or with MoE
expert offload, the resident fraction, memory guard, SSD KV cache, concurrency, context.
Nothing is changed on the machine; the output is a proposal.

    python3 -I propose_config.py <model-dir | owner/repo> [--tier balanced] [--context 32768] [--json]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

GIB = 1024**3

# Memory each memory-guard tier leaves for the OS and other apps: (share of RAM, min, max).
# Source: omlx/process_memory_enforcer.py _TIER_RESERVE. oMLX's real ceiling is dynamic
# (it also reads vm_stat), so this static figure is the best case.
TIER_RESERVE = {
    "safe": (0.20, 6 * GIB, 16 * GIB),
    "balanced": (0.08, 3 * GIB, 8 * GIB),
    "aggressive": (0.02, int(1.5 * GIB), 4 * GIB),
}
# Checkpoint families oMLX can offload (docs/experimental/MoE_Expert_Offload.md, "Supported models").
OFFLOAD_TYPES = {"deepseek_v41", "deepseek_v4", "qwen4_exp", "qwen3_5_moe", "gemma4", "olmoe", "glm_moe_dsa", "glm5_next"}
# Families whose MTP head stays resident under offload (omlx/model_settings.py MOE_OFFLOAD_MTP_MODEL_TYPES).
OFFLOAD_MTP_TYPES = {"deepseek_v41", "glm5_next", "qwen4_exp"}
LADDER = [0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625]  # resident fractions, largest first

# Heuristics, not oMLX constants. Calibrate them with sweep_offload.py.
TRANSIENT_BYTES = int(1.5 * GIB)  # prefill transients and buffers on top of weights + KV
SAFETY = 0.95  # use at most this share of the computed budget

EXPERT_RE = re.compile(r"\.(switch_mlp|experts|block_sparse_moe)\.")
MTP_RE = re.compile(r"(^|\.)mtp\.")
VISION_RE = re.compile(r"(^|\.)(visual|vision_tower|vision_model|audio_tower|multi_modal_projector)\.")


def sysctl(name: str) -> str | None:
    r = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def mlx_metal_limit() -> int | None:
    """Exact Metal working-set limit, from any interpreter that has mlx installed."""
    probe = (
        "import mlx.core as mx\n"
        "d = mx.device_info() if hasattr(mx, 'device_info') else mx.metal.device_info()\n"
        "print(int(d['max_recommended_working_set_size']))"
    )
    for py in (sys.executable, "/opt/homebrew/opt/omlx/libexec/bin/python", shutil.which("python3")):
        if not py or not Path(py).exists():
            continue
        try:
            r = subprocess.run([py, "-I", "-c", probe], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if r.returncode == 0 and r.stdout.strip().isdigit():
            return int(r.stdout.strip())
    return None


def estimate_metal_limit(ram: int) -> int:
    share = 0.667 if ram <= 36 * GIB else 0.75 if ram <= 64 * GIB else 0.836
    return int(ram * share)


def detect_hardware(args: argparse.Namespace) -> dict:
    chip = args.chip or sysctl("machdep.cpu.brand_string") or "unknown"
    ram = int(args.ram_gb * GIB) if args.ram_gb else int(sysctl("hw.memsize") or 0)
    wired_mb = int(sysctl("iogpu.wired_limit_mb") or 0)
    if args.metal_limit_gb:
        metal, source = int(args.metal_limit_gb * GIB), "given"
    elif wired_mb:
        metal, source = wired_mb * 1024**2, "iogpu.wired_limit_mb"
    elif (exact := None if args.ram_gb else mlx_metal_limit()):
        metal, source = exact, "mlx"
    else:
        metal, source = estimate_metal_limit(ram), "estimate"
    metal_tool = subprocess.run(["xcrun", "--find", "metal"], capture_output=True).returncode == 0
    return {
        "chip": chip,
        "ram_bytes": ram,
        "macos": sysctl("kern.osproductversion") or "unknown",
        "wired_limit_mb": wired_mb,
        "metal_limit_bytes": metal,
        "metal_limit_source": source,
        "disk_free_bytes": shutil.disk_usage(Path.home()).free,
        "xcode_metal_toolchain": metal_tool,
    }


# --- model inspection -----------------------------------------------------------------

def http_get(url: str, rng: str | None = None, limit: int = 1 << 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "omlx-skill", **({"Range": rng} if rng else {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(limit)


def parse_header(blob: bytes) -> list[tuple[str, int]]:
    """Tensors as (name, nbytes) from the start of a safetensors file."""
    (n,) = struct.unpack("<Q", blob[:8])
    header = json.loads(blob[8 : 8 + n])
    return [(k, v["data_offsets"][1] - v["data_offsets"][0]) for k, v in header.items() if k != "__metadata__"]


def remote_tensors(repo: str, files: list[str], rev: str = "main") -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for name in files:
        url = f"https://huggingface.co/{repo}/resolve/{rev}/{name}"
        blob = http_get(url, "bytes=0-262143", 262144)
        (n,) = struct.unpack("<Q", blob[:8])
        if len(blob) < 8 + n:
            blob = http_get(url, f"bytes=0-{8 + n - 1}", 8 + n)
        out += parse_header(blob)
    return out


def load_model(arg: str) -> tuple[dict, dict, list[tuple[str, int]], str]:
    """config, generation_config, tensors, display name."""
    path = Path(arg).expanduser()
    if path.is_dir():
        gen = path / "generation_config.json"
        tensors = []
        for f in sorted(path.glob("*.safetensors")):
            with open(f, "rb") as fh:
                (n,) = struct.unpack("<Q", fh.read(8))
                tensors += parse_header(struct.pack("<Q", n) + fh.read(n))
        return (
            json.loads((path / "config.json").read_text()),
            json.loads(gen.read_text()) if gen.exists() else {},
            tensors,
            path.name,
        )
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", arg):
        sys.exit(f"{arg!r} is neither a model directory nor an owner/repo id")
    info = json.loads(http_get(f"https://huggingface.co/api/models/{arg}"))
    rev = info.get("sha") or "main"  # every file below is read at this one commit, so a push meanwhile cannot mix revisions
    names = [s["rfilename"] for s in info.get("siblings", [])]
    try:
        gen = json.loads(http_get(f"https://huggingface.co/{arg}/resolve/{rev}/generation_config.json"))
    except OSError:
        gen = {}
    return (
        json.loads(http_get(f"https://huggingface.co/{arg}/resolve/{rev}/config.json")),
        gen,
        remote_tensors(arg, [n for n in names if n.endswith(".safetensors")], rev),
        arg.split("/")[-1],
    )


def first(d: dict, keys: tuple[str, ...]):
    return next((d[k] for k in keys if d.get(k) is not None), None)


def kv_bytes(tc: dict, context: int) -> int:
    """KV cache bytes for `context` tokens, counting only layers that keep a growing cache."""
    layers = tc.get("num_hidden_layers") or 0
    types = tc.get("layer_types")
    window = tc.get("sliding_window") or context
    if types:
        full = sum(t == "full_attention" for t in types)
        sliding = sum(t == "sliding_attention" for t in types)
    elif tc.get("full_attention_interval"):
        full, sliding = layers // tc["full_attention_interval"], 0
    else:
        full, sliding = layers, 0
    if tc.get("kv_lora_rank"):  # MLA: one compressed latent per token
        per_token = (tc["kv_lora_rank"] + (tc.get("qk_rope_head_dim") or 0)) * 2
    else:
        heads = tc.get("num_key_value_heads") or tc.get("num_attention_heads") or 0
        dim = tc.get("head_dim") or ((tc.get("hidden_size") or 0) // max(1, tc.get("num_attention_heads") or 1))
        per_token = 2 * heads * dim * 2
    return per_token * (full * context + sliding * min(context, window))


def analyze(config: dict, tensors: list[tuple[str, int]]) -> dict:
    tc = config.get("text_config") or config.get("llm_config") or config
    sizes = {"expert": 0, "mtp": 0, "vision": 0, "other": 0}
    for name, nbytes in tensors:
        if MTP_RE.search(name):
            sizes["mtp"] += nbytes
        elif VISION_RE.search(name):
            sizes["vision"] += nbytes
        elif EXPERT_RE.search(name) and "shared_expert" not in name:
            sizes["expert"] += nbytes
        else:
            sizes["other"] += nbytes
    total = sum(sizes.values())
    quant = config.get("quantization") or config.get("quantization_config") or {}
    return {
        "model_type": str(config.get("model_type", "")).replace("-", "_").lower(),
        "num_experts": first(tc, ("num_experts", "num_local_experts", "n_routed_experts", "moe_num_experts")) or 0,
        "top_k": first(tc, ("num_experts_per_tok", "num_experts_per_topk", "moe_top_k")) or 0,
        "quant_bits": quant.get("bits"),
        "max_position": tc.get("max_position_embeddings"),
        "total_bytes": total,
        "expert_bytes": sizes["expert"],
        "mtp_bytes": sizes["mtp"],
        "vision_bytes": sizes["vision"],
        "has_mtp_head": sizes["mtp"] > 0,
        "text_config": tc,
    }


# --- planning -------------------------------------------------------------------------

def tier_reserve(tier: str, ram: int) -> int:
    share, low, high = TIER_RESERVE[tier]
    return int(min(high, max(low, ram * share)))


def plan(hw: dict, m: dict, tier: str, context: int) -> dict:
    ram, tc = hw["ram_bytes"], m["text_config"]
    ceiling = ram - tier_reserve(tier, ram)
    cap = min(ceiling, hw["metal_limit_bytes"])
    kv = kv_bytes(tc, context)
    budget = int((cap - kv - TRANSIENT_BYTES) * SAFETY)
    moe = m["num_experts"] > 1 and m["expert_bytes"] > 0
    eligible = moe and m["model_type"] in OFFLOAD_TYPES and m["quant_bits"] is not None
    other = m["total_bytes"] - m["expert_bytes"]
    p = {
        "mode": None, "fraction": None, "experts_per_layer": None, "resident_bytes": None,
        "ceiling_bytes": ceiling, "cap_bytes": cap, "kv_bytes": kv, "budget_bytes": budget,
        "eligible_for_offload": eligible, "sweep_fractions": [],
    }
    if m["total_bytes"] <= budget:
        p.update(mode="resident", resident_bytes=m["total_bytes"])
        return p
    if not eligible:
        p["mode"] = "too_big"
        return p
    floor = max(0.05, m["top_k"] / m["num_experts"])
    usable = [f for f in LADDER if f >= floor]
    fits = [f for f in usable if other + f * m["expert_bytes"] <= budget]
    if not fits:
        p["mode"] = "too_big_even_offloaded"
        return p
    f = fits[0]
    i = usable.index(f)
    p.update(
        mode="offload", fraction=f, experts_per_layer=math.ceil(f * m["num_experts"]),
        resident_bytes=int(other + f * m["expert_bytes"]),
        sweep_fractions=[x for x in (usable[i - 1] if i else None, f, usable[i + 1] if i + 1 < len(usable) else None) if x],
    )
    return p


def propose(hw: dict, m: dict, p: dict, gen: dict, name: str, tier: str, context: int) -> dict:
    ram_gib = hw["ram_bytes"] / GIB
    model: dict = {"max_context_window": context}
    for src, dst in (("temperature", "temperature"), ("top_p", "top_p"), ("top_k", "top_k"), ("repetition_penalty", "repetition_penalty")):
        if gen.get(src) is not None:
            model[dst] = gen[src]
    notes: list[str] = []
    if any(k in model for k in ("temperature", "top_p", "top_k")):
        notes.append(
            "Sampling values come from the model's generation_config.json. The model card (README.md) may recommend others "
            "per mode (thinking or not) or require a fixed system prompt: read it before settling on sampling."
        )
    if p["mode"] == "offload":
        model.update(moe_expert_offload_enabled=True, moe_expert_offload_resident_fraction=p["fraction"])
        if m["has_mtp_head"]:
            notes.append(
                "The checkpoint carries an MTP head, but oMLX refuses mtp_enabled together with expert offload for "
                f"model_type {m['model_type']}; MTP stays off."
            )
    elif p["mode"] == "resident" and m["has_mtp_head"] and m["model_type"].startswith(("qwen3_5", "qwen3_6", "deepseek_v4")):
        model["mtp_enabled"] = True
        notes.append("Fits fully resident and has an MTP head: mtp_enabled (Lightning MTP speculative decoding) is worth a benchmark.")
    offload = p["mode"] == "offload"
    ssd_gb = max(5, min(20, int(hw["disk_free_bytes"] / GIB * 0.15)))
    glob = {
        "memory_guard_tier": tier,
        "max_concurrent_requests": 2 if ram_gib <= 16 or offload else 4 if ram_gib <= 32 else 8,
        "hot_cache_max_size": "0" if ram_gib <= 24 else "10%",
        "cache_enabled": True,
        "ssd_cache_dir": "~/.omlx/cache",
        "ssd_cache_max_size": f"{ssd_gb}GB",
    }
    cli = (
        f"omlx serve --model-dir ~/.omlx/models --memory-guard {tier} --max-concurrent-requests {glob['max_concurrent_requests']} "
        f"--hot-cache-max-size {glob['hot_cache_max_size']} --paged-ssd-cache-dir ~/.omlx/cache --paged-ssd-cache-max-size {glob['ssd_cache_max_size']}"
    )
    warnings: list[str] = []
    if p["mode"] in ("too_big", "too_big_even_offloaded"):
        warnings.append(
            "Does not fit even at the smallest resident fraction." if p["mode"] == "too_big_even_offloaded" else
            "Does not fit and oMLX cannot offload this model (dense, unquantized or an unsupported family). "
            "Pick a smaller or lower-bit build, or a MoE model."
        )
    if hw["metal_limit_source"] == "estimate":
        warnings.append("Metal working-set limit is an estimate (mlx is not importable); pass --metal-limit-gb or run with mlx for the exact value.")
    if hw["macos"] != "unknown" and int(hw["macos"].split(".")[0]) < 15:
        warnings.append("oMLX requires macOS 15 or newer.")
    if m["model_type"].startswith(("qwen3_5", "qwen3_6", "qwen3_8")) and not hw["xcode_metal_toolchain"]:
        warnings.append(
            "Qwen3.5/3.6/3.8 need oMLX's native custom kernels or they fall back to much slower paths. "
            "No Metal toolchain found: install the official .dmg (kernels precompiled), not brew without full Xcode."
        )
    if "M5" in hw["chip"]:
        notes.append("M5-series chip: qwen35_oq_a8_enabled can speed up prefill but quantizes activations to INT8 (accuracy decision, off by default).")
    optional = []
    if not hw["wired_limit_mb"] and offload:
        mib = hw["ram_bytes"] // 1024**2
        optional.append(
            f"Raising the Metal limit (text only, needs sudo, resets at reboot, can destabilize the Mac): "
            f"sudo sysctl iogpu.wired_limit_mb={mib - max(4096, mib // 4)}. Only worth it if the sweep shows the hit rate is the bottleneck."
        )
    return {"model_settings": model, "global_settings": glob, "cli": cli, "notes": notes, "warnings": warnings, "optional": optional}


def gib(n: int | None) -> str:
    return "n/a" if n is None else f"{n / GIB:.1f} GiB"


def report(hw: dict, m: dict, p: dict, out: dict, name: str, tier: str, context: int) -> str:
    L = [
        f"Hardware: {hw['chip']}, {gib(hw['ram_bytes'])} RAM, macOS {hw['macos']}, {gib(hw['disk_free_bytes'])} free disk",
        f"Metal working-set limit: {gib(hw['metal_limit_bytes'])} ({hw['metal_limit_source']})",
        f"Model: {name} ({m['model_type']}, {m['quant_bits']}-bit, {gib(m['total_bytes'])} total; experts {gib(m['expert_bytes'])}, "
        f"vision {gib(m['vision_bytes'])}, MTP head {gib(m['mtp_bytes'])})",
        f"MoE: {m['num_experts']} experts, top-{m['top_k']}" if m["num_experts"] > 1 else "Dense model (no experts)",
        f"Budget for weights at tier '{tier}', context {context}: ceiling {gib(p['ceiling_bytes'])}, cap {gib(p['cap_bytes'])}, "
        f"KV {gib(p['kv_bytes'])}, transients {gib(TRANSIENT_BYTES)} -> {gib(p['budget_bytes'])}",
        "",
    ]
    if p["mode"] == "resident":
        L.append(f"PLAN: load fully resident ({gib(p['resident_bytes'])}), no offload needed.")
    elif p["mode"] == "offload":
        L.append(
            f"PLAN: MoE expert offload at {p['fraction']:.1%} resident ({p['experts_per_layer']}/{m['num_experts']} experts per layer), "
            f"about {gib(p['resident_bytes'])} resident. Sweep these fractions to pick the fastest: "
            + ", ".join(f"{f:.1%}" for f in p["sweep_fractions"])
        )
    else:
        L.append("PLAN: does not fit.")
    L += ["", "Per-model settings:", json.dumps(out["model_settings"], indent=2), "", "Global settings:", json.dumps(out["global_settings"], indent=2)]
    L += ["", "Start the server with these flags:", "  " + out["cli"], "",
          "omlx_ctl.py start applies the settings above through the admin API (login + session cookie); the API key never goes on a command line."]
    for title, items in (("Notes", out["notes"]), ("Optional", out["optional"]), ("Warnings", out["warnings"])):
        if items:
            L += ["", title + ":"] + [f"  - {i}" for i in items]
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", help="local model directory, or a Hugging Face repo id (owner/name)")
    ap.add_argument("--tier", choices=sorted(TIER_RESERVE), default="balanced", help="oMLX memory guard tier")
    ap.add_argument("--context", type=int, default=32768, help="context window to budget the KV cache for")
    ap.add_argument("--ram-gb", type=float, help="pretend the Mac has this much RAM (what-if)")
    ap.add_argument("--metal-limit-gb", type=float, help="exact Metal working-set limit, if known (mx.device_info()['max_recommended_working_set_size'] / 1024**3)")
    ap.add_argument("--chip", help="override the detected chip name")
    ap.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = ap.parse_args()

    hw = detect_hardware(args)
    config, gen, tensors, name = load_model(args.model)
    if not tensors:
        sys.exit("no safetensors tensors found for this model")
    m = analyze(config, tensors)
    p = plan(hw, m, args.tier, args.context)
    out = propose(hw, m, p, gen, name, args.tier, args.context)
    if args.json:
        print(json.dumps({"hardware": hw, "model": {k: v for k, v in m.items() if k != "text_config"}, "plan": p, **out}, indent=2))
    else:
        print(report(hw, m, p, out, name, args.tier, args.context))


if __name__ == "__main__":
    main()
