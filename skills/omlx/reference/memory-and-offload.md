# Memory guard, budget and MoE expert offload

Source: `omlx/process_memory_enforcer.py`, `docs/experimental/MoE_Expert_Offload.md`, `omlx/model_settings.py`, PR jundot/omlx#2595 (offload, merged 2026-09-11, in 0.7.0). The first measurement table holds the authors' own numbers on the hardware named next to them; none were taken on an M3 with 16 GB. The second table was measured with this skill on the user's M3 16 GB (single uncontrolled runs).

## Memory guard tiers

The memory the tier leaves for the OS and other apps is `clamp(share x RAM, min, max)`:

| tier | share | min | max | 16 GB Mac leaves | 128 GB Mac leaves |
|---|---|---|---|---|---|
| safe | 20% | 6 GiB | 16 GiB | 6 GiB | 16 GiB |
| balanced (default) | 8% | 3 GiB | 8 GiB | 3 GiB | 8 GiB |
| aggressive | 2% | 1.5 GiB | 4 GiB | 1.5 GiB | 4 GiB |
| custom | | fixed 2 GiB reserve, ceiling typed in GB | | | |

Soft watermark (admission pause plus LRU eviction of idle models) at 85/90/95% of the ceiling for safe/balanced/aggressive, hard watermark (in-flight abort) at 95/95/98%. The real ceiling is dynamic (it also reads `vm_stat`), so `RAM - reserve` is the best case. The README's "system RAM - 8 GB" is the balanced maximum, not the 16 GB value.

The dynamic ceiling is what decides a load on a busy 16 GB Mac. Its terms: oMLX's own footprint + free + inactive + file-backed active pages + (0.25 balanced, 0.5 aggressive, 0 safe) x other apps' active memory - the tier reserve. With a browser, an editor and chat apps open, `balanced` measured 3.75 GB although the static ceiling is 13 GB, and the load of a 7.29 GB admission estimate was refused with HTTP 500 ("does not fit under the dynamic memory ceiling"). `aggressive` applied at runtime let the same load through. Closing large apps raises the ceiling the same way.

Weights live in the Metal working set, which is smaller than RAM (about two thirds on a 16 GB Mac; the exact value is `mx.device_info()['max_recommended_working_set_size']`). `iogpu.wired_limit_mb` raises it; it needs sudo, resets at reboot and takes memory from the OS.

## How `propose_config.py` computes the plan

    ceiling = RAM - tier_reserve
    cap     = min(ceiling, Metal limit)
    budget  = (cap - KV(context) - 1.5 GiB transients) x 0.95
    resident if total weight bytes <= budget
    else offload at the largest fraction in [0.75 .. 0.0625] where non_expert + f x expert_bytes <= budget

- Tensor sizes come from the safetensors headers. Expert bytes are tensors under `switch_mlp`, `.experts.` or `block_sparse_moe`, excluding shared experts, MTP and vision. Shared experts, router, attention, embeddings, MTP head and vision tower stay resident.
- KV counts only layers with a growing cache (`layer_types == full_attention`, or every `full_attention_interval`-th layer); MLA models use `kv_lora_rank + qk_rope_head_dim`.
- The lower bound for the fraction is `max(5%, top_k / num_experts)` (a layer cache must hold at least one token's experts). The ladder (75% down to 6.25%) is a search grid, not a measured optimum.
- The context only sizes the KV term: the plan reserves KV for the whole window up front (conservative), `propose_config.py` budgets 32768 unless told otherwise and `start` uses the given or remembered `--context`. The server itself was measured at 4.8 GB right after loading with a 64K window and 4.76 GB with a 128K window, so a window is a limit, not a reservation.
- **Heuristics, not oMLX constants:** the 1.5 GiB transient allowance, the 0.95 factor, the fraction ladder, the Metal-limit estimate when mlx is missing (0.667 of RAM up to 36 GB, 0.75 up to 64 GB, 0.836 above), the max-concurrent and cache-size choices. The oMLX admission estimate can differ and may refuse a load: HTTP 500 "does not fit under the dynamic memory ceiling" is the refusal seen on this Mac, HTTP 507 is documented upstream but was never seen; the sweep is the ground truth.

## What offload does

For a fraction f it keeps f x (experts per layer) in a fixed slot cache per layer and reads the rest from the checkpoint's own safetensors with `pread` on demand, in parallel (12 threads). Routing is unchanged, so output is exact; the cost is latency. A miss evicts the expert with the lowest decayed routing count. Prefill is chunked on expert boundaries so each expert is read at most once per layer per call. Pinning a "hot" subset instead is measured to destroy accuracy (about 91% of GSM8K lost), so oMLX does not do it. On the main branch the server logs `MoE offload: request=<id> hit_rate=... hits=... misses=... fetched=... MB prompt=... output=...` per request while offload is active; 0.7.0 logs none of these (see below).

Supported families (and the toggle shows only for those): `deepseek_v41`, `deepseek_v4`, `qwen4_exp`, `qwen3_5_moe` (Qwen3.5/3.6), `gemma4` MoE, `olmoe`, `glm_moe_dsa`, `glm5_next`; checkpoints must be MLX-quantized with the expected tensor names and shapes. Dense Gemma and other types do not show it. Qwen's gate/up fusion is skipped automatically under offload.

## Measured by the authors (hardware as stated)

| Model | Hardware | Result |
|---|---|---|
| gemma-4-26b-a4b 4-bit | not stated (PR #2595) | 100% resident: 14.2 GB, 122.5 tok/s, TTFT 0.30 s; 50%: 7.8 GB, 59.4 tok/s; 25%: 4.6 GB, 40.1 tok/s, TTFT 9.6 s (0.85 s after the later prefill fix); 12.5%: 3.0 GB, 29.3 tok/s |
| Qwen3.8-Flash-Next oQ4e, 10% residency, 24 GB host emulated | M3 Ultra | decode 6.5 to 8.2 tok/s; TTFT for a 6.2K prompt 47.5 s to 19.7 s after the prefill change |
| Qwen3.8-Flash-Next, experts on a USB4 SSD | M4 Air 32 GB | 18.8% residency: 3.56 tok/s serial, 5.03 with GPU/read overlap (480-token run). Replaying coding-agent sessions: 2.9 to 3.7 tok/s at 18.8% vs 2.6 at 12.5% (lower residency was slower here) |
| DeepSeek-V4.1-Flash oQ3e | M5 Max 128 GB | 12.5%: 5.6 tok/s; 25%: 4.2 tok/s (lower residency was faster here: spare RAM became page cache) |
| GLM-5.2 4-bit | M5 Max 128 GB | 20%: 1.8 tok/s; 12.5%: 1.5 tok/s |

Other reports (not oMLX): mlx-lm issue #1438, Qwen3.6-35B-A3B on a 32 GB Mac, 57.1 tok/s resident vs 10.8 tok/s with a 0.3 offload fraction.

## Measured with this skill (oMLX 0.7.0, 2026-10-17)

Model `froggeric/Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-4bit` (19.0 GiB, vision tower included, 18.12 GB of expert tables), M3 16 GB, macOS 15.5, guard `aggressive`, thinking off, `moe_expert_offload_supported: true`. Decode speed is for 64-token answers with the prefill included, three requests in a row after a fresh server start (the first is the slowest).

| Resident fraction | Experts in RAM | Loaded as | Decode tok/s | oMLX in `top` (compressed) | Other observations |
|---|---|---|---|---|---|
| 25% | 4.53 GB | 6.66 GB (admission estimate 7.29 GB) | 3.9, 3.8, 3.9 | 7.0 GB (2.5 GB) | earlier, 47 and 49 prompt tokens with 115 and 131-token answers: 5.7 and 5.9 tok/s; first three requests after a fresh start: 1.8, then 4.0 and 4.5; one request aborted by the hard watermark (8.8 GB used vs 8.7 GB, dynamic ceiling 8.9 GB) with Teams, VS Code and a VPN open |
| 18.75% | 3.40 GB | 5.30 GB | 7.6, 7.3, 7.3 | 6.0 GB (1.7 GB) | a 3195-token prompt with a 142-token answer took 46 s, no pressure event |
| 12% | 2.19 GB | 4.44 GB | 6.0, 7.1, 7.1 | 4.8 GB (1.55 GB) | system compressor 6.21 GiB, swap 333 MB |
| 10% | 1.84 GB | 4.09 GB | 5.7, 6.5, 6.8 | 4.5 GB (0.4 GB) | system compressor 5.52 GiB, swap 501 MB |

One run per row, taken at different times with different apps open, so this is not a controlled sweep. Differences of about a tok/s between 18.75%, 12% and 10% are inside the noise. What the numbers do show: 25% was the slowest and the only one with a memory-pressure abort. Why (macOS compressing oMLX's memory at 25%) is a guess, not something that was isolated.

The 0.7.0 info log has the `moe expert offload: wrapped N layers at P% residency` line at load, but no per-request `MoE offload: ... hit_rate=` lines were seen, so `sweep_offload.py` prints `n/a` for the hit rate there.

## Not verified here

- No sweep of Qwen3.6-35B-A3B Heretic over several fractions, no long-prompt TTFT, and no run with thinking on. The documented end-to-end checks of the oMLX authors are Gemma 4 26B-A4B and OLMoE.
- Whether a model's vision tower can be left unloaded to save its resident GiB: not checked.
- Whether the HTTP 507 refusal ever happens: only the HTTP 500 form of the refusal was seen.
- What made 25% slower than the lower fractions (memory compression is the suspect, not shown).
- `GET /admin/api/hf/recommendations` and `/admin/api/device-info` return shapes were not inspected.
