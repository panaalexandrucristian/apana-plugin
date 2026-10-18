---
name: class-graph
description: "On project-local Kotlin/Java code, with file:line evidence: (1) Kotlin function lines: where a named function starts/ends, its body (function body lines, then Read just that range), a file's function ranges; (2) who uses, calls or depends on a named class, interface, object, top-level function or member: usages, callers, dependencies, change impact, chains between classes. Use it instead of grep/rg or Read for both. Romanian: în ce linii este funcția, unde începe și se termină, arată corpul funcției, cine folosește, cine apelează, ce clase folosesc, unde este folosit, de ce depinde, lanț între clase. Not for reading a whole file, plain edits/renames, literal text (TODO), type/runtime or library questions, other languages. Also /apana:class-graph; out-of-scope requests need clarification."
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/*.mjs *)
---

# class-graph

Three bundled tools answer project-local Kotlin/Java relationship questions and locate named Kotlin functions, with file:line evidence. Needs node 22 or newer; relationship tools also need `rg`. Answer in the user's language. Distinguish direct users from indirect exposure.

## When to use it
Use the table below. Do not start the skill merely to explain/debug code or read a known range. Also not for a plain edit or rename (run it only if the user also asks for users or impact), literal text such as TODOs or resource ids (Grep/rg), or type, runtime or library questions. Mixed request: use it only for the supported part. A bare `/apana:class-graph` (nothing after the command) switches the skill on for the session: say so in one line, in the user's language, and wait; later, in a fix or edit task, find who uses or calls the code you will change (and any function range) with this skill instead of rg, and leave the edit and the reading to Read/Grep. An explicit `/apana:class-graph` request outside this scope: run nothing and ask, in the user's language, "This skill finds project-local Kotlin/Java users and dependencies, or named Kotlin function ranges; which class, function or file should I look up?"

| Question | Tool |
|---|---|
| Who uses/calls a class or top-level function; dependencies, change impact or chains | class-graph.mjs (sections 1-2) |
| A member's users; certain/likely/ambiguous tiers; XML usages; a file's public declarations | find-usages.mjs (section 3) |
| Start/end lines or length of a named Kotlin function; show its body when its range is unknown | find-def.mjs on one .kt file (section 4); then Read only if the body is requested |
| Read a known range or a whole file; explain/debug code; literal-text search; file discovery alone; Java/.kts function ranges | Read/Grep/Glob outside the skill |

Purpose controls routing: member callers go to find-usages; explanation alone does not start the skill; mixed requests use only the applicable parts. File discovery and path policy are those of section 4.

## 1. Run it
Write every command in full as one plain command with literal paths: no `$VAR`, no `$(...)`, no `;`, no `&&`. A pipe into `head`, `grep` or `wc` is fine.

    node ${CLAUDE_SKILL_DIR}/scripts/class-graph.mjs <target> --root <project> [flags]

- `<target>`: a file path (`app/src/.../Foo.kt`), a bare name (class, interface, object, top-level function), or `<File.kt> <name>` for one declaration in a file. A Java class: use its name. A bare name needs no search first: run class-graph with it straight away. `.kts` is not a start file.
- Always pass `--root <project root>`; take it from the session, ask if unclear.
- The default is 2 levels each way. Pass `--down N` / `--up N` only to go deeper or to switch a direction off (`--down 0`, `--up 0`).
- A path suffix (`utilities/CommonUtils.kt`) is NOT accepted. Run one command: `rg --files -g '<FileName>.kt' <project>` (add `| grep <folder>`). One match: use it. Several that the question does not settle: ask the user once with the list; do not inspect the candidates.
- Scope flags only when the question needs them: `--properties`, `--classes-only` (user wants classes without functions).

## 2. Flags by question
| Question | Command tail |
|---|---|
| Who uses X directly | `--up 1 --down 0` |
| What could break if X changes (indirect) | `--down 0` (2 levels up by default) |
| What does X depend on | `--up 0` (2 levels down); directly: `--down 1 --up 0` |
| Both directions | no flags |
| Path A to B (A uses ... uses B) | `A --down 4 --up 0 --out path.txt`, then section 6 |
| Hub users / "how many use X" | start from X: `--up 1 --down 0` |

Deeper than the question needs is waste: the printed list is cut to about the same size.

## 3. find-usages.mjs
    node ${CLAUDE_SKILL_DIR}/scripts/find-usages.mjs <File.kt> [name] --root <project>
Use it instead of class-graph only for a member (function or property inside a class), all public declarations of a file, certain/likely/ambiguous tiers, or XML usages. Keep `--max-hits 200`; a tier at 200 is "at least 200"; do not hunt for more. Its output is NOT cut like class-graph's (it has no `--max-lines`): always append `| head -n 80`, read the tier counts from the first lines, run it once and never repeat the same flags. If the CLI says an output was saved to a file, do not read that file; re-run with the pipe. `--include-private` / `--include-override` only when the question is about them.

## 4. find-def.mjs
    node ${CLAUDE_SKILL_DIR}/scripts/find-def.mjs <File.kt> <name>
Use it for a named Kotlin function's start/end lines, inclusive length, or an unknown range before showing its body. It needs ONE `.kt` file; no Java, `.kts` or project-wide mode. A known range goes straight to Read. Callers/usages go to sections 1-3; explanation alone goes to ordinary search/Read.
- File supplied or established: use it. Basename/suffix: resolve with section 1's `rg --files` rule. Name only: once `rg -n -g '*.kt' 'fun .*\b<name>\(' <project> | head -n 80` (declarations, extension functions included). One file in the printed lines and fewer than 80 lines: run find-def on it. Several files: ask once with the file list; do not inspect them; if the user wants all, one call per file, at most 3. At 80 lines the search may be cut: ask for a file or narrower scope; never infer uniqueness. No match: say "not found by the search", not "does not exist".
- Pass the SIMPLE name (`requestAd`, not `KevelAdView.requestAd`); quote shell-sensitive paths/names. Pass the shortest known literal path valid from the command's current directory: cwd-relative if known, otherwise absolute. Project-relative is valid only from the project root. Never pass an unresolved suffix or add `cd ... && ...`. Output prints the path as typed. For Read, use that path if absolute; otherwise resolve it against the command's current directory to an absolute path.
- Prefer a name. Without one, list functions only when the user asks for a file's function list, and always append `| head -n 80`: `node ${CLAUDE_SKILL_DIR}/scripts/find-def.mjs <File.kt> | head -n 80`. There is no built-in cap. At 80 output lines the list may be cut: say so. If the user wants every function, fetch the next pages with `| tail -n +81 | head -n 80` and `| tail -n +161 | head -n 80` (3 pages at most; then say what was not fetched); otherwise ask for a name to narrow it. Never remove the `head` bound or claim completeness beyond the pages fetched. A pipe can hide the exit status; read the message too.
- Output: `Owner.name path:S-E block|expression|none`. S/E inclusive; S is the `fun` line, not annotations. `none` is a signature with no body. All overloads/same-name matches are listed: report their owners/ranges; select from the question or ask which one before showing a body. Keep local/extension notes.
- Show the range with `Read(file_path=<absolute path>, offset=S, limit=E-S+1)`. Over 250 lines: read consecutive chunks of at most 250 within S-E, only as needed; disclose unread parts. Length is E-S+1 including the signature. A range-only answer needs no Read.
- Exit 1: say "no matching named function found by the tool in this file" ("no named functions found" without a name). Correct a qualified name once to its simple name; otherwise check spelling/file and ask if unresolved. Do not rerun unchanged or claim nonexistence.
- Exit 2: report the diagnostic. Correct a plainly mistaken argument/path once, otherwise stop. Java/.kts go to ordinary search/Read. Never guess a path.
- `brace never closes` means E is end-of-file, not a verified brace. For it or a suspicious expression boundary, inspect a bounded excerpt around the boundary; label the range provisional if unresolved.
- Named functions only: no lambdas, anonymous functions, getters/setters, constructors or `init`. A scan, not a Kotlin parser: unusual layouts or syntax can change or hide ranges. A range does not establish callers, types or completeness.

## 5. Reading the output
- First line `Name [kind] path:first-last` = start node. `Uses (...)` = down, `Used by (...)` = up. `N of M nodes shown` / `N nodes` = size of the walk; nodes of all kinds, functions included.
- Line `  Name [kind] path:line  <- User.kt:12, 40 (+3)`: the path is the node's declaration; after `<-` are the lines in the USER's file that mention it (the evidence); `(+3)` = 3 more lines. Indentation = level; an indented line is reached through the less-indented line above it.
- `~Name` = less sure (same package, wildcard import, several candidates): say "probable".
- `... not shown: N nodes on level L` = output was cut, possibly even at level 1. Never read it as zero or complete.
- `(hub: uses/used by N, not expanded)` = more than 50 neighbours, not walked. Start from it to open it; the start node itself is never suppressed as a hub but can still be line-cut.
- `none` = no edge found by the tool.

## 6. Cut, export, paths, counts
1. Stop if the shown evidence answers the question.
2. If the missing part is behind one node, re-run from that node (`--up 1` or `--down 1`).
3. If hidden evidence is needed (all users, search by name, a path): add `--out result.txt` (current folder; full listing, no cut, hubs expanded; depth limit unchanged). Then `grep -n -F -C 3 '<Name>' result.txt | head -n 30`, `wc -l result.txt`. Never read the file whole; never `--max-lines 0` without `--out`. After one node re-run that did not reveal it, go to `--out`; at most 3 greps.
4. Path A to B: export as in section 2, grep B. Trace by declaration and indentation, not by file name alone (a file can hold several nodes); the `<- X.kt:lines` ending tells which file's class uses it. If a file holds several candidates or ancestors are missing from the grep context, run a one-level query from the candidate. Report the shortest chain you evidenced within 4 levels, one `file:line` per link, never "globally shortest". Stop after 6 calls or 4 levels and say "no chain found within 4 levels", disclosing cuts; never "no path exists".
5. Counting classes: export `--up 1 --down 0` (or `--down 1 --up 0`) with `--out`, count unique non-root `[class]` declarations; do not count repeats. Label interfaces, objects and functions separately; do not fold them into "classes". For a hub, the header's node count is the total of all kinds.

## 7. Cost rules
Text format only (json/mermaid only if asked). For class-graph, keep `--max-lines 150` and `--hub 50`; cache, `--rebuild` and `--out` rules do not apply to find-def. Usually one command after necessary discovery; never repeat the same flags. For relationship answers, read a source excerpt only when a match is uncertain or the user asks to substantiate a break. For requested bodies or uncertain ranges, follow section 4. Reuse the graph cache; `--rebuild` if results look stale after edits. Write only the tool's cache and a file named in the current folder for `--out`.

## 8. Failures
| Seen | Do |
|---|---|
| `neither a file nor a class or function name` | Path suffix: section 1. Name: it may be a member (try find-usages on its file if known) or misspelt; at most one `rg -n -F '<Name>'` over .kt/.java files, then ask for the file or say "not found by the tool"; never say it does not exist or has no users. |
| `declared in N places; pass the file instead` | Decide from the question if it settles it; otherwise ask once with the printed list. |
| find-def exit 1 or 2 | Section 4. |
| Command refused | Retry once as a single literal command; if refused again report the blocker; never change permissions. |
| node older than 22 or missing, script missing; rg missing (class-graph and find-usages; find-def does not need rg) | The first command is the check (no separate version calls). Stop the affected workflow; say exactly what is missing and how to install it (node 22+ from nodejs.org, ripgrep from github.com/BurntSushi/ripgrep, or reinstall the plugin); install nothing; no manual substitute. find-def's own rules are in section 4. |

## 9. The answer
- "Which classes ...": give examples of kind `[class]`. Objects, interfaces and functions are listed separately and labelled, never presented as classes.
- When the user asks for a JSON list of uses: one entry per use or per link, `{"user": the class that does the using, "used": the NAME of the class, function or member used (never true/false), "file": ..., "line": a single number}`. "Show every link" means one entry per link of every chain, from the start class to each result.

## 10. Do not claim
- In class-graph, results are text matches without type inference (`x.name` with an unseen receiver is unresolved). Member functions are not nodes; their class is.
- In class-graph, XML references and typealiases are NOT edges; gitignored or generated files are absent. For API changes or deletions say these were not checked. find-def scans the supplied file; its limits are in section 4.
- Completeness is not proven. Write "the tool found", "at least", "no usage found by the tool"; never "no other usages", "safe to delete", "nothing else breaks"; say "could be affected", not "will break".
- Cite only `file:line` values printed by the tool; never invent chain links. State depth, direction, cuts, hubs and caps.
