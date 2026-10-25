---
name: jev-decision-loop
description: "A mode switched on by the user in which Jev (TypeSafe's judgment model, called over its direct API by a bundled script) takes EVERY decision of the coding session: before each tool call (every read and search too) you list 2-5 concrete next steps, Jev picks one, you do exactly that one. Needs TYPESAFE_API_KEY or OPENROUTER_API_KEY (environment or macOS Keychain), not the jev plugin or its MCP tools. Use ONLY when the user explicitly asks for it: /apana:jev-decision-loop, \"use Jev for every decision\", \"let Jev decide\", \"Jev decision loop\", \"folosește Jev pentru decizii\", \"folosește Jev pentru toate deciziile\", \"ia toate deciziile cu Jev\", \"lasă Jev să decidă\". Never switch it on by yourself, and not for questions about Jev or TypeSafe or for adding TypeSafe to an app's code."
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs *)
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/jev-decision-loop/scripts/gate-hook.mjs" pre'
          timeout: 10
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/jev-decision-loop/scripts/gate-hook.mjs" post'
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/jev-decision-loop/scripts/gate-hook.mjs" stop'
          timeout: 10
---

# jev-decision-loop

From now until the user says stop, Jev takes every decision of this session. You propose, Jev picks, you do. You still read, edit and run everything yourself; Jev only chooses among the options you give it, on the facts you give it. Why: a fast model is good at listing candidate steps and worse at picking the right one; Jev is a model calibrated for exactly that pick, and it answers in about 0.3 s.

Every decision is one command, with one `key: text` line per item between the `EOF` lines (`${CLAUDE_SKILL_DIR}` is this skill's folder; if it is not replaced by a path, write the folder printed after `Base directory for this skill:` instead):

    node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs <<'EOF'
    decision: <one line: what is being decided>
    task: <the user's request, in their words>
    fact: <something you learned, with file:line>
    done: <a step already taken>
    a: <one concrete step>
    b: <another>
    gate <id>: <a statement Jev rates true or false>
    EOF

Write as many `fact:` and `done:` lines as you need (none on the first decision), options `a:` to `h:`, gates only when step 3 asks for them. No JSON and no `{` or `}` in the texts: Claude Code refuses a command with a brace next to a quote, and then Jev is never asked.

## Start

1. Run `node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs --check`.
2. `JEV OK` → tell the user in one line that Jev now picks every step, that short summaries of the task go to the provider it names, and that saying stop ends the mode. `JEV UNAVAILABLE` with a 404 `Model blocked by guardrail` → see "When Jev does not answer". Any other `JEV UNAVAILABLE` → run `node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs --off` (so that the gate below does not hold the session), show the user that line and stop: do not do the task without Jev.

`--check` is the only test request. Do not probe the endpoint yourself with curl, an empty body or a made-up decision: an empty body gets a 400 that says nothing about your real requests, and the next real decision answers that question anyway.

From the moment the skill is loaded, its hooks hold you to this: a tool call that no `GO` allowed is refused with the command to ask, and the end of a turn is refused once unless the last decision picked the reply (`Answer the user: ...` with the `done` gate, or `Ask the user: ...`). A refused call means: ask Jev, then do what it picks; not: try the same call again.

## Before EVERY tool call

A decision is every next step: which file to read, what to search, which edit, which command, whether to ask the user, whether the task is done and what to answer. There are no decisions too small for Jev in this mode. The only tool calls that need no decision are the `jev.mjs` calls themselves.

One `GO` is one tool call. The call after it is a new decision, even when the step looks obvious; in test runs these were exactly the steps that went past Jev:
- reading the file that a search just found,
- trying again after a search or command that failed or found nothing,
- reading more lines of a file you just read,
- giving the final answer once the facts look complete.

Asking takes about 0.3 s: write the obvious step as option a and its best alternative as b.

1. **Options**: 2-5, each one concrete step written out in full, so that whichever Jev picks you can do it at once:
   - `Read app/src/main/res/values/strings.xml`
   - `Grep "login_button" in app/src`
   - `Edit strings.xml: "Log in" -> "Sign in" in login_button`
   - `Run ./gradlew :app:testDebugUnitTest --tests '*LoginTest*'`
   - `Ask the user: which of the two login screens do you mean?`
   - `Answer the user: the text is in strings.xml:12; changed it to Sign in`

   Not "investigate further" or "look around": Jev cannot pick a step you did not write. Independent reads may share one option ("Read A and B"). Options must differ in what they would find out or change: two variants of the same search ("Grep X in app/src", "Grep X in the whole repo") split Jev's vote and give UNSURE for nothing.
2. **State**: the task in the user's words, the facts you learned so far (short, with file:line), the steps already done. Summaries, not whole files. Never keys, passwords, tokens or `.env` contents (the script refuses a request that looks like one).
3. **Gates**, when the step changes something (Jev gives each statement a probability of being true):
   - before an edit: `gate in_scope: This edit changes only what the user asked for.`
   - before a command that writes, installs, deletes or sends: `gate reversible: This command can be undone without losing anything.`
   - before the final answer: `gate done: The facts in the state show that the user's request is fully done.`
4. **Ask** with the command above and read the `VERDICT` line:
   - `GO a` → your next tool call is exactly option a. Not another one, not two.
   - `UNSURE` with no gates and a leaning option that only reads (a Read, a search, a listing) → do that option: it is the cheapest read, and a wrong one costs one more read. Any other `UNSURE` → ask a new decision whose options are the reads or searches that would settle it, do the one Jev picks, add what it showed to the state, then ask the first decision again. UNSURE again on the same options → ask the user, with the numbers. New options, after a step showed you something new, are a new decision with its own `decision:` line.
   - `STOP` → do not take that step. Write other options (or change the plan) and ask again; if no safe option is left, ask the user.
   - `JEV REQUEST REFUSED` → fix what it names (a missing field, a secret, a state that is too long) and ask again. `JEV UNAVAILABLE` → "When Jev does not answer" below; never go on as if Jev had said GO.
5. **Do** that one step, then go back to 1 with what it showed you, before any other tool call.

Example: the user asks to change the login button text.

    node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs <<'EOF'
    decision: where to look first for the login button text
    task: Change the login button text to Sign in
    fact: LoginFragment.kt:42 uses R.string.login_button
    a: Read app/src/main/res/values/strings.xml
    b: Grep "Log in" in all Kotlin files
    c: Ask the user which file
    EOF

prints

    JEV where to look first for the login button text (typesafe typesafe/jev-1.13-20260917, 321 ms)
    options: a 1.00 | b 0.00 | c 0.00
    VERDICT: GO a -- Read app/src/main/res/values/strings.xml
    Next tool call: exactly option a, nothing else. The call after it is a new Jev decision, even when it looks obvious (reading what a search found, retrying a failed search, answering).

so the next tool call is the Read of strings.xml, and after it comes the next decision (which edit), with what you read as a new `fact:` line.

## What Jev cannot lift

- Deleting, `git commit`/`push`, a release, sending a message or spending money still needs the user's explicit yes, even after `GO`.
- Facts from the repository beat Jev: when its pick contradicts something you read, put that fact in the state and ask again.
- When every option scores low, the options are the problem: write better ones.

## When Jev does not answer

The `JEV UNAVAILABLE` line names the provider, the model, the HTTP status and the service's message; that message is the only clue to what went wrong, so show it to the user. The script has already retried network errors, 408, 409, 429 and 5xx; it never sends a 400 or a 404 again.

- **HTTP 400.** The service rejected the request itself, so the same request again, or with another `JEV_MODEL`, gets the same answer. If the message names something you set and can correct (a misspelt `JEV_MODEL`, one of your lines), correct it and ask once more. If it does not, or the corrected request also gets 400, Jev is out for the rest of the task, since every later request is built the same way: run `node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs --off`, tell the user the status, the message and where the task stopped, and stop.
- **HTTP 404 with `Model blocked by guardrail`** (OpenRouter). The request is fine; the account's guardrail settings (https://openrouter.ai/workspaces/default/guardrails) exclude that model. This is the one failure that another model can fix. Tell the user which model is blocked and where the setting is, then ask again with a model the message did not name in front of the command, on this call and every later one: `JEV_MODEL=typesafe/jev-1.13 node ...` (the default). In a probe on 2026-10-25, `~typesafe/jev-latest` and `typesafe/jev-1.14` were blocked (n=3) while `typesafe/jev-1.13` answered (n=38). If that model is blocked too, Jev is out, as after a 400.
- **Anything else** (no key, a timeout, 429 or 5xx after the retries, an answer without a usable choice): Jev decided nothing. Tell the user, and do not try another model for it.

## When you finish

The last decision is the answer itself (an `Answer the user: ...` option with the `done` gate). End the answer with one line: `Jev decisions: N (GO x, UNSURE y, STOP z)`. `node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs --log 30` lists the last decisions with their verdicts.

## When the user says stop

Run `node ${CLAUDE_SKILL_DIR}/scripts/jev.mjs --off`: from then on the gate lets every call through, until the next `--check`. Only when the user said so or Jev is out (Start, "When Jev does not answer"), never to get past a refused call.

## Key and provider

The script uses `TYPESAFE_API_KEY` (TypeSafe direct) or else `OPENROUTER_API_KEY`, from the environment or from the macOS Keychain; it never prints the key. Without one, the user (not you, and never in the chat) stores a key with `! bash ${CLAUDE_SKILL_DIR}/scripts/register-jev-key.sh register typesafe` (or `openrouter`), which reads it without echo. `JEV_PROVIDER=typesafe|openrouter` and `JEV_MODEL` (default `typesafe/jev-1.13`) override the choice; `JEV_DECISION_LOG` moves the log (default `~/.claude/jev-decision-loop/decisions.jsonl`, without the states). Exit codes: 0 answered, 2 bad request, 3 refused before sending, 4 Jev unavailable.
