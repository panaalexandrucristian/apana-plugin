---
name: variant-check-trigger
runs: 2
model: haiku
max_turns: 4
timeout_seconds: 120
allowed_tools: [Skill]
---

Before changing a JavaScript regex that matches `[tool_result...]` tags in a transcript, explain the safe workflow. The existing examples are `[tool_result]`, `[tool_result ERROR]`, and `[tool_result ]`.
