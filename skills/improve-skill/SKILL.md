---
name: improve-skill
description: "Improve the user's own skills from how they were really used: digest the Claude Code transcripts into per-skill usage records (skill, version, trigger, problem signals), merge them across laptops, and propose evidence-backed changes to a SKILL.md or its description. Reporting is free: local files, an opt-in private GitHub repo, or a Drive/Gmail draft. Use for /apana:improve-skill, 'improve my skills', 'which skills fail or never trigger', 'raport despre skill-uri', 'îmbunătățește skill-urile mele'. Not for writing a new skill from scratch (skill-creator), editing a skill the user already described, or code review."
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/*.mjs *)
---

# improve-skill

Answer in the user's language. Needs node 22 or newer. Nothing leaves the laptop unless the user turned publishing on in `~/.claude/skill-reports/config.json` themselves.

## Steps
1. Digest this laptop: `node ${CLAUDE_SKILL_DIR}/scripts/extract.mjs`. It reads `~/.claude/projects` incrementally and appends to `~/.claude/skill-reports/machine-<hash>.jsonl`. Transcripts older than `cleanupPeriodDays` (30 by default) are deleted by Claude Code, so run it regularly. `--managed` (or `"laptop_class": "gestionat"` in config.json) keeps text out of the digest; `--quotes` adds short quotes and is refused on a managed laptop.
2. Merge: `node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs` writes `merged.json` (per skill: invocations, laptops, triggers, signals, versions). Report how many records have `unknown` fields.
3. Analyse one skill at a time. Give a subagent only that skill's records from the digest and its `SKILL.md`; it returns a synthesis: descriptions that do not trigger, steps skipped, repeated corrections. Group by `plugin_version`/`skill_hash`; a problem seen only in versions older than the installed one is "possibly fixed", not proposed again.
4. Write each finding in the format of [references/report-template.md](references/report-template.md) and check the file: `node ${CLAUDE_SKILL_DIR}/scripts/report.mjs validate <reports.jsonl> --digest <digest>` (rejects missing fields, bad enums, evidence ids not in the digest, unlabelled numbers). `report.mjs dedup <reports.jsonl>` merges the same finding from several laptops.
5. Propose changes only; edit nothing without the user's approval. Label every number measured, calculated or guessed, with n. The "user correction" signal is a guess until measured on a hand-labelled sample. For a description change, a test of about 20 queries (`skill-creator`'s `run_loop`) costs tokens: run it only if the user asks.

## Reporting tiers (all free)
0. Local files (always). 1. Private GitHub repo: `node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs --publish`, only on a laptop whose config has `"publish": true` and `"repo"`; the redaction scan blocks absolute paths, e-mails, tokens (and any quote on a managed laptop); on failure the digest stays local. 2. A Drive folder or a Gmail draft to the user, made by you with the session's connector; same privacy rule. 3. The user copies the digest by hand (the only way to reach the hub from a managed laptop with publishing off).

Never create the repo, push, commit or release without being asked.
