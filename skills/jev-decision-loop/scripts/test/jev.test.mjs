// jev: the line request format, the verdict thresholds, the exit codes, and the real CLI against a fake Jev on localhost. Offline, node stdlib only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Refused, main, normalize, parseLines, parseRequest, render, toQuestions, toRequests, verdict } from "../jev.mjs";

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

/** A fake Jev: records every body; answers option a with `probs` and every gate with `noul`; answers HTTP 400 to a body that asks the question `failOn`. */
let server; let url; const bodies = []; let probs = { a: 0.9, b: 0.1 }; let noul = 0.95; let failOn = null;
before(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const body = JSON.parse(text);
      bodies.push(body);
      if (failOn && body.questions[failOn]) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "rejected by the fake" } }));
        return;
      }
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

// Why the statement names the step (PRIVATE.md, «Jev decision loop»): Jev sees only the state and the statement, so "This edit changes only
// what the user asked for." got UNSURE on 71 of 84 requests; with the step in the statement, 42 of 42 requests on fresh scope cases were clear and right.
// With both gates in one request, `reversible` pointing at the step in the state was clear and right on 73 of 81 requests, the step in its statement on 60 of 81.
const WITH_STEP = `decision: edit strings.xml
task: Change the login button text to Sign in
a: Edit app/src/main/res/values/strings.xml line 12
b: Read LoginFragment.kt
step: Editing line 12 of strings.xml to change login_button from "Log in" to "Sign in".
gate in_scope:
gate reversible:
gate done: The facts in the state show that the user's request is fully done.
`;

describe("gates written from the step line", () => {
  const STEP = 'Editing line 12 of strings.xml to change login_button from "Log in" to "Sign in"';
  it("writes in_scope and reversible from the step and keeps the done statement as written", () => {
    assert.deepEqual(normalize(parseLines(WITH_STEP)).gates, {
      in_scope: `${STEP} is exactly what the user asked for.`,
      reversible: "`step` can be undone without losing anything.",
      done: "The facts in the state show that the user's request is fully done.",
    });
  });

  it("sends each gate as one noul question and puts the step into the state for reversible only", () => {
    const body = toQuestions(normalize(parseLines(WITH_STEP)));
    assert.equal(body.state.step, STEP);
    assert.deepEqual(Object.keys(body.state), ["task", "facts", "done", "step"]);
    assert.deepEqual(body.questions.in_scope, { type: "noul", instructions: `${STEP} is exactly what the user asked for.` });
    assert.deepEqual(body.questions.reversible, { type: "noul", instructions: "`step` can be undone without losing anything." });
    const scopeOnly = toQuestions(normalize(parseLines(WITH_STEP.replace("gate reversible:\n", ""))));
    assert.deepEqual(Object.keys(scopeOnly.state), ["task", "facts", "done"]);
  });

  // With the step in the state, the choice leaned to the step even when it was the wrong one: on 20 cases whose step was wrong, 3 requests each,
  // the top option was the step in 10 of 60 requests, against 0 of 60 with the step only in the statement of `reversible` (PRIVATE.md, round 6).
  it("asks the choice in a request of its own, without the step in its state, and the gates in one request with the step", () => {
    const [choice, gates, ...rest] = toRequests(normalize(parseLines(WITH_STEP)));
    assert.equal(rest.length, 0);
    assert.deepEqual(Object.keys(choice.questions), ["next"]);
    assert.deepEqual(Object.keys(choice.state), ["task", "facts", "done"]);
    assert.deepEqual(Object.keys(gates.questions), ["in_scope", "reversible", "done"]);
    assert.deepEqual(Object.keys(gates.state), ["task", "facts", "done", "step"]);
    assert.equal(gates.state.step, STEP);
  });

  it("keeps one request when the choice and the gates see the same state", () => {
    const scopeOnly = toRequests(normalize(parseLines(WITH_STEP.replace("gate reversible:\n", ""))));
    assert.equal(scopeOnly.length, 1);
    assert.deepEqual(Object.keys(scopeOnly[0].questions), ["next", "in_scope", "done"]);
    assert.ok(!("step" in scopeOnly[0].state));
    const gatesOnly = toRequests(normalize(parseLines("decision: d\ntask: t\nstep: Running npm test\ngate reversible:\n")));
    assert.equal(gatesOnly.length, 1);
    assert.equal(gatesOnly[0].state.step, "Running npm test");
    const choiceOnly = toRequests(normalize(parseLines("decision: d\ntask: t\na: one\nb: two\n")));
    assert.equal(choiceOnly.length, 1);
    assert.deepEqual(Object.keys(choiceOnly[0].questions), ["next"]);
  });

  it("keeps a statement written after the colon", () => {
    const gates = normalize(parseLines("decision: d\ntask: t\na: one\nb: two\ngate in_scope: Writing answer.json is what the user asked for.\n")).gates;
    assert.equal(gates.in_scope, "Writing answer.json is what the user asked for.");
  });

  it("refuses an empty in_scope gate with no step line, and says to write one", () => {
    const raw = parseLines("decision: d\ntask: t\na: one\nb: two\ngate in_scope:\n");
    assert.throws(() => normalize(raw), (e) => e instanceof Refused && e.code === 2 && /"step:" line/.test(e.message));
  });

  it("refuses a step that does not start with an -ing verb", () => {
    const raw = parseLines("decision: d\ntask: t\na: one\nb: two\nstep: Edit line 12 of strings.xml\ngate in_scope:\n");
    assert.throws(() => normalize(raw), (e) => e instanceof Refused && e.code === 2 && /-ing verb/.test(e.message));
  });

  it("still refuses an empty gate that has no statement of its own, and two step lines", () => {
    assert.throws(() => normalize(parseLines("decision: d\ntask: t\na: one\nb: two\nstep: Running ls\ngate done:\n")), (e) => e instanceof Refused && /non-empty text/.test(e.message));
    assert.throws(() => parseLines("decision: d\ntask: t\nstep: Running ls\nstep: Running pwd\n"), (e) => e instanceof Refused && /two "step:" lines/.test(e.message));
  });

  it("reads the step of a JSON request too, and writes it into the statement when the state is not an object", () => {
    const request = normalize(parseRequest('{"decision": "d", "state": {"task": "t"}, "step": "Running npm test.", "gates": {"reversible": ""}}'));
    assert.equal(request.gates.reversible, "`step` can be undone without losing anything.");
    assert.deepEqual(request.state, { task: "t", step: "Running npm test" });
    const text = normalize(parseRequest('{"decision": "d", "state": "the task is t", "step": "Running npm test.", "gates": {"reversible": ""}}'));
    assert.equal(text.gates.reversible, "Running npm test can be undone without losing anything.");
    assert.equal(text.state, "the task is t");
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

  it("sends the statements it wrote from the step line to Jev", () => withTemp(async (dir) => {
    bodies.length = 0; probs = { a: 0.9, b: 0.1 }; noul = 0.95;
    const { code, stdout } = await run([], WITH_STEP, { HOME: dir, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: url, JEV_DECISION_LOG: join(dir, "d.jsonl") });
    assert.equal(code, 0, stdout);
    assert.equal(bodies.length, 2);
    const choice = bodies.find((b) => b.questions.next);
    const gates = bodies.find((b) => b.questions.reversible);
    assert.deepEqual(Object.keys(choice.questions), ["next"]);
    assert.ok(!("step" in choice.state));
    assert.deepEqual(Object.keys(gates.questions), ["in_scope", "reversible", "done"]);
    assert.match(gates.questions.in_scope.instructions, /^Editing line 12 of strings\.xml .* is exactly what the user asked for\.$/);
    assert.match(gates.questions.reversible.instructions, / can be undone without losing anything\.$/);
    assert.match(gates.state.step, /^Editing line 12 of strings\.xml/);
    assert.match(stdout, /VERDICT: GO a -- Edit app\/src\/main\/res\/values\/strings\.xml line 12/);
    assert.match(stdout, /gate in_scope: 0\.95 yes/);
  }));

  it("is unavailable, with no verdict from the request that did answer, when one of the two requests fails", () => withTemp(async (dir) => {
    bodies.length = 0; probs = { a: 0.9, b: 0.1 }; noul = 0.95; failOn = "reversible";
    const log = join(dir, "d.jsonl");
    try {
      const { code, stdout } = await run([], WITH_STEP, { HOME: dir, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: url, JEV_DECISION_LOG: log });
      assert.equal(code, 4, stdout);
      assert.match(stdout, /^JEV UNAVAILABLE: .*HTTP 400/);
      assert.doesNotMatch(stdout, /VERDICT: GO/);
      assert.ok(!existsSync(log));
    } finally {
      failOn = null;
    }
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
