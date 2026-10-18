# class-graph skill

A Claude Code skill that answers project-local Kotlin/Java users, dependencies and change-impact questions, and locates inclusive declaration/implementation ranges of named functions in one Kotlin file. Three text-based programs are bundled in `scripts/`. `SKILL.md` is what the model reads; this file is for people who maintain the skill. Normal sessions do not read it.

## Requirements

- Node 22 or newer and ripgrep (`rg`). Nothing is installed by the skill.
- `class-graph.mjs` needs nothing else. `find-def.mjs` needs Node 22+ and uses only standard-library modules plus the bundled `definitions.mjs` and `lex.mjs`; it does not require ripgrep. `find-usages.mjs` needs only Node 22 and ripgrep.

## Permissions and paths

`SKILL.md` runs the programs through `${CLAUDE_SKILL_DIR}` (the directory of the skill, filled in by Claude Code before the model reads the text) and declares `allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/*.mjs *)`, so the scripts run without a permission prompt while the skill is active. In a test with the permission for the scripts removed from outside, the programs ran in all eight positive sessions with no refusal. Pipes to `head`, `grep` and `wc` and the rest of a command are not covered by this line.

## Layout

| Path | What |
|---|---|
| `SKILL.md` | frontmatter and instructions |
| `scripts/*.mjs` | the three programs (`class-graph.mjs`, `find-usages.mjs`, `find-def.mjs`) and the modules they import |
| `scripts/test/` | unit tests (including the find-def tests in `definitions.test.mjs`), the activation fixtures (`activation-prompts.json`) and the package checks |

Tool documentation (how the graph is built, the cache, the output cut, measured numbers, limits) is in `private/find-usages/README.md` in the development copy.

## Tests

    node --test skills/class-graph/scripts/test/*.test.mjs

The package checks verify the description length (at most 800 characters), that `SKILL.md` carries no production-process wording, no personal path and no dependency on `private/`, that the import closure of all three programs stays inside `scripts/`, and (when the development copy is present) that the bundled files equal it.

## Keeping the copy in step

The programs are developed in `private/find-usages/`. To refresh the bundle, copy the files again and run the tests:

    cp private/find-usages/*.mjs skills/class-graph/scripts/

The bundle and the development copy are identical. The synchronisation test compares every bundled file and skips itself when `private/` is absent (an installed package); a skipped comparison proves nothing about synchronisation. Re-check the import closure when a module is added.

## Limits

Text matching, no type inference. XML references and typealiases are not edges. Ignored or generated files are not seen. The results are evidence for a reader, not proof of completeness. `find-def` handles named functions in one `.kt` file; it is a scan, not a parser, so unusual expression layouts can affect boundaries. Without a name it has no output cap: `SKILL.md` requires `| head -n 80`. The path is printed as supplied; `none` means a signature without a body.
