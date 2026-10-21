import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const adapter = join(root, "scripts/apana-hook.mjs");
const call = (env, event, payload) => { const p = spawnSync("node", [adapter, event], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } }); assert.equal(p.status, 0, p.stderr); return p.stdout.trim() ? JSON.parse(p.stdout) : null; };
test("dispatcher persists scope and denies unapproved writes, wrong roots and scope extensions", () => {
 const state = mkdtempSync(join(tmpdir(), "scope-seam-")); const repo = mkdtempSync(join(tmpdir(), "scope-repo-")); const env = { APANA_SCOPE_STATE_DIR: state, APANA_LOGIC_TEST_DEBUG: "off", APANA_CLASS_GRAPH_NUDGE: "off" }; const id = "22222222-2222-4222-8222-222222222222";
 const start = call(env, "UserPromptSubmit", { session_id: id, cwd: repo, prompt: "/apana:scope Fix login" }); const text = start.hookSpecificOutput.additionalContext; const nonce = text.match(/approve ([a-f0-9-]+)/)[1];
 const edit = call(env, "PreToolUse", { session_id: id, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src/login.js") } }); assert.equal(edit.hookSpecificOutput.permissionDecision, "deny");
 writeFileSync(join(state, `${id}.proposal.json`), JSON.stringify({ production_changes: [{ path: "src/login.js" }], test_changes: [{ path: "test/login.test.js", production_paths: ["src/login.js"] }], test_commands: ["npm test -- test/login.test.js"] }));
 const approved = call(env, "UserPromptSubmit", { session_id: id, cwd: repo, prompt: `/apana:scope approve ${nonce}` }); assert.match(approved.hookSpecificOutput.additionalContext, /Scope approved/);
 assert.equal(call(env, "PreToolUse", { session_id: id, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src/login.js") } }), null);
 const outside = call(env, "PreToolUse", { session_id: id, cwd: join(repo, "other"), tool_name: "Edit", tool_input: { file_path: join(repo, "src/login.js") } }); assert.equal(outside.hookSpecificOutput.permissionDecision, "deny");
 const reset = call(env, "UserPromptSubmit", { session_id: id, cwd: repo, prompt: "/apana:scope Also change payments" }); assert.match(reset.hookSpecificOutput.additionalContext, /investigating only/);
 const after = call(env, "PreToolUse", { session_id: id, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src/login.js") } }); assert.equal(after.hookSpecificOutput.permissionDecision, "deny");
 assert.ok(readFileSync(join(state, `${id}.json`), "utf8").includes("investigating"));
});
