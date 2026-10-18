# find-usages

Where are the classes and functions of a Kotlin file used? A text-based "Find Usages" for `.kt`, `.java` and `.xml`. Node 22 and ripgrep (`rg`) only; not part of the published package.

```sh
node private/find-usages/find-usages.mjs <File.kt> [name] [--root <dir>] [--stats] [--json]
```

- No `name`: every public declaration of the file. With `name`: only that one.
- `--root` defaults to the nearest parent with `.git`.
- `--include-private`, `--include-override`: also search those declarations (off by default).
- `--max-hits <n>` caps the hits kept per symbol and tier (default 200).
- Tests: `node --test private/find-usages/test/find-usages.test.mjs`.

## How it works

1. `kotlin-symbols.mjs` reads the file's package, imports, declared symbols (top-level and members) and, for every class, its supertypes and line range.
2. `scan.mjs`: one ripgrep pass lists the files that contain any of the names. `usages.mjs` reads each of them once, blanks comments and strings (`lex.mjs`, keeping `${...}` and `$name` of string templates), and finds the whole-word matches.
3. `hierarchy.mjs` finds the **family** of every class that owns a searched member: the class and all project classes that extend or implement it, directly or through others (Kotlin and Java).
4. `rules.mjs` puts each match in a tier:
   - **certain**: an import, a qualified name, `Owner.name`, the declaring file, or a call without a receiver inside a class of the family.
   - **likely**: same package, wildcard import, an XML `onClick`, an explicit receiver in a file that mentions the owner or one of its subclasses.
   - **ambiguous**: a member whose receiver type cannot be seen (`x.name`).
   - **other** (counted, not listed): a same-named symbol from another package, a call without a receiver in a class outside the family, another declaration of the name, a named argument, an XML resource name.

## Measured (dgapp2-android: 1205 `.kt`, 180,362 lines)

0.17 s for all files (0.31-0.36 s before the optimization round below); 10,969 functions (9,048 block, 702 expression, 1,219 none); no failure and no unclosed brace. Every one of the 9,312 functions that `kotlin-symbols.mjs` lists was found. The tool finds 1,620 more: 274 with backtick names (the symbol reader cannot read them), 37 local ones, and members of anonymous objects and of classes whose constructor starts on the next line.

## Optimization round (2026-10-11)

16 numbered experiments, each a proposal, a test and a verdict; a variant was kept only when it beat the current best in interleaved runs, one fresh process per run, medians of 5-9. Gate for every candidate: the 99+ tests, identical results to the first version on 2,713 comparisons, `blankNoise` byte-identical to the original in all four option combinations on 6,476 inputs, and for the name search every name of every file equal to the filtered full list (10,434 queries).

| Result vs the first version | Time | Memory |
|---|---|---|
| 2M-line source in one string | 648 -> 406 ms (-37%) | +448 -> +232 MB (-48%); RSS of one pass 780 -> 561 MB |
| the 1,205 files, one call each | 71 -> 52 ms cold (-27%), 45 -> 29 ms warm (-35%) | 35.5 -> 37.3 MB (+5%, within the spread) |
| search by name over the 1,205 files | 194 -> 51 ms (-74%) | -34% |
| search by name in the 2M-line source (3 names) | 1,922 -> 810 ms (-58%) | +745 -> +298 MB (-60%) |
| the command on one file | unchanged (4.6-10 ms above an empty Node script; 40-47 MB RSS) | unchanged |

Kept: the lexer writes into a Buffer instead of joining millions of pieces; brace matching with two `indexOf` pointers instead of `exec`; line numbers counted from a cursor instead of a table; `test()` + `lastIndex` instead of `exec()` in the lexer; no `delete` on results and the owner name cached per scope (the biggest memory cut: dictionary-mode objects); character tests by code instead of a Unicode regex (-14% time); a `source.includes(name)` prefilter; skipping bodies and classes that do not mention the searched name.
Rejected after measuring: flushing the lexer pieces every 64K (+16% memory), keyword search with `indexOf` or `Buffer.indexOf` (+20-30% time against one regex), `module.enableCompileCache()` and hand-made argument parsing for the command (inside the noise), a table of brace matches (the text is scanned only 1.3x), stop search by a byte loop (slower; five `Buffer.indexOf` pointers were 34% faster for that step alone, about 3% overall, not worth the rewrite).
Techniques tried came from: table-driven loops against sticky regexes (moo, css-parser PR 279), the V8 preparser (skipping bodies), single-pass bracket matching (clangd `Bracket.cpp`), SIMD substring search against Aho-Corasick (the `aho-corasick` crate notes), and V8 string internals (external and sliced strings).

**Retention.** The names in the results are substrings of the source, and V8 shares the parent of a substring of 13+ characters: keeping the 120,659 results of the 2M-line source after dropping the text keeps ~209 MB alive. Copying the names cut that to ~49 MB, at +2% time and +9 MB peak, so it is not done by default; a caller that keeps results for long should detach them (`structuredClone(results)`: checked, the source is freed; ~110 ms for the 120,659 results).

## Known limits

- No type inference: `x.name` stays ambiguous unless the file mentions the owner or a subclass. Generated code ignored by `.gitignore` is not searched.
- Enum entries, destructuring, local variables, annotations and data-binding variables of XML layouts are not symbols; Kotlin `.kts` and Java as a starting file are not supported.

# class-graph

The dependency graph around one class or function: what it uses (down), who uses it (up), each to a depth limit, with the file and lines of every use. Deterministic, same requirements as find-usages.

```sh
node private/find-usages/class-graph.mjs <File.kt | Name> [name] [--down 2] [--up 2] [--format text|mermaid|json] [--root <dir>] [--max-lines 150] [--hub 50] [--out <file>] [--no-cache | --rebuild | --clear-cache] [--stats]
```

- `<File.kt>` starts from the classes of the file (or, with `name`, from the declarations of that name in it); a bare `Name` is looked up in the whole project and asks for the file when it is declared twice.
- Nodes are classes, interfaces, objects (nested ones as `Outer.Inner`) and top-level functions (`--classes-only` drops the functions, `--properties` adds top-level properties). Java classes are nodes too. Functions inside a class are not nodes; the class is.
- An edge `A -> B` means a name in the code of A (its class body or function body, header and annotations included) resolves to B: same file, explicit import, `Owner.Inner`, a fully qualified name, same package or a wildcard import (`~` = less sure: same package, wildcard import, or several candidates such as overloads). Names that are not in code (comments, strings, imports), members that shadow a function, named arguments and `x.name` calls that are not extension functions are ignored.
- Each edge lists the lines of the user's file, so every printed line reads `Name [kind] path:line <- User.kt:12, 40 (+3)`.
- `--down` and `--up` default to 2 levels each way (they were 5 until the levels test below; with the 150-line cut, 3 and 5 levels print the same list for large classes). The graph itself has no node limit (`--max-nodes` sets one); what is printed is limited, see below. Mermaid and JSON carry the same graph.

## What is printed

Five levels in both directions reach most of a project, and the full listing is megabytes. To keep what a reader (a person or a model) has to read small, the printout is limited and the complete listing goes to a file on request:

- **Line budget** (`--max-lines <n>`, default 150, `0` = all): the walk is cut at whole levels, nearest first. Each direction keeps the deepest level that fits in its half of the budget, and a direction that needs less leaves the rest to the other. If level 1 alone is larger than its room, its first edges are printed. Every edge is one line, so the count is exact; what was left out is said as nodes per level (`... not shown: 105 nodes on level 2, ...`). The cut applies to text, Mermaid and JSON (JSON has a `cut` object).
- **Hubs** (`--hub <n>`, default 50, `0` = off): a node, other than the one you start from, with more than n neighbours in the direction of the walk is printed on one line with `(hub: uses 75, not expanded)` and is not walked through. To open one, start from it: `class-graph.mjs UserSessionManager --down 1`.
- **Full listing** (`--out <file>`): writes the walk with no budget and no hub limit to the file, in `--format`, and prints its path and line count. It is the same text as `--max-lines 0 --hub 0` (a test checks this), so `grep` on the file answers "who else uses X?" without reading it.

Measured on dgapp2-android, 5 up and 5 down. Tokens are characters divided by 2.8, the ratio measured on the 2.6 MB listing below (934,099 input tokens for 2,613,282 characters); for the other rows it is a calculation, not a count.

| Start | Before: lines, characters, ~tokens | Now: lines, characters, ~tokens |
|---|---|---|
| `GuestShoppingListObservables` | 14,531 / 2.43 M / ~870,000 | 110 / 17 K / ~6,200 |
| `ShoppingObservables` | 15,478 / 2.61 M / ~930,000 (measured 934,099 with a short prompt) | 103 / 16 K / ~5,600 |
| `UserSessionManager` | 17,863 / 2.88 M / ~1,030,000 | 162 / 26 K / ~9,400 |

Five Haiku 5.5 sessions (headless, one tool, a sandbox, one task each, 2026-10-10) used the tool through the cut output: 0.0024-0.0086 USD per session (0.0200 in all), 1-3 calls, 3-35 K characters of tool results, and every `file:line` they gave was a real line mentioning the class they named (32 of 32; this checks the lines, not that the lists are complete). The same question as session 1, with the whole uncut listing sent in the prompt of one more Haiku session, cost 0.937 USD for one turn (934,099 input tokens, about 280 times session 1's 0.0033 USD) and was answered correctly too. n=1 per task, one model, one project.

How many levels by default (Haiku 5.5, 39 sessions, 2026-10-10: default of 1, 2 or 3 levels each way, 7 tasks that name no level, tasks 5-7 three times each; the model could still pass `--down`/`--up`): every one of 318 `file:line` links given was real (line mentions the class, edge exists in the graph). Tasks complete: 12 of 13 at 1 level, 13 of 13 at 2, 13 of 13 at 3 (one rule for task 6 was loosened after the first round and applied to all three; with the strict rule it is 11, 11, 13). Mean cost per session 0.0076, 0.0068, 0.0084 USD; mean calls 3.2, 2.5, 4.8; one session at 3 levels used 21 calls and 0.032 USD, which alone explains the gap to 2 levels. With the 150-line budget, 3 and 5 levels print the same list for large classes (offline: 110/103/162/157 lines at both), 1 level prints 36-160 lines and 2 levels 102-162. The differences between the three are within the noise of this size of test; the only incomplete session at 1 level also had a refused command.

The cut is a choice of the printout, not of the analysis: the cache and the graph are unchanged.

## Cache

The graph is cached on disk and brought up to date on every run, so a repeated query on a big project does not read the whole project again.

- **Where:** `~/.cache/find-usages/<hash>.json` (`$FIND_USAGES_CACHE_DIR` or `--cache-dir` change it); one file per project root and option set (`--classes-only` and `--properties` have their own), outside the repository. `--no-cache` ignores it, `--rebuild` writes a fresh one, `--clear-cache` deletes it and stops. `--stats` prints `cache: hit | updated | miss | off`.
- **How it notices changes:** each run lists the `.kt` and `.java` files (ripgrep, ignore files respected) and compares the mtime and size of each with the cache. Editing a class, `git switch`, `git pull`, `git stash`, a rebase or a merge all rewrite files, so all of them show up; git itself is not needed.
- **What it redoes:** files that changed, appeared or disappeared are read again, and so is every other file that mentions a name whose declaration changed (found with ripgrep): a new class can make a name in an untouched file resolve, a removed one can break it. Tests check that the updated graph equals a full rebuild after edits, new and deleted classes, a package change, and a real branch switch there and back and a real `git pull`.
- **When it starts over:** the code that builds the graph changed (hash of `graph.mjs`, `kotlin-symbols.mjs`, `lex.mjs`), the options differ, the cache file is damaged, or its edges point at nodes that no longer exist.
- **Several runs at once:** any number of sessions may read the same cache. Reading takes a shared lock; swapping in a new cache file after a build and `--clear-cache` take an exclusive one: they wait for the reads in progress, keep new reads waiting, and only then replace or delete the file. The lock is the folder `<hash>.json.lock/` next to the cache file (`cache-lock.mjs`, stdlib only). The lock of a process that is gone, or older than 2 minutes, is removed by whoever finds it. A run that cannot get the lock within 30 s works without the cache and does not save one; `--clear-cache` then says the cache is in use. The file was never half-written even before the lock (temporary file and rename), so the lock orders a clear against the reads rather than repairing a fault.
- **Not noticed:** a file rewritten with the same size inside the same millisecond as before, and files hidden by `.gitignore`. `--rebuild` fixes the first.

Measured (dgapp2-android, and 11 renamed copies of it as a stand-in for a 2M-line project; the copies are one app, so real code may differ):

| Project | Files, lines | Nodes, edges | Run | Time | Memory |
|---|---|---|---|---|---|
| dgapp2-android | 1221, 181K | 3204, 14.5K | no cache | 0.66 s | 140 MB |
| 11 copies | 13431, 2.0M | 35K, 160K | first run (writes a 35 MB cache) | 4.9 s | 411 MB |
| 11 copies | same | same | nothing changed | 0.36 s | 236 MB |
| 11 copies | same | same | one file edited | 0.45 s | 274 MB |

Parallel check (dgapp2-android, 7 processes at once: 4 reads, 2 `--clear-cache`, 1 `--rebuild`): all exit 0 and print the graph of a run without cache; a run with a warm cache takes 46 ms, a cold one 376 ms. Two processes that find the same stale lock at the same instant can remove each other's fresh marker (a small window; the cache file itself stays whole).

Limits: no type inference (a name is matched, not a variable's type), typealiases and XML references are not edges, and a few hub classes (`UserSessionManager`, `CommonUtils`, `AdobeLoggingUtils`) pull hundreds of nodes into a 5-level walk; they are not expanded by default (`--hub`).

# find-def

At which lines is the implementation of a function? For a Kotlin file, the line of the `fun` keyword and the last line of the body, per function.

```sh
node private/find-usages/find-def.mjs <File.kt> [name] [--json]
```

```
UserRepository.getUser  app/UserRepository.kt:12-15  block
UserRepository.count    app/UserRepository.kt:17-17  expression
```

- No `name`: every named function of the file, in file order. With `name`: the functions of that name (overloads, same name in other classes, local functions), each with its owner. Exit code 1 when there is none, 2 for a bad argument or an unreadable file.
- `body` is `block` (`{ ... }`), `expression` (`= ...`) or `none` (abstract, interface, `expect`, `external`; then the range is the signature). `--json` adds `bodyStart` (the line of the `{` or `=`), `receiver`, `local`/`parent` (a function inside another one) and `unclosed` (a brace that never closes; `end` is then the last line).
- `start` is the line of `fun`, not of the annotations above it. A companion object's members belong to the enclosing class. Anonymous functions, getters and setters, constructors and `init` blocks are not reported.
- Module: `definitions.mjs` (`findDefinitions(source, name?)`), tests in `test/definitions.test.mjs` (36), which also cover the `$$"..."`, mask and `exact` modes added to `lex.mjs`.

## How it works

`lex.mjs` masks comments and strings (`marks: true` keeps where a string starts and ends; the result is written into a Buffer copy of the source, so only the noise is overwritten). A scan then finds each `fun`, reads the signature (type parameters, receiver, name, balanced parameters, return type, `where`) and decides the body by the first `{` or `=` after it. A block ends at its matching `}`. An expression ends at the end of its last token, going on over a newline when the next line starts with `.`, `?.`, `?:`, `&&`, `||`, `as`, `else`, `catch`, `finally` or `{`, or the line ends with a binary operator, `else`, `try`, or an `if (...)`, `for (...)`, `while (...)`; a line starting with `+`, `-`, `*`, `..` or `(` is a new statement. The rules come from the Kotlin grammar (`KotlinParser.g4`) and the language documentation. With a `name`, a function or class whose text does not contain the name is skipped whole, like a preparser skips a body.

## Measured (dgapp2-android: 1205 `.kt`, 180,362 lines)

0.36 s for all files; 10,969 functions (9,048 block, 702 expression, 1,219 none); no failure and no unclosed brace. Every one of the 9,312 functions that `kotlin-symbols.mjs` lists was found. The tool finds 1,620 more: 274 with backtick names (the symbol reader cannot read them), 37 local ones, and members of anonymous objects and of classes whose constructor starts on the next line.

## Known limits

- A scan, not a parser: an expression body is cut at the end of its last token by the newline rules above, which is right for formatted code; unusual layouts can differ.
- Not read: a receiver of function type (`fun (Int).foo()`), a backtick name containing `(` or `)`, delegation by an expression with a lambda in a class header.
- Kotlin only (`.kt`); no Java, no `.kts`.
