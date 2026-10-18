import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MAX_NUDGES, MODE_TTL_MS, composeNudge, guessRoot, handleNudgeHook, nudgeParts, nudgeText, reminderText } from "../hook.mjs";

let dir;
let env;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-nudge-"));
  env = { APANA_CLASS_GRAPH_STATE_DIR: join(dir, "state") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const prompt = (text, session = "s1") => ({ session_id: session, prompt: text });
const bash = (command, session = "s1", extra = {}) => ({ session_id: session, tool_name: "Bash", tool_input: { command }, ...extra });
const on = (session = "s1") => handleNudgeHook("UserPromptSubmit", prompt("/apana:class-graph", session), env);
const context = (out) => out?.hookSpecificOutput?.additionalContext;

describe("nudgeParts", () => {
  it("defaults to reminder and nudge; a and b select one part; anything else is off", () => {
    assert.deepEqual(nudgeParts({}), { reminder: true, nudge: true });
    assert.deepEqual(nudgeParts({ APANA_CLASS_GRAPH_NUDGE: "ON" }), { reminder: true, nudge: true });
    assert.deepEqual(nudgeParts({ APANA_CLASS_GRAPH_NUDGE: " a " }), { reminder: false, nudge: true });
    assert.deepEqual(nudgeParts({ APANA_CLASS_GRAPH_NUDGE: "b" }), { reminder: true, nudge: false });
    for (const v of ["off", "0", "", "banana"]) assert.deepEqual(nudgeParts({ APANA_CLASS_GRAPH_NUDGE: v }), { reminder: false, nudge: false }, v);
  });
});

describe("the mode", () => {
  it("is off until a bare /apana:class-graph, and the bare command itself adds nothing", () => {
    assert.equal(handleNudgeHook("UserPromptSubmit", prompt("fix the reward card bug"), env), null);
    assert.equal(on(), null);
    assert.match(context(handleNudgeHook("UserPromptSubmit", prompt("fix the reward card bug"), env)), /class-graph is ON/);
  });
  it("is not switched on by the command with a question, by another slash command or by a notification", () => {
    handleNudgeHook("UserPromptSubmit", prompt("/apana:class-graph Who uses Foo?"), env);
    assert.equal(handleNudgeHook("UserPromptSubmit", prompt("fix the bug"), env), null);
    on();
    for (const text of ["/apana:logic-test-debug", "<task-notification>x</task-notification>", "<cross-session-message from=\"a\">x</cross-session-message>", "   "]) {
      assert.equal(handleNudgeHook("UserPromptSubmit", prompt(text), env), null, text);
    }
  });
  it("is per session and expires after 24 hours", () => {
    on("s1");
    assert.equal(handleNudgeHook("UserPromptSubmit", prompt("fix it", "s2"), env), null);
    assert.ok(context(handleNudgeHook("UserPromptSubmit", prompt("fix it", "s1"), env)));
    assert.equal(handleNudgeHook("UserPromptSubmit", prompt("fix it", "s1"), env, Date.now() + MODE_TTL_MS + 1000), null);
  });
  it("needs a session id and a string prompt, and ignores other events", () => {
    for (const input of [{}, { prompt: "/apana:class-graph" }, { session_id: "", prompt: "/apana:class-graph" }, { session_id: "s1", prompt: 5 }, null, undefined]) {
      assert.equal(handleNudgeHook("UserPromptSubmit", input, env), null);
    }
    for (const event of ["SessionStart", "PostToolUse", "Stop", "SessionEnd", undefined]) assert.equal(handleNudgeHook(event, prompt("/apana:class-graph"), env), null);
  });
  it("keeps the mode when only the reminder is off (a) and ignores the part switches when recording it", () => {
    const a = { ...env, APANA_CLASS_GRAPH_NUDGE: "a" };
    handleNudgeHook("UserPromptSubmit", prompt("/apana:class-graph"), a);
    assert.equal(handleNudgeHook("UserPromptSubmit", prompt("fix it"), a), null, "no reminder in part a");
    assert.ok(context(handleNudgeHook("PreToolUse", bash("rg -n OrderRewardsActivity app/src -g '*.kt'"), a)), "nudge in part a");
  });
  it("never throws on an unusable state folder", () => {
    writeFileSync(join(dir, "file"), "x");
    const broken = { APANA_CLASS_GRAPH_STATE_DIR: join(dir, "file", "sub") };
    assert.throws(() => handleNudgeHook("UserPromptSubmit", prompt("/apana:class-graph"), broken));
    assert.equal(handleNudgeHook("UserPromptSubmit", prompt("fix it"), broken), null);
    assert.equal(handleNudgeHook("PreToolUse", bash("rg -n OrderRewardsActivity app/src"), broken), null);
  });
});

describe("the reminder", () => {
  it("is one short paragraph that names the three scripts and the root rule", () => {
    const text = reminderText();
    assert.ok(Buffer.byteLength(text) <= 700, String(Buffer.byteLength(text)));
    for (const name of ["class-graph.mjs", "find-usages.mjs", "find-def.mjs", "--root", "worktree"]) assert.ok(text.includes(name), name);
    assert.ok(text.includes("skills/class-graph/scripts"));
  });
});

describe("the nudge on a Bash search", () => {
  it("names the class-graph command with the class and the root, only while the mode is on", () => {
    const search = bash("rg -n 'OrderRewardsActivity' app/src/main -g '*.kt'", "s1", { cwd: dir });
    assert.equal(handleNudgeHook("PreToolUse", search, env), null, "mode off");
    on();
    mkdirSync(join(dir, ".git"));
    const out = handleNudgeHook("PreToolUse", search, env);
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    const text = context(out);
    assert.match(text, /class-graph\.mjs OrderRewardsActivity --root \S+ --up 1 --down 0/);
    assert.ok(text.includes(`--root ${dir}`), "root = folder with .git above cwd");
    assert.ok(Buffer.byteLength(text) <= 900, String(Buffer.byteLength(text)));
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "never decides a permission");
  });
  it("notes a list of seven declared names with the first three only and stays short", () => {
    on();
    const names = "ShoppingList|ProductItem|getProductStockStatus|isOutOfStock|InventoryStatus|stockQty|VaisParser";
    const text = context(handleNudgeHook("PreToolUse", bash(`rg -l '${names}' app/src`), env));
    assert.match(text, /users of ShoppingList \(and ProductItem, getProductStockStatus, \+4 more\)/);
    assert.match(text, /class-graph\.mjs ShoppingList --root/);
    assert.ok(!text.includes("VaisParser"), "later names are only counted");
    assert.ok(Buffer.byteLength(text) <= 900, String(Buffer.byteLength(text)));
  });
  it("sends a member to find-usages and a declaration lookup to class-graph with the bare name", () => {
    on();
    assert.match(context(handleNudgeHook("PreToolUse", bash("grep -rn 'statusLine(' app/src --include=*.kt"), env)), /find-usages\.mjs <File\.kt that declares statusLine> statusLine --root .* \| head -n 80/);
    assert.match(context(handleNudgeHook("PreToolUse", bash("rg -l 'class Continuity' app/src"), env)), /class-graph\.mjs Continuity/);
  });
  it("also notes a search made with the Grep tool, with the same exclusions", () => {
    on();
    const grep = (tool_input) => ({ session_id: "s1", tool_name: "Grep", tool_input, cwd: dir });
    assert.match(context(handleNudgeHook("PreToolUse", grep({ pattern: "accumulatedBalance", glob: "*.kt", path: dir }), env)), /find-usages\.mjs <File\.kt that declares accumulatedBalance>/);
    assert.equal(handleNudgeHook("PreToolUse", grep({ pattern: "rewards_purchased", glob: "*.kt" }), env), null);
    assert.equal(handleNudgeHook("PreToolUse", grep({ pattern: "OrderRewardsActivity", glob: "*.xml" }), env), null);
    assert.equal(handleNudgeHook("PreToolUse", { session_id: "s1", tool_name: "Glob", tool_input: { pattern: "OrderRewardsActivity" } }, env), null);
  });
  it("adds nothing for literal text, other tools, other events or a missing command", () => {
    on();
    for (const input of [
      bash("rg -n 'rewards_purchased' app/src -g '*.kt'"),
      { ...bash("rg -n OrderRewardsActivity app/src"), tool_name: "Read" },
      { session_id: "s1", tool_name: "Bash", tool_input: {} },
      { session_id: "s1", tool_name: "Bash" },
    ]) assert.equal(handleNudgeHook("PreToolUse", input, env), null);
    assert.equal(handleNudgeHook("PostToolUse", bash("rg -n OrderRewardsActivity app/src"), env), null);
  });
  it("notes each name once and at most three times per session", () => {
    on();
    const names = ["AlphaFirst", "BetaSecond", "GammaThird", "DeltaFourth"];
    const seen = names.map((n) => handleNudgeHook("PreToolUse", bash(`rg -n ${n} app/src -g '*.kt'`), env));
    assert.equal(seen.filter(Boolean).length, MAX_NUDGES);
    assert.equal(seen[3], null);
    on();
    assert.ok(handleNudgeHook("PreToolUse", bash("rg -n AlphaFirst app/src -g '*.kt'"), env), "the bare command renews the mode and its counters");
    assert.equal(handleNudgeHook("PreToolUse", bash("rg -n AlphaFirst app/src -g '*.kt'"), env), null, "same name twice");
  });
  it("is off with APANA_CLASS_GRAPH_NUDGE=off or b", () => {
    on();
    for (const value of ["off", "b"]) assert.equal(handleNudgeHook("PreToolUse", bash("rg -n OrderRewardsActivity app/src"), { ...env, APANA_CLASS_GRAPH_NUDGE: value }), null, value);
  });
  it("quotes a root that needs it", () => {
    const text = nudgeText({ kind: "class", names: ["Foo1x", "Bar2y"], paths: [], cd: null }, "/Users/me/My Project");
    assert.ok(text.includes("--root '/Users/me/My Project'"));
    assert.ok(text.includes("(and Bar2y)"));
    assert.ok(nudgeText({ kind: "class", names: ["Foo1x"] }, null).includes("--root <project root>"));
  });
});

describe("guessRoot", () => {
  it("walks up from an absolute search path to the Gradle settings file or .git", () => {
    const project = join(dir, "proj");
    mkdirSync(join(project, "app", "src", "main"), { recursive: true });
    writeFileSync(join(project, "settings.gradle.kts"), "");
    assert.equal(guessRoot({ paths: [join(project, "app", "src", "main")], cd: null }, "/"), project);
    assert.equal(guessRoot({ paths: ["app/src/main"], cd: null }, project), project);
    assert.equal(guessRoot({ paths: [], cd: project }, "/"), project);
    assert.equal(guessRoot({ paths: [], cd: null }, join(project, "app")), project);
  });
  it("falls back to the search folder itself, or to null when nothing exists", () => {
    const loose = join(dir, "loose", "src");
    mkdirSync(loose, { recursive: true });
    assert.equal(guessRoot({ paths: [loose], cd: null }, "/"), loose);
    assert.equal(guessRoot({ paths: ["nope"], cd: null }, join(dir, "missing")), null);
  });
});

describe("composeNudge", () => {
  const added = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "NOTE" } };
  it("returns the nudge alone, or joins it to context of the same event, keeping every other field", () => {
    assert.deepEqual(composeNudge(null, added), added);
    assert.equal(composeNudge({ a: 1 }, null).a, 1);
    const merged = composeNudge({ systemMessage: "m", hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "OLD" } }, added);
    assert.equal(merged.systemMessage, "m");
    assert.equal(merged.hookSpecificOutput.additionalContext, "OLD\nNOTE");
  });
  it("leaves outputs that decide a permission (deny/ask), come from another event or are malformed unchanged", () => {
    for (const existing of [
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "r" } },
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } },
      { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } },
      { hookSpecificOutput: "x" },
      { hookSpecificOutput: { additionalContext: 5 } },
      [1],
      "text",
    ]) assert.deepEqual(composeNudge(existing, added), existing);
  });
  it("keeps an allow decision and adds the note", () => {
    const merged = composeNudge({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }, added);
    assert.equal(merged.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(merged.hookSpecificOutput.additionalContext, "NOTE");
  });
});

describe("old state files", () => {
  it("are removed when the mode is written again", () => {
    on("s1");
    const stateDir = env.APANA_CLASS_GRAPH_STATE_DIR;
    const [name] = readdirSync(stateDir);
    const old = new Date(Date.now() - 3 * MODE_TTL_MS);
    utimesSync(join(stateDir, name), old, old);
    on("s2");
    assert.equal(readdirSync(stateDir).includes(name), false);
  });
});
