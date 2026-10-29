---
name: code-rag
description: "Semantic search over a project's source code by meaning: finds the functions or files that implement a described behaviour when the exact names are unknown (\"where is the price of a cart item computed\", \"which code handles token refresh\"). Hybrid index: Qwen3-Embedding-0.6B + BM25 fused with RRF, AST chunks, resumable and incremental, stored outside the project. Use for vague or conceptual questions on a big codebase, before reading files blindly. Not for known identifiers or literal text (use rg), nor for who-calls-whom in Kotlin/Java (use class-graph). Needs /apana:code-rag-setup once. Romanian: caută în cod după înțeles, unde se face X, ce cod se ocupă de Y, indexează proiectul, rag pe cod."
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/code-rag *)
---

# code-rag

Finds code by meaning. `code-rag search "<question>"` returns the best chunks as `path:start-end` with a snippet; you then Read only those ranges. Answer in the user's language. It installs no hooks.

Run everything through the wrapper `${CLAUDE_SKILL_DIR}/scripts/code-rag` (below: `code-rag`). The project is the git root of the current directory, or `--repo DIR`.

## When to use it
- Use: the question describes behaviour, not a name, and the codebase is too large to read or grep blindly.
- Do not use: a known identifier, string or resource id (rg/Grep); users, callers or impact of a named Kotlin/Java class (class-graph); a file you already know.
- Search results are leads, not proof. Read the returned range before you state anything about the code.

## Steps
1. `code-rag status`. Exit 4 means no index; exit 3 means not installed: tell the user to run `/apana:code-rag-setup`, and stop.
2. No index: `code-rag index --dry-run` prints files, lines and `estimated_minutes` (a calculation from one measurement on an Apple M3, n=1; treat it as an order of magnitude).
   - Estimate up to about 15 minutes: run `code-rag index` (in the background if it may exceed the tool timeout).
   - Longer: tell the user the estimate and that it is a one-off cost, and ask before starting. A very large project (hours) is indexed in slices with `--max-seconds N`; every slice resumes where the last one stopped and a file already stored is never embedded again.
3. `code-rag search "<question>" --k 5` (add `--json` for scripts; add `--no-tests` when you look for the implementation, because test files repeat the same words and can fill the top ranks). Write the question as a description of what the code does, in English when the code is English. Rephrase once if the top results are off, then stop.
4. Read the top ranges with Read (`offset`/`limit` from `start-end`), then answer with `file:line` evidence.
5. If search prints `note: N files changed ... since the last index`, line numbers may have moved: run `code-rag index` (incremental, only changed files) before trusting them.

## Other commands
- `code-rag where` prints the index folder (`$CODE_RAG_HOME/indexes/<repo>-<hash>`, never inside the project).
- `code-rag drop` deletes the index of the project; ask before running it.
- `--ext .xml,.gradle` adds extensions that are indexed as line chunks (no AST). Default: Kotlin, Java, Python, JS/TS, Go, Rust, C/C++, Swift, Ruby, PHP, Scala, C#.

## Exit codes
3 not installed (run `/apana:code-rag-setup`); 4 no index for this project; 5 another `index` is running on it (wait, do not delete anything).

## What to expect
Measured once, on one Android project (dgapp2, 14,335 chunks): MRR@10 0.443 for "KDoc to function" (n=172) and 0.393 for "commit message to changed files" (n=300), against 0.294 and 0.334 for BM25 alone. One repository, one run: a good retrieval aid, not a guarantee that the right chunk is first.
