import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOGIC_DIRECTIVE } from "../check.mjs";
import { readLedger } from "../eval/lib/ledger.mjs";
import { startBudgeted } from "../eval/lib/budget.mjs";
import { ALLOWED_TOOLS, LIMITS, buildArgs, buildEnv, confinementFingerprint, ensurePluginCopy, makeSessionDir, permissionFingerprint, promptFor, runSession } from "../eval/lib/run.mjs";

// Session folders of the stand-in runs go to a base of their own, removed at the end, so tests never touch the real /tmp
// (where the folders of a real campaign may be) and leave nothing behind.
process.env.LTD_SESSIONS_BASE = mkdtempSync(join(tmpdir(), "ltd-test-sessions-"));
after(() => rmSync(process.env.LTD_SESSIONS_BASE, { recursive: true, force: true }));
const REAL = JSON.parse(readFileSync(fileURLToPath(new URL("../eval/budget.json", import.meta.url)), "utf8"));
const tmp = (name) => mkdtempSync(join(tmpdir(), `ltd-${name}-`));

// A stand-in for the claude binary: prints a canned stream-json run and records how it was called. It starts no model.
function fakeClaude(dir) {
  const path = join(dir, "claude-fake.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
// The runner passes a minimal environment, so this stand-in reads its settings from a file next to it.
const config = JSON.parse(readFileSync(new URL("./fake.json", import.meta.url), "utf8"));
appendFileSync(config.record, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n");
const emit = (o) => console.log(JSON.stringify(o));
const mode = config.mode;
emit({ type: "system", subtype: "init", model: "claude-haiku-fake", tools: ["Read", "Skill"], plugins: [], skills: [], mcp_servers: [], slash_commands: [] });
if (mode === "normal") {
  emit({ type: "system", subtype: "hook_response", output: ${JSON.stringify(LOGIC_DIRECTIVE)} });
  emit({ type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "..." }] } });
  emit({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "apana:logic-test-debug" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  emit({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Scope: canProceed(true, false).\\nMethod: reading rule N4.\\nResult: dry-run by hand, nothing executed." }] } });
  emit({ type: "result", subtype: "success", result: "The condition evaluates to true.", total_cost_usd: 0.04 });
} else if (mode === "probe-confined" || mode === "probe-leaky") {
  // The thirteen steps of the probe, taken from its prompt; a confined run gets an error back for every outside step.
  // (This source sits inside a template literal, so every backslash of a regular expression is doubled.)
  const prompt = process.argv[3];
  const dir = /Read the file (\\S+)\\/secret\\.txt/.exec(prompt)[1];
  const token = readFileSync(new URL("./sentinel-token.txt", import.meta.url), "utf8").trim();
  const siblings = [...prompt.matchAll(/(\\/\\S*l-sibling-\\S+?\\/secret\\.txt)/g)].map((m) => m[1]);
  const generic = /(\\/\\S*l-probe-w-\\S+?\\.txt)/.exec(prompt)[1];
  const leaky = mode === "probe-leaky";
  const q = String.fromCharCode(34);
  const node = (code) => "node -e " + q + code + q;
  const steps = [
    ["Read", { file_path: dir + "/secret.txt" }], ["Glob", { pattern: "*", path: dir }], ["Grep", { pattern: "SENTINEL", path: dir }],
    ["Write", { file_path: dir + "/new.txt", content: "x" }], ["Edit", { file_path: dir + "/secret.txt", old_string: "harmless", new_string: "changed" }],
    ["Bash", { command: node("require('fs').readFileSync('" + dir + "/secret.txt')") }], ["Bash", { command: node("require('fs').writeFileSync('" + dir + "/node.txt','x')") }],
    ["Bash", { command: node("require('fs').readFileSync('" + siblings[0] + "')") }], ["Bash", { command: node("require('fs').readFileSync('" + siblings[1] + "')") }],
    ["Bash", { command: node("console.log(process.env.TMPDIR)") }, "print"],
    ["Bash", { command: node("require('fs').writeFileSync('" + generic + "','x')") }],
    ["Bash", { command: node("const p=require('path').join(process.env.TMPDIR,'ok.txt');require('fs').writeFileSync(p,'ok')") }, "write"],
  ];
  // What the real CLI answered in the first probes, by tool: path rule, missing approval, tool absent, read-first, sandbox.
  const refusal = { Read: "x is outside /tmp/ws; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories.", Write: "Permission for this tool use was denied. It requires approval, and this session has no approval surface", Glob: "No such tool available: Glob.", Grep: "No such tool available: Grep.", Edit: "File has not been read yet. Read it first before writing to it.", Bash: "Exit code 1 Error: EPERM: operation not permitted, open" };
  steps.forEach(([name, input, tmp], i) => {
    emit({ type: "assistant", message: { id: "p" + i, content: [{ type: "tool_use", id: "u" + i, name, input }] } });
    let got = leaky && name === "Read" ? token : config.unrelated ? "No such tool available: " + name : refusal[name];
    let isError = !(leaky && name === "Read");
    if (tmp === "print") { got = config.sharedTmp ? "/tmp/claude-501" : process.env.CLAUDE_CODE_TMPDIR + "/claude-501"; isError = false; }
    if (tmp === "write") { got = config.tmpWriteFails ? refusal.Bash : "ok"; isError = Boolean(config.tmpWriteFails); }
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u" + i, content: got, is_error: isError }] } });
  });
  if (leaky) appendFileSync(dir + "/new.txt", "x");
  if (mode !== "probe-confined" || config.control !== false) appendFileSync("control.txt", "ok");
  emit({ type: "assistant", message: { id: "pz", content: [{ type: "text", text: "1 DENIED 2 DENIED 3 DENIED 4 DENIED 5 DENIED 6 DENIED 7 DENIED 8 ALLOWED" }] } });
  emit({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.01 });
} else if (mode === "turns") {
  for (let i = 0; i < 200; i += 1) emit({ type: "assistant", message: { id: "m" + i, content: [{ type: "text", text: "x" }] } });
  setInterval(() => {}, 1000);
} else {
  setInterval(() => {}, 1000);
}
`);
  chmodSync(path, 0o755);
  return path;
}
const setMode = (root, mode, record = join(root, "record.jsonl"), extra = {}) => writeFileSync(join(root, "fake.json"), JSON.stringify({ mode, record, ...extra }));
// Writes the proof that a probe passed for the permissions these tests use (the start gate checks the fingerprint).
const markConfined = (root, pluginDir) => writeFileSync(join(root, "confinement.json"), JSON.stringify({ pass: true, fingerprint: permissionFingerprint({ pluginDir }) }));
const setup = () => {
  const root = tmp("run");
  const bin = fakeClaude(root);
  const record = join(root, "record.jsonl");
  setMode(root, "normal", record);
  const budget = { ...REAL, ledger: join(root, "ledger", "ledger.tsv") };
  const pluginDir = join(root, "plugin");
  mkdirSync(pluginDir);
  markConfined(root, pluginDir);
  return { root, bin, record, budget, pluginDir };
};
const calls = (record) => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("the claude command line and environment", () => {
  const args = buildArgs({ prompt: "P", pluginDir: "/plugin", sessionId: "11111111-1111-1111-1111-111111111111" });
  const at = (flag) => args[args.indexOf(flag) + 1];
  it("uses only flags that exist in claude 2.1.296, and no turn flag", () => {
    for (const flag of ["-p", "--model", "--output-format", "--verbose", "--include-hook-events", "--session-id", "--plugin-dir", "--setting-sources", "--settings", "--strict-mcp-config", "--permission-mode", "--permission-prompts", "--allowedTools", "--max-budget-usd"]) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes("--max-turns"), "the CLI has no such flag; the runner counts turns itself");
    assert.ok(!args.includes("--no-session-persistence"));
  });
  it("runs haiku, streaming JSON, with the copied plugin, user settings left out and a hard cost cap", () => {
    assert.equal(at("--model"), "haiku");
    assert.equal(at("--output-format"), "stream-json");
    assert.equal(at("--plugin-dir"), "/plugin");
    assert.equal(at("--setting-sources"), "project,local");
    assert.deepEqual(JSON.parse(at("--settings")).enabledPlugins, { "jev@jev-private": false });
    assert.equal(at("--max-budget-usd"), String(LIMITS.maxBudgetUsd));
    assert.equal(args[1], "P");
  });
  it("confines file tools to the workspace and the plugin copy, and Bash to a sandbox that fails closed", () => {
    const tools = at("--allowedTools").split(",");
    assert.ok(tools.includes("Skill") && tools.includes("Bash(node:*)"));
    for (const open of ["Read", "Edit", "Write", "Glob", "Grep"]) assert.ok(!tools.includes(open), `${open} must not be allowed without a path`);
    assert.deepEqual(tools.filter((tool) => tool.startsWith("Read(")), ["Read(//plugin/**)"], "only the plugin copy may be read from outside the workspace");
    assert.equal(at("--permission-prompts"), "none", "anything that would ask is refused");
    assert.ok(ALLOWED_TOOLS.split(",").every((tool) => tools.includes(tool)));
    const settings = JSON.parse(at("--settings"));
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    const { filesystem: _paths, ...sandboxFlags } = settings.sandbox;
    assert.deepEqual(sandboxFlags, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
    assert.deepEqual(settings.sandbox.filesystem.denyRead, ["~/", realpathSync("/tmp"), realpathSync(tmpdir())], "the home folder, /tmp and the system temporary folder are unreadable to the shell");
    assert.ok(settings.sandbox.filesystem.allowRead.includes("<session>"), "the session folder is allowed back (a placeholder in the fingerprint, the real folder in a run)");
    assert.ok(settings.sandbox.filesystem.allowRead.includes("/plugin"), "the plugin copy stays readable");
    assert.ok(settings.sandbox.filesystem.allowRead.some((p) => process.execPath.startsWith(p)), "the node installation stays readable, or node itself would not start");
    assert.ok(!args.includes("--add-dir") && !args.includes("--dangerously-skip-permissions"));
  });
  it("changes the fingerprint when any permission argument changes, and only then", () => {
    const base = confinementFingerprint(args);
    assert.equal(confinementFingerprint(buildArgs({ prompt: "other", pluginDir: "/plugin", sessionId: "22222222-2222-2222-2222-222222222222", model: "sonnet" })), base, "prompt, id and model are not permissions");
    assert.notEqual(confinementFingerprint(buildArgs({ prompt: "P", pluginDir: "/elsewhere", sessionId: "x" })), base);
    assert.notEqual(confinementFingerprint([...args, "--add-dir", "/Users"]), base);
    assert.notEqual(confinementFingerprint(args.map((a) => (a === "none" ? "host" : a))), base);
    assert.notEqual(confinementFingerprint(args, ["PATH", "HOME"]), confinementFingerprint(args, ["PATH", "HOME", "CLAUDE_CODE_TMPDIR"]), "an environment key that decides the temporary folder is part of what the probe proved");
    assert.equal(permissionFingerprint({ pluginDir: "/plugin" }), permissionFingerprint({ pluginDir: "/plugin", model: "sonnet" }), "the model is not a permission");
  });
  it("starts from a minimal environment and sets the switch only for the OFF arm", () => {
    const parent = { PATH: "/bin", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", JEV_FLOW: "on", APANA_LOGIC_TEST_DEBUG: "on", SECRET_TOKEN: "s" };
    const on = buildEnv({ arm: "ON", parentEnv: parent, cacheDir: "/c" });
    const off = buildEnv({ arm: "OFF", parentEnv: parent, cacheDir: "/c" });
    for (const env of [on, off]) {
      assert.equal(env.PATH, "/bin");
      assert.equal(env.HOME, "/h");
      assert.ok(!("CLAUDECODE" in env) && !("CLAUDE_CODE_ENTRYPOINT" in env) && !("JEV_FLOW" in env) && !("SECRET_TOKEN" in env));
      assert.equal(env.JEV_FLOW_CACHE_DIR, "/c/flow");
    }
    assert.ok(!("APANA_LOGIC_TEST_DEBUG" in on));
    assert.equal(off.APANA_LOGIC_TEST_DEBUG, "off");
  });
  it("picks the prompt of a scenario and the right non-code prompt by run number", () => {
    assert.match(promptFor("activation", 1), /^Explain the Boolean condition/);
    assert.match(promptFor("nocode", 3), /^Fix my CV/);
    assert.equal(promptFor("nocode", 9), undefined);
  });
});

describe("runSession with a stand-in binary (no model is started)", () => {
  it("runs, scores and evaluates a complete session and closes the ledger line with its cost", async () => {
    const { root, bin, record, budget, pluginDir } = setup();
    const verdict = await runSession({ budget, scenario: "activation", arm: "ON", run: 1, claudeBin: bin, pluginDir, root });
    assert.equal(verdict.status, "complete");
    assert.equal(verdict.model.resolved, "claude-haiku-fake");
    assert.equal(verdict.turns, 2, "three assistant events, two model responses (they share a message id)");
    assert.equal(verdict.score.loaded, "loaded");
    assert.equal(verdict.score.directiveDelivered, true);
    assert.equal(verdict.score.record.present, true);
    assert.equal(verdict.evaluation.success, true, JSON.stringify(verdict.evaluation.oracle));
    assert.equal(verdict.usd, 0.04);
    const [call] = calls(record);
    assert.equal(call.argv[0], "-p");
    assert.ok(call.cwd.includes("ltd-activation-") && !call.cwd.includes("eval"), "a fresh workspace outside the repository");
    assert.ok(!Object.keys(call.env).some((k) => /^(CLAUDE(?!_CODE_TMPDIR)|JEV_LOGIC)/.test(k)), "ON arm: no switch, no inherited variable");
    assert.ok(call.cwd.startsWith(verdict.sessionParent), "the workspace lies inside the session's private folder");
    assert.equal(call.env.CLAUDE_CODE_TMPDIR, join(verdict.sessionParent, "t"));
    assert.ok(call.env.CLAUDE_CODE_TMPDIR.startsWith(realpathSync(process.env.LTD_SESSIONS_BASE)), "the test base, not /tmp");
    const rows = readLedger(budget.ledger);
    assert.deepEqual(rows.map((r) => r.status), ["started", "complete"]);
    assert.equal(rows[1].usd, 0.04);
    for (const file of ["transcript.jsonl", "stderr.txt", "command.json", "final.txt", "verdict.json"]) assert.ok(existsSync(join(verdict.dir, file)), file);
  });
  it("passes the switch to the OFF arm only", async () => {
    const { root, bin, record, budget, pluginDir } = setup();
    await runSession({ budget, scenario: "activation", arm: "OFF", run: 1, claudeBin: bin, pluginDir, root });
    assert.equal(calls(record)[0].env.APANA_LOGIC_TEST_DEBUG, "off");
  });
  it("stops a session that goes over the turn limit and records it as incomplete", async () => {
    const { root, bin, budget, pluginDir } = setup();
    setMode(root, "turns");
    const verdict = await runSession({ budget, scenario: "activation", arm: "ON", run: 1, claudeBin: bin, pluginDir, root, limits: { ...LIMITS, maxTurns: 5 } });
    assert.equal(verdict.status, "limit-turns");
    assert.equal(verdict.limit, "turns");
    assert.equal(verdict.score.limitExit, true);
    assert.equal(verdict.score.loaded, "unknown");
    assert.equal(verdict.evaluation.success, false);
  });
  it("stops a session that goes over the time limit", async () => {
    const { root, bin, budget, pluginDir } = setup();
    setMode(root, "hang");
    const verdict = await runSession({ budget, scenario: "bug", arm: "ON", run: 1, claudeBin: bin, pluginDir, root, limits: { ...LIMITS, timeoutMs: 700 } });
    assert.equal(verdict.status, "limit-time");
    assert.equal(verdict.evaluation.success, false);
  });
  it("refuses to start when the budget says no, and then never calls the binary", async () => {
    const { root, bin, record, budget, pluginDir } = setup();
    for (let n = 1; n <= 4; n += 1) startBudgeted(budget, { kind: "planned", scenario: "activation", arm: "ON", run: String(n), model: "haiku" });
    await assert.rejects(runSession({ budget, scenario: "activation", arm: "ON", run: 5, claudeBin: bin, pluginDir, root }), /^Error: refused: /);
    assert.deepEqual(calls(record), []);
  });
  it("runs a non-code prompt in an empty working directory and has no oracle", async () => {
    const { root, bin, record, budget, pluginDir } = setup();
    const verdict = await runSession({ budget, scenario: "nocode", arm: "ON", run: 3, claudeBin: bin, pluginDir, root });
    assert.equal(verdict.evaluation, null);
    assert.equal(calls(record)[0].argv[1], "Fix my CV.");
  });
});

describe("confinement: the start gate and the probe", () => {
  it("refuses a campaign session until a probe has passed for these exact permissions, and never calls the binary", async () => {
    const { root, bin, record, budget, pluginDir } = setup();
    rmSync(join(root, "confinement.json"));
    await assert.rejects(runSession({ budget, scenario: "activation", arm: "ON", run: 1, claudeBin: bin, pluginDir, root }), /^Error: refused: confinement is not proven/);
    writeFileSync(join(root, "confinement.json"), JSON.stringify({ pass: true, fingerprint: "stale" }));
    await assert.rejects(runSession({ budget, scenario: "activation", arm: "ON", run: 1, claudeBin: bin, pluginDir, root }), /confinement is not proven/);
    writeFileSync(join(root, "confinement.json"), JSON.stringify({ pass: false, fingerprint: permissionFingerprint({ pluginDir }) }));
    await assert.rejects(runSession({ budget, scenario: "activation", arm: "ON", run: 1, claudeBin: bin, pluginDir, root }), /confinement is not proven/);
    assert.deepEqual(calls(record), []);
    assert.deepEqual(readLedger(budget.ledger), [], "a refused start leaves no ledger line");
  });
  // The probe tells /tmp from $TMPDIR and checks that each is refused; on Linux they are the same folder, and the harness was only built and measured on macOS.
  it("passes a probe in which every outside step is refused and the inside step works, and then opens the gate", { skip: process.platform !== "darwin" && "the probe separates /tmp from $TMPDIR, which are one folder on Linux" }, async () => {
    const { root, bin, budget, pluginDir } = setup();
    rmSync(join(root, "confinement.json"));
    setMode(root, "probe-confined");
    const verdict = await runSession({ budget, scenario: "confine", arm: "OFF", run: 1, kind: "reserve", claudeBin: bin, pluginDir, root });
    assert.equal(verdict.evaluation.success, true, JSON.stringify(verdict.evaluation.probe));
    assert.equal(verdict.evaluation.probe.attempts.length, 10);
    assert.deepEqual(verdict.evaluation.probe.exercised, ["Read", "Write", "Bash read", "Bash write", "Bash sibling /tmp read", "Bash sibling temp read", "Bash /tmp write"]);
    assert.equal(verdict.evaluation.probe.tmpdirPrivate, true, "the session printed a $TMPDIR inside its private folder");
    assert.equal(verdict.evaluation.probe.tmpWriteOk, true);
    assert.deepEqual(verdict.evaluation.probe.notExercised, ["Glob", "Grep", "Edit"], "steps that failed for another reason are listed, not counted");
    const proof = JSON.parse(readFileSync(join(root, "confinement.json"), "utf8"));
    assert.equal(proof.pass, true);
    setMode(root, "normal");
    const next = await runSession({ budget, scenario: "activation", arm: "ON", run: 1, claudeBin: bin, pluginDir, root });
    assert.equal(next.status, "complete", "the gate opened for the same permissions");
    assert.deepEqual(next.outside, [], "a stand-in session that stays inside is not flagged");
  });
  it("fails a probe whose $TMPDIR is the shared one or cannot be written, and removes its sibling sentinels afterwards", async () => {
    const { root, bin, budget, pluginDir } = setup();
    rmSync(join(root, "confinement.json"));
    setMode(root, "probe-confined", join(root, "record.jsonl"), { sharedTmp: true });
    const shared = await runSession({ budget, scenario: "confine", arm: "OFF", run: 1, kind: "reserve", claudeBin: bin, pluginDir, root });
    assert.equal(shared.evaluation.probe.tmpdirPrivate, false);
    assert.match(shared.evaluation.probe.reasons.join(" "), /\$TMPDIR as the session saw it \(\/tmp\/claude-501\) is not inside its private folder/);
    assert.equal(shared.evaluation.success, false);
    setMode(root, "probe-confined", join(root, "record.jsonl"), { tmpWriteFails: true });
    const unwritable = await runSession({ budget, scenario: "confine", arm: "OFF", run: 2, kind: "reserve", claudeBin: bin, pluginDir, root });
    assert.equal(unwritable.evaluation.probe.tmpWriteOk, false);
    assert.equal(unwritable.evaluation.success, false);
    const left = readdirSync("/tmp").filter((f) => f.startsWith("l-sibling-") || f.startsWith("l-probe-w-"));
    assert.deepEqual(left, [], "the sibling sentinels in /tmp are removed after the probe");
    assert.equal(readdirSync(realpathSync(tmpdir())).filter((f) => f.startsWith("l-sibling-")).length, 0, "and the one in the system temporary folder too");
  });
  it("fails a probe that leaks the sentinel or changes it, and keeps the gate closed", async () => {
    const { root, bin, budget, pluginDir } = setup();
    rmSync(join(root, "confinement.json"));
    setMode(root, "probe-leaky");
    const verdict = await runSession({ budget, scenario: "confine", arm: "OFF", run: 1, kind: "reserve", claudeBin: bin, pluginDir, root });
    assert.equal(verdict.evaluation.success, false);
    const reasons = verdict.evaluation.probe.reasons.join(" | ");
    assert.match(reasons, /token came back/);
    assert.match(reasons, /Read on a sentinel was not refused/);
    assert.match(reasons, /new files in the sentinel directory: new.txt/);
    assert.equal(JSON.parse(readFileSync(join(root, "confinement.json"), "utf8")).pass, false);
    await assert.rejects(runSession({ budget, scenario: "bug", arm: "ON", run: 1, claudeBin: bin, pluginDir, root }), /confinement is not proven/);
  });
  it("does not count a probe as passed when the inside step failed or too few outside steps were tried", async () => {
    const { root, bin, budget, pluginDir } = setup();
    rmSync(join(root, "confinement.json"));
    setMode(root, "probe-confined", join(root, "record.jsonl"), { control: false });
    const verdict = await runSession({ budget, scenario: "confine", arm: "OFF", run: 1, kind: "reserve", claudeBin: bin, pluginDir, root });
    assert.equal(verdict.evaluation.probe.controlOk, false);
    assert.equal(verdict.evaluation.success, false, "a sandbox that blocks the workspace too proves nothing useful");
    setMode(root, "probe-confined", join(root, "record.jsonl"), { unrelated: true });
    const hollow = await runSession({ budget, scenario: "confine", arm: "OFF", run: 3, kind: "reserve", claudeBin: bin, pluginDir, root });
    assert.equal(hollow.evaluation.probe.inconclusive, true, "refusals that name no path rule prove nothing");
    assert.equal(hollow.evaluation.success, false);
    setMode(root, "normal");
    const quiet = await runSession({ budget, scenario: "confine", arm: "OFF", run: 2, kind: "reserve", claudeBin: bin, pluginDir, root });
    assert.equal(quiet.evaluation.probe.inconclusive, true, "no outside attempt was made");
    assert.equal(quiet.evaluation.success, false);
  });
});

describe("the private session folder", () => {
  it("is short enough for the CLI's temporary-folder limit under the default base, and holds a scratch folder", () => {
    const saved = process.env.LTD_SESSIONS_BASE;
    delete process.env.LTD_SESSIONS_BASE;
    try {
      const session = makeSessionDir("s123");
      assert.ok(Buffer.byteLength(session.scratch) <= 30, `${session.scratch} is ${Buffer.byteLength(session.scratch)} bytes`);
      assert.ok(session.parent.startsWith(realpathSync("/tmp")));
      assert.ok(existsSync(session.scratch));
      rmSync(session.parent, { recursive: true, force: true });
    } finally {
      process.env.LTD_SESSIONS_BASE = saved;
    }
  });
});

describe("the plugin copy under test", () => {
  it("is a git archive of HEAD without the MCP server, reused while HEAD is unchanged", () => {
    const repo = tmp("repo");
    const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
    git("init", "-q");
    mkdirSync(join(repo, ".claude-plugin"));
    writeFileSync(join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "jev", version: "9.9.9", mcpServers: { jev: { command: "npx" } } }));
    writeFileSync(join(repo, "extra.txt"), "x");
    git("add", ".");
    git("commit", "-q", "-m", "x");
    const dest = join(tmp("copy"), "plugin");
    const first = ensurePluginCopy({ repo, dest });
    const plugin = JSON.parse(readFileSync(join(dest, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(plugin.version, "9.9.9");
    assert.ok(!("mcpServers" in plugin));
    assert.ok(existsSync(join(dest, "extra.txt")));
    writeFileSync(join(dest, "marker-of-reuse"), "1");
    assert.equal(ensurePluginCopy({ repo, dest }).commit, first.commit);
    assert.ok(existsSync(join(dest, "marker-of-reuse")), "same commit: reused, not rebuilt");
  });
});
