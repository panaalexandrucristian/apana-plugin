# Models that suit oMLX and expert offload

Read this before recommending a model. What was measured on this Mac is in `~/.omlx/skill-state.json` (`omlx_ctl.py status` prints it); this file is the shipped knowledge. Every row says where its claim comes from: **verified here** (run on the user's M3 16 GB with this skill), **oMLX authors** (their PR or README, hardware as stated), **card** (the model's own page, self-reported) or **listed only** (seen in a Hugging Face listing, nothing checked beyond what is written).

State of knowledge on 2026-10-17 (oMLX 0.7.0). Download counts, release names, listings and speeds below are from that day and will go stale; re-check them before relying on them.

## What makes a model good for offload

1. **MoE with few active parameters.** Offload keeps only a fraction of each layer's experts in RAM and reads the rest from SSD, but a token touches only the top-k experts (8 of 256 for Qwen3.6-35B-A3B, about 3B active). A dense model needs every weight for every token, so it cannot be offloaded at all in oMLX and must fit resident.
2. **A supported family.** The offload toggle appears only for `deepseek_v41`, `deepseek_v4`, `qwen4_exp`, `qwen3_5_moe` (Qwen3.5 and 3.6 MoE), `gemma4` MoE, `olmoe`, `glm_moe_dsa`, `glm5_next`. Check `model_type` in the model's `config.json`; `propose_config.py` does.
3. **An MLX-quantized checkpoint** (4-bit or similar, safetensors), not GGUF and not unquantized bf16. 4-bit is the usual sweet spot; a higher-bit build of the same model means more SSD reads for the same fraction.
4. **The non-expert part must fit.** Resident bytes = everything that is not an expert (attention, shared expert, router, embeddings, vision tower, MTP head) + fraction x expert bytes. On a 16 GB Mac the weight budget is about 8 GiB (`propose_config.py` computes it from the memory guard tier, the Metal limit and the KV cache). Qwen3.6-35B-A3B: 2.1 GiB non-expert plus 16.9 GiB of experts.
5. **A fast internal SSD with the free space** for the weights, plus the SSD KV cache (the proposal sets 5 to 20 GB).
6. **Qwen3.5/3.6/3.8 need oMLX's native kernels** (the official `.dmg` has them), and for `qwen3_5_moe` MTP and offload exclude each other.
7. **Free to download:** not gated, not private, a licence you can read on the card (Apache-2.0 for the Qwen builds below).

Expect single-digit tok/s on a 16 GB Mac when most experts live on SSD, with the first request after a restart sometimes slower than later ones. A resident model of the same family is several times faster; the price of offload is speed, not output (the oMLX authors report outputs identical to the fully resident model for Gemma 4 26B at 25% resident; capacity changes the reduction order, so a greedy answer can still differ mid-text while staying semantically equivalent).

## Candidates

| Model | What it is | Status |
|---|---|---|
| `froggeric/Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-4bit` | `qwen3_5_moe`, 256 experts, top-8, 19.0 GiB (experts 16.9, vision 0.8), Apache-2.0, ungated. Uncensored with Heretic: the card reports refusals 83/100 to 10/100, KL 0.0015, MMLU 83.72% to 83.30% (card, self-reported). The card requires the system prompt `You are Qwen, created by Alibaba Cloud. You are a helpful assistant.` and has `<|think_on|>` / `<|think_off|>` toggles and sampling per mode | **Verified here** (2026-10-17, one run each; 12% and 10% were tried too, see the table in `memory-and-offload.md`) on M3 16 GB: offload at 25% resident loads as 6.7 GB under the `aggressive` guard (the `balanced` guard refused it while a browser and an editor were open); about 4 tok/s for 64-token answers with prefill included (3.9, 3.8, 3.9; the first request after a fresh server start was slower: 1.8, then 4.0 and 4.5), 5.7 and 5.9 tok/s for 115 and 131-token answers. At **18.75% resident** (3.40 of 18.12 GB of experts, 5.30 GB loaded) the same 64-token answers ran at 7.6, 7.3, 7.3 tok/s, and a 3195-token prompt with a 142-token answer took 46 s with no memory-pressure event; at 25% one request had been aborted at 8.8 GB of oMLX memory against a hard watermark of 8.7 GB. Thinking mode was not tried |
| `mlx-community/gemma-4-26B-A4B-it-heretic-4bit` | `gemma4` MoE, about 4B active, Apache-2.0 per its listing, uncensored (Heretic) | **oMLX authors** tested Gemma 4 26B-A4B 4-bit: 100% resident 14.2 GB at 122.5 tok/s, 25% resident 4.6 GB at 40.1 tok/s (hardware not stated). Size of this exact upload not checked; on 16 GB it would probably run at a higher resident fraction than the Qwen. **Worth trying next**, unverified here |
| `AEON-7/Gemma-4-12B-it-AEON-Abliterated-MLXFP4` | Small abliterated Gemma, tagged for 16 GB, Gemma Terms of Use (free, with a prohibited-use policy) | **Listed only.** Fits resident without offload; faster, weaker |
| `lukey03/Qwen3.5-9B-abliterated-MLX-4bit` | 9B with no active-parameter suffix in its name, so presumably dense; Apache-2.0 | **Listed only.** Fits resident; faster, weaker |
| `orcarouter/Qwen3.8-27B-Uncensored-MLX` | 27B with no active-parameter suffix, so presumably dense; Apache-2.0; the most downloaded uncensored MLX build in the listing (69k) | **Not for offload** if dense, and about 15 GB at 4-bit (estimate), too big resident for 16 GB |
| Qwen3.8-Flash-Next, DeepSeek-V4.1-Flash, GLM-5.2 | Large MoE models in the oMLX authors' offload tests | **oMLX authors**, 24 to 128 GB Macs; numbers in `memory-and-offload.md`. Not for 16 GB |

## Finding more

    https://huggingface.co/api/models?filter=mlx&search=<heretic|abliterated|uncensored|family>&sort=downloads&direction=-1&limit=30

Take a hit only if `gated` and `private` are false, the licence on the card is readable, `config.json` has a supported `model_type` and `num_experts` above 1 (otherwise it is dense and must fit resident), and the weights are safetensors. Then run `propose_config.py <owner/repo>`: it says resident, offload at which fraction, or does not fit, without downloading weights. Uploads from individual accounts are not reviewed by anyone; do not enable `trust_remote_code`. Blog posts that rank "the best uncensored model" are mostly marketing; this file trusts Hugging Face and GitHub pages and measurements.

## Not known yet

- No sweep over several fractions for any model on this Mac, and no long-prompt time to first token.
- Whether the Gemma 4 26B-A4B Heretic build beats the Qwen on a 16 GB Mac.
- Quality of any uncensored build beyond what the cards report.

When a run settles one of these, `omlx_ctl.py remember` it, and update this file if the repo copy is being edited.
