---
name: compact-handoff
description: "Make a compact handoff of the CURRENT session, or of a NAMED OpenCode session (\"handoff of the OpenCode session X\"), so a new session can continue from it: one command writes HANDOFF.md and blobs/ with the full text of the long tool calls. Use whenever the user asks to write, prepare, make, update or redo a handoff, handover, CONTINUE-HERE note or notes for the next session (Romanian: \"fă un handoff\", \"handoff la sesiunea asta\", \"fă handoff la sesiunea X din OpenCode\", \"scrie handover-ul\", \"pregătește nota pentru sesiunea următoare\", \"mai fă o dată handoff\"). Not for delegating a task to another agent (\"hand off this task to ...\"), explaining the word, README/changelog/release notes or ordinary summaries. Runs in Claude Code and in OpenCode."
allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py *)
---

# compact-handoff

Turns the transcript of the current session, or of a named OpenCode session, into one folder that a new session reads, with a byte-for-byte check. Nothing is summarised by hand and nothing leaves the machine. Reply to the user in Romanian, short and plain.

## Steps

Write every command in full as one plain command with literal paths: no `$VAR`, no `$(...)`, no pipes.

1. **Get a marker** for this session; it prints one line, copy it:

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --marker

2. **Choose the skills to load again, then make the handoff.** First list what this session loaded (in an OpenCode session this prints `skills loaded: none`; skip the choice then):

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --current "<the printed marker>" --list-skills

   If it printed `skill:` lines, show them to the user (Romanian, short): each name with its size in characters and the total, and ask which of them the new session should load again (all, some or none), because each load puts that text into the new session's context. Ask at every handoff; an earlier answer does not carry over. If the user's request already says which skills (or none), use that and do not ask. Then make the handoff with that exact marker (the script finds the current transcript by it and refuses unless exactly one recent transcript contains it):

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --current "<the printed marker>"

   Add the choice to that command: `--skills name1,name2` for some (the whole names exactly as listed, only commas between them), `--no-skills` for none, nothing for all. Options, only when the user asks for them: `--keep` (durable folder `~/.claude/handoffs/` instead of `/tmp`), `--cut` (one `.md` file without blobs; the long tool records are cut and the rest is not kept), `--no-readonly`, `--with-subagents`, `--no-goal` (do not carry an active `/goal`). A folder given as the last argument replaces the default one.
3. **Tell the user** (Romanian, short): the start command exactly as printed (`claude "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`), the sizes from the printed line (original characters, `HANDOFF.md` characters and percent, number of blobs), whether a parent handoff was found and copied, and that the folder is temporary unless `--keep` was used. Say that the transcript ends before the current reply.

   If the script printed an `active goal:` line, a `/goal` is still running in this session and it prints two start commands: the plain one and, as the LAST line, `claude '/goal …'`, which starts the new session with the same goal set (Claude Code runs a prompt that starts with `/goal` as the command). Give the last one as the start command, show the plain one only if the user does not want the goal, and say: the condition is carried as it was; the goal of THIS session stays active until the user types `/goal clear` here, so two sessions do not work on it at once. If the script printed that the goal is too long for the command, give the plain command and say that the new session will print the `/goal` line to type.

   If the script printed a `skills to reload:` line, the skills this session loaded (a Skill tool call or a slash command; never compact-handoff itself) are listed in the handoff, and the new session loads them again with its Skill tool before it answers, so that their instructions are in its context. Name them to the user with the size from the line: each load puts that text into the new session's context. Without a choice made in step 2 every loaded skill is listed; `--skills` keeps only the named ones and `--no-skills` leaves them all out. The transcript keeps only a marker for the text of a loaded skill, so without this the new session would not have the instructions.

## A Claude Code session given by id

When the user gives the id of a Claude Code session to hand off, do not use `--marker` or `--current`: the id takes the place of the marker.

- List what that session loaded with `python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py <id> --list-skills`, then choose the skills as in step 2.
- Make the handoff with the same command without `--list-skills`, adding `--skills name1,name2` for some or `--no-skills` for none (nothing for all).
- Tell the user as in step 3, but do not say that the transcript ends before the current reply: say that the session may still be running, so the handoff is a snapshot of that moment.
- If the script prints `0 transcripts found`, no transcript has that id: report that error and stop; do not try another id.

## În OpenCode

When this skill runs inside an OpenCode session, the two steps above are the same. What differs:

- If `${CLAUDE_SKILL_DIR}` is not replaced by a path in the commands above, use as the skill folder the folder printed after `Base directory for this skill:` when the skill was loaded, and write the commands in full with that literal path.
- Step 1 (`--marker`) prints the marker; step 2 runs `--current` with that marker. `--current` searches the Claude Code transcripts and OpenCode's own database (`$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db`; `--opencode-db` names another file) and refuses unless exactly ONE session across both contains the marker. The folder is built from that OpenCode session.
- If `--current` stops with an error about the OpenCode database (it exists but cannot be read), first report that error to the user, in Romanian, short. Only after that run the same `--current` command again with `--no-opencode`, which skips the OpenCode search so that the Claude Code transcripts alone decide.
- In step 3 give the start command exactly as printed: `opencode --prompt "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`, with the sizes as before. Also say that the handoff of an OpenCode session leaves out the model's reasoning, that the `recent` text of each compaction and every image are in blobs, and that images are not scanned for secrets.
- The skill choice of step 2 does not apply: an OpenCode session lists none (`--list-skills` prints `skills loaded: none`, and `--skills` is refused).
- `--cut` and `--with-subagents` do not apply to an OpenCode session. Sessions kept only in OpenCode's legacy tables are not supported.

## A named OpenCode session

When the user asks for the handoff of an OpenCode session named by title, id, folder or "the last one", do not use the marker:

1. **List**:

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --list-opencode --match "<a distinctive part of the title, id or folder the user gave>"

   Leave out `--match` for "the last one" with no name. The lines are newest first; the last line names the database. If nothing fits, list once more with a shorter `--match` or without it.
2. **Choose.** Take the line the user's words point to; "the last one" or "where work was done last" is the first line that fits, because the list is newest first. A title ending in `(fork #n)` is a fork: skip forks unless the user asks for one. Only if the user's words still fit more than one line, show those lines (id, date, title) and ask which one.
3. **Make the handoff**:

       python3 ${CLAUDE_SKILL_DIR}/scripts/make_context.py --opencode ~/.local/share/opencode/opencode.db --session <ID>

   (or the database named on the last line of the list, if it differs)
4. **Tell the user**, in Romanian, short: the start command exactly as printed (`opencode --prompt "..."`); that the same folder works in Claude Code as `claude "Citește <path>/HANDOFF.md și urmează instrucțiunile din el."`; the sizes and the OpenCode notes as in "În OpenCode"; that the session may still be running, so the handoff is a snapshot of that moment.

Do NOT use `sqlite3` and do NOT write SQL on the database: use only the commands of this skill.

## Rules

- Do not read `HANDOFF.md` or the blobs into this conversation, do not paste them, and do not rewrite the session by hand. The file is for the next session.
- If the script fails, show the error and stop. No manual fallback and no other tool in its place.
- If this session itself started from a handoff, the script finds that parent (a `Read` of a `/tmp/handoff-*` file among the first tool calls) and copies it whole into `parents/`. Mention it; do nothing else.
- Never delete a `/tmp/handoff-*` or `~/.claude/handoffs/*` folder without asking. Before even proposing it, check whether a recent session still refers to it (`grep -l <folder name> ~/.claude/projects/*/*.jsonl`) and say so. A running session keeps old paths as text and cannot reopen a deleted folder.
- The script checks its own output. Do not add a Jev or `handoff-verify` pass on top of it.

## What the script does (so you can answer questions)

- `parent_copy.py` discovers the complete parent graph before copying. Ancestors are siblings in one storage folder rather than recursively nested; name collisions get bounded aliases. Only introduction links change: transcript bodies, blobs and auxiliary files keep their bytes. Hidden `.handoff-parent-storage*.json` indexes retain unlinked auxiliary data when a saved parent is reused; move or copy the entire storage folder, including these indexes.
- Existing output is reused only after full payload comparison; conflicting or partial copies are left untouched. A missing top-level parent is reported explicitly. Missing canonical ancestor links, malformed handoffs/indexes, cycles, symlinks (except macOS system `/tmp` and `/var` aliases), special files and overlapping source/output are rejected. Traversal is limited to depth below 256 and at most 10,000 graph entries. Legacy descriptive examples that are not provenance can remain unverified and produce a warning; `roundtrip IDENTICAL` alone verifies the current transcript, not its ancestral graph.

- `prepare_all.py` runs the `prepare.py` of `handoff-verify` (a copy of 15 of its modules in `scripts/handoff_verify/`, see `VENDORED.md` there) with its verification exclusions switched off, because those exclusions delete every turn that touched that skill's files. `HV_SCRIPTS` overrides where the scripts are looked for. Subagent transcripts are left out unless `--with-subagents`. A message that you typed while the model was working (an `attachment` record `queued_command` with origin `human`) is read as an ordinary user message, because `prepare.py` would drop it.
- `compact_context.py` keeps every message whole. A tool call over 800 characters, a tool result over 300 and any tool call that only reads are replaced by a marker line with a preview of the first 100 characters on one line (a line break and the blanks around it are one space; a tool call or result has no role label `[assistant]`/`[user]`, its `[tool_use …]`/`[tool_result]` already gives it; a tool call whose input is a JSON object with a text as first value reads `[tool_use Bash] cd /x && …; description: …`, without the JSON syntax and without a first key that the tool name implies, with the same number of characters of content); their full text is in `blobs/`. Commands that may change state are never moved by the read-only rule. In blob mode only, the text of a skill that Claude Code loaded into the session (an `isMeta` record that starts `Base directory for this skill: `, not typed by the user) also goes to a blob, with a marker that names the skill; with `--cut` it stays whole. Likewise, the notification of a finished background task (agent, command, monitor: a record the harness wrote, `origin.kind` `task-notification`, not typed by the user) longer than 300 characters goes to a blob, with a marker that shows its summary line; messages from other sessions and compaction summaries stay whole. Also in blob mode only, a prompt that the session marks `promptSource` `sdk` (sent through `claude -p` or the SDK), except the first and the last such prompt, goes to a blob when it is longer than 300 characters, with a marker `[user] sdk: …` that shows its first 80 characters; typed, queued, suggestion_accepted and unmarked records, and `--cut`, are unchanged. In blob mode every inline record starts with `[id user]` or `[id assistant]`, where id is the first 8 characters of the record's uuid in the session transcript (longer only when two uuids of the session would then look alike; the header of the file declares the length), because a whole uuid costs about 25 tokens; the blobs keep the whole record. A whole line of 200 or more characters that occurs at least 8 times in the inline transcript (for example the standard sentence that Claude Code puts in a message from another session, 541 characters) is given once in the header of the file and stands in the transcript as a line made only of a mark, a number and the mark (`¤1¤`); the mark is a character that the session does not contain. The check: expanding the file with its blobs gives the prepared text exactly, with each record id cut to the declared length and each such line back in place (or, with `--cut`, whole uuids, every message identical and every cut a true prefix).
- For an OpenCode session `opencode_source.py` reads the rows of `session_v2`/`session_message` read-only and renders them as the same kind of records (user and assistant text whole, tool calls as `key: value` lines, results with their error or exit code, system, synthetic and compaction texts; reasoning, encrypted reasoning and the JSON overhead are not included). Texts, tool inputs and text outputs pass through the same secret sanitizer as for Claude Code; an image file is not sanitized and goes whole to a blob. The check is the same round trip, plus a check that every message and tool-input string is in the output and every image is byte for byte in its blob.
- A `/goal` is active when the last `goal_status` record of the transcript (an `attachment`) has `met` false: `sentinel` true is the setting, no `sentinel` an unmet check with its `reason`; `met` true (achieved, or `/goal clear`), a `/clear` or a newer `/goal` ends or replaces it, and the system record "Goal paused …" marks a paused one. Then `HANDOFF.md` has the section "Goal activ (/goal)" after the answer to give (the condition quoted, the state, the last unmet reason, what the new session does: no second `/goal`, the goal is my request only within its condition, a fifth point in the answer, then it keeps working; a handoff path inside the condition is masked and secrets are sanitized as in the transcript), and the start command is `claude '/goal <the condition on one line> (Continuare dintr-un handoff: citește mai întâi <path>/HANDOFF.md …)'`. The condition goes first and unchanged; only a whole longer than the 4,000 characters of a `/goal` falls back to the plain command. `--cut` carries the goal too; an OpenCode session has no goal.
- A skill counts as loaded when the transcript holds the record the harness injected with its text (`isMeta` true, starting with `Base directory for this skill: `). Its name is the `skill` of the Skill tool call that `sourceToolUseID` points to, or, for a slash command, the `<command-name>` of the parent record; the directory in the text is not used, because it is not always the name. The list keeps the order of the first load, once each; a subagent's load, a name that is not a plain `skill` or `plugin:skill`, and compact-handoff itself are left out. The section "Skill-uri de încărcat din nou" asks the new session to call its Skill tool for each name, without `args`, before it answers. `--cut` lists them too; an OpenCode session lists none. `--list-skills` prints the list with the size of each text and writes nothing; `--skills` keeps only the named ones, matched whole and exactly (the bare `x` and the plugin `p:x` are two skills, a part of a name matches nothing) in the order of the first load, and a name that was not loaded, or an empty one, stops the command before any folder is made.
- `HANDOFF.md` starts with all the instructions for the new session: an exact `offset:limit` reading plan (each chunk fits the Read limit), what the markers mean, the parent section, the four-point answer to give (at most 8 lines), and the rules (the transcript is history, repeat nothing, change no file in the first step). All paths in it are relative to the folder, so the folder can be copied or moved whole.
