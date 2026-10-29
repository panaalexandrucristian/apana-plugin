---
name: code-rag-setup
description: "Installs or checks the dependencies of the code-rag skill (semantic code search with Qwen3-Embedding-0.6B + BM25): a pinned Python 3.12 venv made with uv under ~/.cache/code-rag and the model weights in the Hugging Face cache. Use when the user wants to set up, install, repair or check code-rag, or when code-rag exits with code 3 (not installed). It installs no hooks and changes no settings, so it works on a managed laptop. Romanian: instalează dependințele pentru code-rag, pregătește rag-ul de cod, verifică instalarea."
allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/setup.py *)
---

# code-rag-setup

Prepares the environment that `code-rag` needs. One command, nothing else is touched: no hook, no settings file, no shell profile. Answer in the user's language.

## What it creates
- A Python 3.12 venv in `$CODE_RAG_HOME` (default `~/.cache/code-rag`), with the versions pinned in `scripts/requirements.txt` (the ones the retrieval was measured with).
- The `Qwen/Qwen3-Embedding-0.6B` weights in the Hugging Face cache (`HF_HUB_CACHE`, else `~/.cache/huggingface/hub`). Installation reuses cached weights but may still contact Hugging Face.

## Steps
1. Check first, it changes nothing: `python3 ${CLAUDE_SKILL_DIR}/scripts/setup.py check --json`. Read the JSON `ready` field: the check's exit code alone does not mean the installation is ready. If `ready` is true, say so and stop.
2. Otherwise preview the plan: `python3 ${CLAUDE_SKILL_DIR}/scripts/setup.py install --dry-run`. Then run `python3 ${CLAUDE_SKILL_DIR}/scripts/setup.py install`. It downloads packages and the model, so it needs network and may take minutes; run it in the background if the tool call would time out.
3. Run the check again and report its `ready`, `missing`, `wrong` and `model_cached` fields. Device and embedding dimension come from the install result's `smoke` object, not from `check`. When ready, tell the user to use `/apana:code-rag` (or just ask a code question).

## Exit codes and errors
- Exit 3, `uv_missing`: `uv` is not installed. Tell the user to install it (`brew install uv`) and run this skill again. Do not install it yourself.
- `step_failed`: the JSON names the step and its exit code; stderr is separate command output. Show the JSON and available stderr; do not retry the same step unchanged more than once.
- `install --skip-model` installs only the venv (use it when the weights are copied by hand).

## Rules
- Do not edit `scripts/requirements.txt` to "fix" a failure: the pins are the measured environment. Report the conflict instead.
- Do not write to `settings.json`, `hooks`, `~/.zshrc` or any gradle file.
