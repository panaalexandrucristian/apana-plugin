---
name: variant-check
description: "Before writing or changing code that matches, filters, splits, labels or rewrites lines of text (a regex, a grep pattern, a parser, a classifier, a marker or label matcher over logs, transcripts, JSONL or CLI output), list every distinct variant of the matched token that really occurs in the data, handle each one, and diff the output before and after the change. Ships a script that lists the variants with counts. Use for any such matcher or filter, even a one-line change. Romanian: scrie un regex, un filtru, un parser, potrivire pe text, loguri sau transcript, schimbă un matcher. Not for code that reads no real text data."
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/variants.mjs *)
---

# variant-check

A matcher written from the spec or from a few remembered examples misses variants that the real data has, and tests written from the same examples miss them too. The rule:

> Before writing any matcher or filter over text records, list every distinct variant of the matched token that actually occurs in the real data and handle each one; after the change, diff your output against the old output on real data and explain every difference.

The `claude-auto` wrapper appends this rule to the system prompt of every session it starts (`CLAUDE_AUTO_RULE=off` turns that off); this skill adds the script and the three steps.

## Steps

1. **List the variants.** Run the script on the real files (a folder is searched recursively, binary files are skipped):

       node ${CLAUDE_SKILL_DIR}/scripts/variants.mjs [--top N] [--ignore-case] '<regex>' <path>...

   The regex is JavaScript syntax, written wide enough to catch the whole family (for a label `[tool_result]` use `\[tool_result[^\]]*\]`, not the literal). It prints each distinct matched text once, JSON-escaped so tabs and odd spaces show, with its count and where it first appears. A variant with a count of 1 is still a variant.
2. **Handle each one.** In the answer, one line per variant: handled, or left alone on purpose and why. Do not drop a variant because the spec does not mention it.
3. **Diff before and after.** Run the old and the new code on the same real input, `diff` the two outputs, and explain every difference. An unexplained difference means the change is not finished.

## Limits

- No real data (no sample, no log, no transcript): say so, mark the variant list as unverified and do not invent variants.
- The script lists what a regex matches; it does not tell you what the regex misses. If the pattern is too narrow, widen it and run again.
- A step that did not run is reported as not run, never as done.

## Evidence

MEASURED, one task (a change to a marker matcher, 30 tests as oracle plus output equality with a reference commit), model sonnet-5-5, effort medium. Without the rule, 1 of 2 runs (n = 2) handled `[tool_result]` but missed `[tool_result ERROR]` while all 30 tests passed. With the rule appended to the system prompt, 2 of 2 runs (n = 2) handled both. Too few runs to call it proven. Not tested: other tasks, other models, this skill's own activation. Details: `reference/evidence.md`.
