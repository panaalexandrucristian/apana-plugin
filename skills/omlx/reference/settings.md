# oMLX settings reference

Source: `jundot/omlx` main on 2026-10-17 (`README.md`, `docs/admin-api.md`, `omlx/settings.py`, `omlx/model_settings.py`, `omlx/admin/routes.py`). Settings are persisted to `~/.omlx/settings.json` (global) and `~/.omlx/model_settings.json` (per model); CLI flags win over the file. The live schema is `GET /openapi.json` and `/docs` on the running server.

Admin authentication differs by version: the docs of `main` say a Bearer key works on `/admin/api/*`, but release 0.7.0 answered 401 to it (while the same key was accepted on `/v1/*`). `POST /admin/api/login` with `{"api_key": "...", "remember": false}` sets the `omlx_admin_session` cookie and worked on 0.7.0. A model load can fail with HTTP 500 "does not fit under the dynamic memory ceiling": see `memory-and-offload.md`. The per-model settings below list no system prompt; a model card's required system prompt goes in the client's request.

## Install and run

| What | How |
|---|---|
| macOS app | `.dmg` from GitHub Releases; ships native kernels precompiled. On this Mac the app's CLI is `/Applications/oMLX.app/Contents/MacOS/omlx-cli` and `~/.omlx/bin/` holds only `omlx-cluster-python` (no `omlx` shim was found) |
| Homebrew | `brew tap jundot/omlx https://github.com/jundot/omlx` then `brew install jundot/omlx/omlx --with-custom-kernel` (kernels need full Xcode + `xcodebuild -downloadComponent MetalToolchain`; without them plain `brew install jundot/omlx/omlx`) |
| Source | `make install` (kernels) or `make install-no-kernels` |
| Requires | macOS 15+, Python 3.11 to 3.13, Apple Silicon |
| Background service | `omlx start` / `stop` / `restart` (brew services; Homebrew install only), default model dir `~/.omlx/models`, port 8000. This skill does not use it: it runs `omlx-cli serve` itself and records the pid and start time in `~/.omlx/skill-server.pid` |
| Foreground | `omlx serve --model-dir ~/models` |
| APIs | OpenAI-compatible at `http://localhost:8000/v1`, Anthropic `POST /v1/messages`, chat UI at `/admin/chat`, dashboard at `/admin` |
| Verify kernels | `python -c "from omlx.custom_kernels import native_kernel_status; print(native_kernel_status())"` (inside oMLX's Python) |

GLM-5.2, MiniMax M3 and Qwen3.5 need the native kernels; without them they silently use much slower paths (README: GLM-5.2 prefill 845 vs ~29 tok/s on an M3 Ultra).

Models: a directory of MLX model subdirectories (`~/models/<name>/`, or two levels `org/name`). The model id in the API is the directory name (or its alias); list ids with `GET /admin/api/models`.

## CLI flags worth knowing

`--model-dir`, `--port`, `--host` (non-loopback needs `--api-key`/`OMLX_API_KEY`), `--api-key`, `--headless`, `--memory-guard safe|balanced|aggressive|off`, `--memory-guard-gb N` (custom ceiling), `--max-concurrent-requests N` (default 8), `--hot-cache-max-size 0|8GB|20%`, `--paged-ssd-cache-dir DIR`, `--paged-ssd-cache-max-size auto|20GB` (auto = 50% of free disk plus existing cache files), `--initial-cache-blocks`, `--mcp-config`, `--hf-endpoint`. `--memory-guard off` cannot be combined with `--memory-guard-gb`.

## Global settings (`POST /admin/api/global-settings`, flat JSON, partial)

Memory and scheduling: `memory_guard_tier` (safe|balanced|aggressive|custom), `memory_guard_custom_ceiling_gb`, `memory_prefill_memory_guard` (bool), `max_concurrent_requests`, `chunked_prefill`, `prefill_priority` (context|speed), `decode_fairness`, `idle_timeout_seconds` (>= 60).
Cache: `cache_enabled`, `ssd_cache_dir`, `ssd_cache_max_size`, `hot_cache_max_size` ("0" disables; "auto" is not accepted), `hot_cache_only`, `hot_cache_write_through`, `initial_cache_blocks` (restart needed).
Defaults for sampling: `sampling_max_context_window`, `sampling_max_tokens`, `sampling_temperature`, `sampling_top_p`, `sampling_top_k`, `sampling_repetition_penalty`.
Security: `api_key`, `skip_api_key_verification` (loopback only), `allow_unauthenticated_inference`.
The response lists `runtime_applied`: the changes that took effect without a restart. Measured on 0.7.0 (2026-10-18): a POST of the plan's `max_concurrent_requests`, `hot_cache_max_size`, `cache_enabled`, `ssd_cache_dir`, `ssd_cache_max_size` and `memory_guard_tier` to a running server answered `runtime_applied: ["memory_guard_tier"]`, so only the guard applied live and the others wait for a restart. `GET /admin/api/global-settings` returns a nested object (`cache`, `scheduler`, `memory`, `network`, ...), not the flat names the POST takes.

## Per-model settings (`PUT /admin/api/models/{id}/settings`, partial; unknown fields are rejected)

- Sampling and limits: `max_context_window`, `max_tokens`, `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `chat_template_kwargs`, `enable_thinking`, `thinking_budget_enabled`, `thinking_budget_tokens`, `reasoning_parser`, `ttl_seconds`, `model_alias`, `model_type_override` (llm|vlm|embedding|reranker|decision), `is_pinned`, `is_default`.
- MoE offload: `moe_expert_offload_enabled` (bool), `moe_expert_offload_resident_fraction` (0 < f <= 1, default 0.25; the dashboard accepts 5% to 95%, fractions like 12.5% allowed). Changing either reloads the model.
- Speculative decoding: `mtp_enabled` (Lightning MTP; qwen3_5*, qwen3_6*, deepseek_v4* need an MTP head in the checkpoint), `mtp_adaptive_max_depth`, `mtp_fixed_depth`, `dflash_enabled` (mutually exclusive with MTP), `vlm_mtp_enabled`. Offload excludes `dflash_enabled` and `vlm_mtp_enabled` always, and `mtp_enabled` except for deepseek_v41, glm5_next, qwen4_exp.
- KV compression: `turboquant_kv_enabled`, `turboquant_kv_bits` (2, 2.5, 3, 3.5, 4, 6, 8).
- Qwen prefill accelerators, all off by default: `qwen35_ane_prefill_enabled` (Apple Neural Engine, adds load time and cache memory), `qwen35_oq_a8_enabled` (INT8 activations; speeds up prefill only on M5 or newer; changes numerics; mutually exclusive with ANE prefill).
- `specprefill_enabled` (experimental sparse prefill for MoE).

The server's own `GET /admin/api/models` entry for a model carries `settings`, `moe_expert_offload_supported`, `mtp_compatible`, `dflash_compatible`, `loaded`, `is_loading`, `estimated_size`.

## Admin API (`/admin/api/...`; on 0.7.0 it needs the session cookie from `POST /admin/api/login`, the docs of `main` say a Bearer key works)

`stats`, `activity`, `logs?lines=`, `device-info` (chip, GPU cores, memory), `models`, `models/{id}/load|unload`, `models/{id}/settings` (PUT), `.../settings/reset`, `.../settings/optimal` (sends chip, memory and model name to omlx.ai), `.../profiles`, `reload` (rescan model dirs), `hf/search`, `hf/model-info`, `hf/recommendations` (oQ builds that fit this Mac's memory guard and Metal limit), `hf/download`, `hf/tasks`, `bench/start` + `bench/{id}/results` (throughput), `ssd-cache/clear`, `hot-cache/clear`, `server/restart` (only under a supervisor). Long tasks return an id; poll the matching results endpoint.
