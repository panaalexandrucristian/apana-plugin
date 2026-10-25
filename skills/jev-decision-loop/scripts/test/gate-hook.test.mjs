// gate-hook: the skill's hooks refuse a tool call or the end of a turn that no Jev decision covers. Offline, node stdlib only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "gate-hook.mjs");
const JEV = join(HERE, "..", "jev.mjs");
const SKILL = join(HERE, "..", "..", "SKILL.md");
const dirs = [];
let env;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "jev-gate-"));
  dirs.push(dir);
  env = { ...process.env, JEV_GATE_DIR: dir };
});
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const run = (event, input) => {
  const r = spawnSync("node", [HOOK, event], { input: JSON.stringify({ session_id: "s1", ...input }), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};
const read = (path = "/r/a.kt") => run("pre", { tool_name: "Read", tool_input: { file_path: path } });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny";
const ask = (request, stdout) => run("post", { tool_name: "Bash", tool_input: { command: `node ${JEV} <<'EOF'\n${request}\nEOF` }, tool_response: { stdout, stderr: "" } });
const READ_A = "decision: which file to read\ntask: t\na: Read /r/a.kt\nb: Grep x in /r";
const GO_A = "JEV which file to read (typesafe m, 300 ms)\noptions: a 0.90 | b 0.10\nVERDICT: GO a -- Read /r/a.kt";

describe("pre", () => {
  it("refuses a tool call with no Jev decision before it, and says how to ask", () => {
    const out = read();
    assert.ok(denied(out));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /jev\.mjs/);
  });
  it("lets the jev.mjs calls themselves through", () => {
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: `node ${JEV} --check` } }), null);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: `node ${JEV} <<'EOF'\n${READ_A}\nEOF` } }), null);
  });
  it("does not take a jev.mjs name inside another command for a decision", () => {
    assert.ok(denied(run("pre", { tool_name: "Bash", tool_input: { command: `cat ${JEV}` } })));
  });
  it("lets exactly one tool call through after a GO", () => {
    ask(READ_A, GO_A);
    assert.equal(read(), null);
    assert.ok(denied(read("/r/b.kt")));
  });
  it("lets one call through after an UNSURE, refuses after a STOP or when Jev did not answer", () => {
    ask(READ_A, "options: a 0.47 | b 0.34\nVERDICT: UNSURE -- no clear option (a 0.47 vs b 0.34) (leaning a)");
    assert.equal(read(), null);
    ask(READ_A, "VERDICT: STOP -- gate in_scope is false");
    assert.ok(denied(read()));
    ask(READ_A, "JEV UNAVAILABLE: timeout\nVERDICT: UNSURE -- Jev did not answer, so nothing is decided.");
    assert.ok(denied(read()));
  });
  it("lets only one of two parallel calls through on one GO", async () => {
    ask(READ_A, GO_A);
    const once = () => new Promise((resolve) => {
      const child = spawn("node", [HOOK, "pre"], { env });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out.trim() ? JSON.parse(out) : null));
      child.stdin.end(JSON.stringify({ session_id: "s1", tool_name: "Read", tool_input: { file_path: "/r/a.kt" } }));
    });
    const outs = await Promise.all([once(), once()]);
    assert.deepEqual(outs.map(denied).sort(), [false, true]);
  });
  it("leaves subagents alone and keeps sessions apart", () => {
    assert.equal(run("pre", { agent_id: "x", tool_name: "Read", tool_input: { file_path: "/r/a.kt" } }), null);
    ask(READ_A, GO_A);
    assert.ok(denied(run("pre", { session_id: "s2", tool_name: "Read", tool_input: { file_path: "/r/a.kt" } })));
  });
  it("is off after jev.mjs --off and on again after jev.mjs --check", () => {
    run("pre", { tool_name: "Bash", tool_input: { command: `node ${JEV} --off` } });
    assert.equal(read(), null);
    assert.equal(run("stop", {}), null);
    run("pre", { tool_name: "Bash", tool_input: { command: `node ${JEV} --check` } });
    assert.ok(denied(read()));
  });
});

describe("stop", () => {
  const block = (out) => out?.decision === "block";
  it("blocks the end of a turn that no decision covers, once", () => {
    const out = run("stop", { stop_hook_active: false });
    assert.ok(block(out));
    assert.match(out.reason, /gate done/);
    assert.equal(run("stop", { stop_hook_active: true }), null);
  });
  it("lets the turn end after a decision with the done gate or one that picked asking the user", () => {
    ask(`${READ_A.replace("a: Read /r/a.kt", "a: Answer the user: it is in a.kt:3")}\ngate done: The request is fully done.`, "VERDICT: GO a -- Answer the user: it is in a.kt:3");
    assert.equal(run("stop", { stop_hook_active: false }), null);
    ask(READ_A.replace("b: Grep x in /r", "b: Ask the user: which screen?"), "VERDICT: GO b -- Ask the user: which screen?");
    assert.equal(run("stop", { stop_hook_active: false }), null);
  });
  it("blocks when the last decision picked a step that was not the reply", () => {
    ask(READ_A, GO_A);
    assert.ok(block(run("stop", { stop_hook_active: false })));
    assert.equal(read(), null);
  });
});

describe("wiring", () => {
  it("jev.mjs --off answers without a key", () => {
    const r = spawnSync("node", [JEV, "--off"], { env: { PATH: process.env.PATH, HOME: env.JEV_GATE_DIR }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /JEV LOOP OFF/);
  });
  it("SKILL.md declares the three hooks on this script", () => {
    const front = readFileSync(SKILL, "utf8").split("\n---\n")[0];
    for (const event of ["PreToolUse", "PostToolUse", "Stop"]) assert.match(front, new RegExp(`\\n  ${event}:`));
    for (const event of ["pre", "post", "stop"]) assert.match(front, new RegExp(`skills/jev-decision-loop/scripts/gate-hook\\.mjs" ${event}'`));
  });
});
