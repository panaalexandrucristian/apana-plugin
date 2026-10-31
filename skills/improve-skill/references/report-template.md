# Report template

One JSON object per line. The same fields are in `assets/skill-feedback.yml` (a test compares the two lists). `report.mjs validate` enforces them.

| Field | Values |
|---|---|
| `kind` | `improvement` (change proposed to `SKILL.md` or its description) / `bug` (the skill behaved wrongly) |
| `skill` | after the alias map, e.g. `apana:logic-test-debug` |
| `plugin_version`, `cc_version`, `skill_hash`, `improve_skill_version` | required; a value that could not be determined is `unknown: <reason>`, never omitted |
| `severity` | `blocker` / `major` / `minor` |
| `trigger` | `user-slash` / `claude-proactive` / `after-handoff` |
| `evidence` | `{ records: [digest ids], counts: [{ name, value, label, n }] }`; `label` is `measured` / `calculated` / `guessed` |
| `expected`, `actual`, `proposed_change` | short text, no transcript text on a managed laptop |
| `laptop_class` | `personal` / `gestionat` (no hostname) |
| `status` | `open` / `accepted` / `rejected` / `done` |
