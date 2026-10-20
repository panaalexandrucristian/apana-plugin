import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { reminderText } from "../hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let dir;
let state;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-seam-"));
  state = join(dir, "state");
});
after(() => rmSync(dir, { recursive: true, force: true }));

function call(event, input, script = join(ROOT, "scripts", "apana-hook.mjs"), extraEnv = {}) {
  const result = spawnSync("node", [script, event], {
    input: JSON.stringify({ hook_event_name: event, ...input }),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, APANA_CLASS_GRAPH_STATE_DIR: state, ...extraEnv },
    timeout: 15000,
  });
  return { status: result.status, out: result.stdout.trim() ? JSON.parse(result.stdout) : null, err: result.stderr };
}

describe("scripts/apana-hook.mjs with the class-graph nudge", () => {
  it("records the bare command silently, then reminds on a later prompt and notes a class search", () => {
    const bare = call("UserPromptSubmit", { session_id: "seam1", prompt: "/apana:class-graph" });
    assert.equal(bare.status, 0);
    assert.ok(!JSON.stringify(bare.out ?? "").includes("class-graph is ON"));
    const later = call("UserPromptSubmit", { session_id: "seam1", prompt: "am un bug in rewards, verifica si fixeaza" });
    assert.equal(later.status, 0);
    assert.ok(later.out.hookSpecificOutput.additionalContext.includes(reminderText()));
    const search = call("PreToolUse", { session_id: "seam1", tool_name: "Bash", tool_input: { command: "rg -n 'OrderRewardsActivity' app/src/main -g '*.kt'" }, cwd: dir });
    assert.equal(search.status, 0);
    assert.equal(search.out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(search.out.hookSpecificOutput.additionalContext, /class-graph\.mjs OrderRewardsActivity --root/);
    assert.equal(search.out.hookSpecificOutput.permissionDecision, undefined);
  });
  it("adds nothing for a literal search, another tool, another session or when switched off", () => {
    assert.equal(call("PreToolUse", { session_id: "seam1", tool_name: "Bash", tool_input: { command: "rg -n 'rewards_purchased' app/src" } }).out, null);
    assert.equal(call("PreToolUse", { session_id: "seam1", tool_name: "Read", tool_input: { file_path: "/x" } }).out, null);
    assert.equal(call("PreToolUse", { session_id: "other", tool_name: "Bash", tool_input: { command: "rg -n 'BetaSecond' app/src" } }).out, null);
    call("UserPromptSubmit", { session_id: "seam2", prompt: "/apana:class-graph" });
    const off = call("PreToolUse", { session_id: "seam2", tool_name: "Bash", tool_input: { command: "rg -n 'BetaSecond' app/src" } }, undefined, { APANA_CLASS_GRAPH_NUDGE: "off" });
    assert.equal(off.out, null);
    const configuredOff = call("PreToolUse", { session_id: "seam2", tool_name: "Bash", tool_input: { command: "rg -n 'GammaThird' app/src" } }, undefined, { CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE: "off" });
    assert.equal(configuredOff.out, null);
  });
  it("honours reminder-only and nudge-only in the real adapter subprocess", () => {
    const reminderEnv = { CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE: "reminder-only" };
    call("UserPromptSubmit", { session_id: "seam-reminder", prompt: "/apana:class-graph" }, undefined, reminderEnv);
    assert.match(call("UserPromptSubmit", { session_id: "seam-reminder", prompt: "continue" }, undefined, reminderEnv).out.hookSpecificOutput.additionalContext, /class-graph is ON/);
    assert.equal(call("PreToolUse", { session_id: "seam-reminder", tool_name: "Grep", tool_input: { pattern: "ReminderTarget", glob: "*.kt" } }, undefined, reminderEnv).out, null);

    const nudgeEnv = { CLAUDE_PLUGIN_OPTION_CLASS_GRAPH_NUDGE: "nudge-only" };
    call("UserPromptSubmit", { session_id: "seam-nudge", prompt: "/apana:class-graph" }, undefined, nudgeEnv);
    assert.equal(call("UserPromptSubmit", { session_id: "seam-nudge", prompt: "continue" }, undefined, nudgeEnv).out, null);
    assert.match(call("PreToolUse", { session_id: "seam-nudge", tool_name: "Grep", tool_input: { pattern: "NudgeTarget", glob: "*.kt" } }, undefined, nudgeEnv).out.hookSpecificOutput.additionalContext, /class-graph\.mjs NudgeTarget/);
  });
  it("leaves the rest of the hook working when the nudge module is missing", () => {
    const fake = join(dir, "fake");
    mkdirSync(join(fake, "scripts"), { recursive: true });
    mkdirSync(join(fake, "private"));
    copyFileSync(join(ROOT, "scripts", "apana-hook.mjs"), join(fake, "scripts", "apana-hook.mjs"));
    for (const name of readdirSync(join(ROOT, "private"))) if (name !== "class-graph-nudge") symlinkSync(join(ROOT, "private", name), join(fake, "private", name));
    for (const name of ["node_modules", "dist", "package.json"]) {
      try {
        symlinkSync(join(ROOT, name), join(fake, name));
      } catch {
        // not every folder exists in every checkout
      }
    }
    call("UserPromptSubmit", { session_id: "seam3", prompt: "/apana:class-graph" }, join(fake, "scripts", "apana-hook.mjs"));
    const later = call("UserPromptSubmit", { session_id: "seam3", prompt: "Write a Python function that validates an email address." }, join(fake, "scripts", "apana-hook.mjs"));
    assert.equal(later.status, 0);
    assert.match(later.err, /\[class-graph-nudge\] unavailable/);
    assert.match(later.out.hookSpecificOutput.additionalContext, /logic-test-debug/, "the other directive is still there");
    assert.ok(!later.out.hookSpecificOutput.additionalContext.includes("class-graph is ON"));
  });
});

describe("the Grep tool and hooks/hooks.json", () => {
  it("notes a Grep-tool search through the same adapter after the mode was recorded, and prints nothing otherwise", () => {
    call("UserPromptSubmit", { session_id: "seam4", prompt: "/apana:class-graph" });
    const out = call("PreToolUse", { session_id: "seam4", tool_name: "Grep", tool_input: { pattern: "OrderRewardsActivity", glob: "*.kt", path: dir }, cwd: dir });
    assert.equal(out.status, 0);
    assert.match(out.out.hookSpecificOutput.additionalContext, /class-graph\.mjs OrderRewardsActivity --root/);
    assert.equal(call("PreToolUse", { session_id: "seam4", tool_name: "Grep", tool_input: { pattern: "rewards_purchased" } }).out, null);
    assert.equal(call("PreToolUse", { session_id: "nomode", tool_name: "Grep", tool_input: { pattern: "BetaSecond", glob: "*.kt" } }).out, null);
    assert.equal(call("PreToolUse", { session_id: "seam4", tool_name: "Glob", tool_input: { pattern: "OrderRewardsActivity" } }).out, null);
  });
  it("is reached through the one PreToolUse entry of the apana adapter, whose matcher names Bash and Grep", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
    assert.equal(hooks.PreToolUse.length, 1);
    const [entry] = hooks.PreToolUse;
    for (const tool of ["Bash", "Grep"]) assert.ok(entry.matcher.split("|").includes(tool), tool);
    assert.match(entry.hooks[0].command, /apana-hook\.mjs" PreToolUse$/);
    assert.ok(existsSync(join(ROOT, "scripts", "apana-hook.mjs")));
  });
});
