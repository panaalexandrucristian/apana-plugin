---
name: scope
description: "Use when the user asks to change code but wants strict scope: no extra files, tests only for behavior changed by this task, investigate resolvable repository questions before asking, and ask the user about intent rather than inventing requirements. Romanian: doar modificarea cerută, nu face nimic în plus, teste numai pentru comportamentul schimbat."
---
# scope

This skill is for normal Claude sessions with the Apana plugin enabled. It does not start a separate launcher.

Activate the gate in the user-visible session:

```text
/apana:scope <the requested coding task>
```

The session becomes investigation-only. Continue Read, Glob and Grep while a question can be resolved from the repository. Do not infer user intent: when it cannot be determined from the code, use `AskUserQuestion`; only edits that depend on that answer stay blocked.

When the smallest exact production-to-test proposal is ready, write only the JSON proposal path supplied by the hook. It must have this shape:

```json
{
  "production_changes": [{"path": "src/example.js"}],
  "test_changes": [{"path": "test/example.test.js", "production_paths": ["src/example.js"]}],
  "test_commands": ["npm test -- test/example.test.js"]
}
```

Show the user the proposed paths and wait for their explicit nonce approval:

```text
/apana:scope approve <nonce>
```

After approval, edit only the listed paths and tests for the production behavior changed by this task. Those focused assertions are within scope, not an expansion. A newly discovered file, a behavior outside the approved task, broad cleanup, coverage work, dependency/documentation change, or test for untouched behavior needs a new scope request and approval. Bash is permitted only when the command exactly matches an approved `test_commands` entry. Supported forms are `node --test <files>`, `python[3] -m unittest|pytest <targets>`, `pytest <targets>`, `npm test -- <targets>`, and `./gradlew :module:testVariantUnitTest --tests Class`. Arbitrary executable code, shell syntax, MCP and subagents remain blocked. Test runners execute project code without an OS sandbox; exact command approval is not a guarantee of side-effect-free execution.

Before approval, explain the intended production behavior and why each proposed test covers that changed behavior. The hook validates declared paths, not semantic relevance: it cannot prove that a mapped test is related or prevent unrelated edits inside an approved file. User review remains necessary.

Limits: preexisting symlinks are rejected, but path checking and later tool execution are not atomic; concurrent replacement by another local process is outside the guarantee. Hooks gate Claude tools but do not sandbox the OS or control processes launched outside Claude. `@file` prompt references are not Read tool calls. A timeout, managed policy that disables plugin hooks, or a tool unknown to the hook can weaken coverage; report that instead of claiming isolation.
