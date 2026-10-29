---
name: code-rag-setup
runs: 2
model: haiku
max_turns: 6
timeout_seconds: 120
allowed_tools: [Read, Glob, Grep, Skill]
---

I want to search this project's code by meaning with code-rag. Install the dependencies it needs on this laptop (no hooks, it is a managed machine). Use the project skill if appropriate.
