// jev: the line request format, the verdict thresholds, the exit codes, and the real CLI against a fake Jev on localhost. Offline, node stdlib only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_STATE_CHARS, Refused, main, normalize, parseLines, parseRequest, render, trimState, verdict } from "../jev.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "jev.mjs");
const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "SKILL.md");
const LOGIN = `decision: where to look first for the login button text
task: Change the login button text to Sign in
fact: LoginFragment.kt:42 uses R.string.login_button
done: ran --check
a: Read app/src/main/res/values/strings.xml
b: Grep "Log in" in all Kotlin files
gate in_scope: This edit changes only what the user asked for.
`;

/** A fake Jev: records every body; answers option a with `probs` and every gate with `noul`. */
let server; let url; const bodies = []; let probs = { a: 0.9, b: 0.1 }; let noul = 0.95;
before(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const body = JSON.parse(text);
      bodies.push(body);
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) answers[id] = q.type === "choice" ? { type: "choice", choice: "a", probabilities: probs } : { type: "noul", noul };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "typesafe/jev-test", answers }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "jev-test-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** The CLI as a child process, the request on stdin as a heredoc gives it. */
function run(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: env.HOME, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

describe("line request format", () => {
  it("turns decision, task, fact, done, option and gate lines into the request", () => {
    assert.deepEqual(parseLines(LOGIN), {
      decision: "where to look first for the login button text",
      state: { task: "Change the login button text to Sign in", facts: ["LoginFragment.kt:42 uses R.string.login_button"], done: ["ran --check"] },
      options: { a: "Read app/src/main/res/values/strings.xml", b: 'Grep "Log in" in all Kotlin files' },
      gates: { in_scope: "This edit changes only what the user asked for." },
    });
  });

  it("joins a line without a key to the line before it and reads keys in any case", () => {
    const raw = parseLines("Decision: d\nTASK: t\nfact: first half\n  second half\nA: one\nB: two\nGate Done: all done\n");
    assert.deepEqual(raw.state.facts, ["first half second half"]);
    assert.deepEqual(raw.options, { a: "one", b: "two" });
    assert.deepEqual(raw.gates, { Done: "all done" });
  });

  it("refuses a missing task, a repeated option and text before the first key", () => {
    assert.throws(() => parseLines("decision: d\na: one\nb: two\n"), (e) => e instanceof Refused && e.code === 2 && /task:/.test(e.message));
    assert.throws(() => parseLines("decision: d\ntask: t\na: one\na: two\n"), (e) => e instanceof Refused && /two lines for option a/.test(e.message));
    assert.throws(() => parseLines("look here\ndecision: d\ntask: t\n"), (e) => e instanceof Refused && /line 1/.test(e.message));
  });

  it("still reads a JSON request that starts with a brace", () => {
    const raw = parseRequest('{"decision": "d", "state": {"task": "t"}, "options": ["one", "two"]}');
    assert.deepEqual(normalize(raw).options, { a: "one", b: "two" });
  });
});

describe("verdict", () => {
  const request = { options: { a: "one", b: "two" }, gates: null };
  it("takes 0.60 against 0.40 as the 0.20 lead it is: GO", () => {
    assert.equal(verdict(request, { next: { choice: "a", probabilities: { a: 0.6, b: 0.4 } } }).verdict, "GO");
  });
  it("is UNSURE at 0.59 against 0.41", () => {
    assert.equal(verdict(request, { next: { choice: "a", probabilities: { a: 0.59, b: 0.41 } } }).verdict, "UNSURE");
  });
  // In live runs the step after a GO went past Jev when it looked obvious: reading what a search found, retrying a failed search.
  it("after GO, says the call after the chosen one is a new decision, even an obvious one", () => {
    const text = render(request, verdict(request, { next: { choice: "a", probabilities: { a: 0.9, b: 0.1 } } }));
    assert.match(text, /^VERDICT: GO a/m);
    assert.match(text, /The call after it is a new Jev decision, even when it looks obvious/);
    assert.match(text, /reading what a search found/);
  });
});

describe("UNSURE advice", () => {
  const tie = { next: { choice: "a", probabilities: { a: 0.51, b: 0.49 } } };
  it("without gates, sends a tie to the leaning option when that option only reads", () => {
    const request = { options: { a: "Read CardShadow.kt", b: "Read RewardCardItem.kt" }, gates: null };
    const text = render(request, verdict(request, tie));
    assert.match(text, /^VERDICT: UNSURE/m);
    assert.match(text, /option a if it only reads/);
    assert.match(text, /same options/);
  });
  it("with a gate, the step changes something: no leaning option, and Jev picks the read that settles it", () => {
    const request = { options: { a: "Edit A.kt", b: "Edit B.kt" }, gates: { in_scope: "This edit changes only what the user asked for." } };
    const text = render(request, verdict(request, { ...tie, in_scope: { noul: 0.95 } }));
    assert.doesNotMatch(text, /only reads/);
    assert.match(text, /new Jev decision whose options are the reads or searches that would settle it/);
    assert.match(text, /ask this decision again/);
  });
});

describe("CLI", () => {
  it("asks Jev a line request from stdin and prints the verdict", () => withTemp(async (dir) => {
    bodies.length = 0; probs = { a: 0.9, b: 0.1 }; noul = 0.95;
    const log = join(dir, "decisions.jsonl");
    const { code, stdout } = await run([], LOGIN, { HOME: dir, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: url, JEV_DECISION_LOG: log });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /VERDICT: GO a -- Read app\/src\/main\/res\/values\/strings\.xml/);
    assert.equal(bodies.length, 1);
    assert.deepEqual(Object.keys(bodies[0].questions), ["next", "in_scope"]);
    assert.deepEqual(bodies[0].state.facts, ["LoginFragment.kt:42 uses R.string.login_button"]);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  }));

  it("writes the decision log named by the env it is given, not by process.env", () => withTemp(async (dir) => {
    const log = join(dir, "given.jsonl");
    const print = console.log;
    console.log = () => {};
    try {
      assert.equal(await main([LOGIN], { HOME: dir, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: url, JEV_DECISION_LOG: log }), 0);
    } finally {
      console.log = print;
    }
    assert.ok(existsSync(log));
  }));

  it("exits 2, not with an error name, when the --file request cannot be read", () => withTemp(async (dir) => {
    const { code, stdout } = await run(["--file", join(dir, "missing.txt")], "", { HOME: dir, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: url, JEV_DECISION_LOG: join(dir, "d.jsonl") });
    assert.equal(code, 2);
    assert.match(stdout, /^JEV REQUEST REFUSED: /);
  }));
});

// Measured on 2026-10-26 (n = 26 decisions of 3 live sessions): 61-66% of the characters of a request were the task, facts and done lines written out
// again; the script keeps them for the session, so a request carries what is new.
describe("state kept for the session", () => {
  const FIRST = "decision: where to look first\ntask: Fix the review error dialog\nfact: ReviewSheet.kt:42 shows the dialog\na: Read ReviewSheet.kt\nb: Grep \"error\" in app/src\n";
  const NEXT = "decision: what next\nfact: the errors come from SubmissionException\ndone: read ReviewSheet.kt\na: Edit ReviewSheet.kt\nb: Read SubmissionException.kt\n";
  const env = (dir, session = "s1") => ({ HOME: dir, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: url, JEV_DECISION_LOG: join(dir, "d.jsonl"), JEV_STATE_DIR: join(dir, "state"), CLAUDE_CODE_SESSION_ID: session });

  it("completes a request that has no task: with the task and the facts of the earlier decisions", () => withTemp(async (dir) => {
    bodies.length = 0; probs = { a: 0.9, b: 0.1 };
    assert.equal((await run([], FIRST, env(dir))).code, 0);
    const second = await run([], NEXT, env(dir));
    assert.equal(second.code, 0, second.stdout);
    assert.deepEqual(bodies[1].state, { task: "Fix the review error dialog", facts: ["ReviewSheet.kt:42 shows the dialog", "the errors come from SubmissionException"], done: ["read ReviewSheet.kt"] });
    assert.match(second.stdout, /state: 2 facts, 1 done kept for this session/);
  }));

  it("takes a fact written again once, and a new task: starts the state over", () => withTemp(async (dir) => {
    bodies.length = 0;
    await run([], FIRST, env(dir));
    await run([], FIRST.replace("decision:", "decision: again, ") , env(dir));
    assert.deepEqual(bodies[1].state.facts, ["ReviewSheet.kt:42 shows the dialog"]);
    await run([], "decision: d\ntask: Rename the sheet\na: one\nb: two\n", env(dir));
    assert.deepEqual(bodies[2].state, { task: "Rename the sheet", facts: [], done: [] });
  }));

  it("keeps one state per session and, outside a session, still wants the task in every request", () => withTemp(async (dir) => {
    bodies.length = 0;
    await run([], FIRST, env(dir, "s1"));
    const other = await run([], NEXT, env(dir, "s2"));
    assert.equal(other.code, 2);
    assert.match(other.stdout, /^JEV REQUEST REFUSED: missing "task:"/);
    const bare = await run([], NEXT, { ...env(dir), CLAUDE_CODE_SESSION_ID: "" });
    assert.equal(bare.code, 2);
    assert.equal(bodies.length, 1);
  }));

  it("keeps nothing of a request that was refused for looking like a secret", () => withTemp(async (dir) => {
    const leak = FIRST.replace("shows the dialog", "uses sk-abcdefghijklmnopqrstuvwxyz");
    const { code } = await run([], leak, env(dir));
    assert.equal(code, 3);
    assert.equal(existsSync(join(dir, "state", "s1.json")), false);
  }));

  it("drops the oldest done lines, then the oldest facts, once the state is longer than MAX_STATE_CHARS", () => {
    const line = "x".repeat(1_000);
    const state = { task: "t", facts: Array.from({ length: 10 }, (_, i) => `f${i} ${line}`), done: Array.from({ length: 10 }, (_, i) => `d${i} ${line}`) };
    const { state: kept, dropped } = trimState(state);
    assert.ok(JSON.stringify(kept).length <= MAX_STATE_CHARS);
    assert.equal(kept.facts.length, 10);
    assert.ok(kept.done.length > 0 && kept.done.length < 10);
    assert.deepEqual(kept.done.map((l) => l.split(" ")[0]), Array.from({ length: kept.done.length }, (_, i) => `d${10 - kept.done.length + i}`));
    assert.equal(dropped, 20 - kept.facts.length - kept.done.length);
    assert.equal(kept.task, "t");
  });
});

describe("SKILL.md", () => {
  const source = readFileSync(SKILL, "utf8");
  const requests = [...source.matchAll(/<<'EOF'\n([\s\S]*?)\n\s*EOF/g)].map((m) => m[1].replace(/^ {4}/gm, ""));
  it("documents requests without braces, which Claude Code's Bash check refuses next to a quote", () => {
    assert.ok(requests.length >= 2);
    for (const text of requests) assert.doesNotMatch(text, /[{}]/);
  });
  it("says one GO is one tool call and names the follow-up steps that went past Jev in live runs", () => {
    assert.match(source, /One `GO` is one tool call/);
    assert.match(source, /the file that a search just found/);
    assert.match(source, /failed or found nothing/);
    assert.match(source, /giving the final answer/);
  });
  it("asks for the task once and only the new facts after it", () => {
    assert.match(source, /`task:` in the first decision only, and in each later decision only the `fact:` and `done:` lines that are new/);
    assert.match(source, /61-66% of the characters of a request were state written out again/);
    const later = requests.find((text) => !/^task:/m.test(text));
    assert.ok(later, "a worked example of a later decision, without task:");
    assert.deepEqual(parseLines(later, { needTask: false }).state.task, "");
  });
  it("makes one option the way forward, and the edit an option after two reads on the same unknown", () => {
    assert.match(source, /\*\*One option always moves the task forward\.\*\*/);
    assert.match(source, /one option is the edit itself, with the assumption it rests on written in it/);
    assert.match(source, /After two reads in a row on the same unknown, the next decision has the edit with its assumption as an option/);
  });
  it("has a worked example that the script accepts", () => {
    assert.ok(requests.some((text) => { try { return Object.keys(normalize(parseLines(text)).options).length >= 2; } catch { return false; } }));
  });
  it("stops at a 400, changes the model only for a guardrail 404 and sends no test request besides --check", () => {
    assert.match(source, /\*\*HTTP 400\.\*\* The service rejected the request itself/);
    assert.match(source, /Jev is out for the rest of the task/);
    assert.match(source, /`Model blocked by guardrail`[^\n]*the one failure that another model can fix/);
    assert.match(source, /`--check` is the only test request/);
  });
});
