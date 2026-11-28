// The plugin on a real OpenCode 2.4.x: a private server (own HOME and XDG folders), a stand-in provider on 127.0.0.1 that records
// every request and calls the tools a test scripts, no credentials, no cost. Off unless APANA_OPENCODE_RUNTIME=1, and only for
// the version it was written for: a run that skips proves nothing about OpenCode.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CLAUDE_ONLY_SKILLS, OPENCODE_SKILLS, ROOT } from "../catalog.mjs";
import { tempDir } from "./support/fake-ctx.mjs";
import { opencodeVersion, startRuntime, textOfRole } from "./support/runtime.mjs";

const version = process.env.APANA_OPENCODE_RUNTIME === "1" ? opencodeVersion() : null;
const reason = process.env.APANA_OPENCODE_RUNTIME !== "1" ? "set APANA_OPENCODE_RUNTIME=1 to run the tests on a real OpenCode" : !/^v?2\.4\./.test(version ?? "") ? `written for OpenCode 2.4.x, found ${version}` : false;
const JEV = join(ROOT, "skills", "jev-decision-loop", "scripts", "jev.mjs");

const open = [];
const start = async (options) => {
  const rt = await startRuntime({ dir: join(tempDir("apana-rt-"), "run"), plugin: ROOT, ...options });
  open.push(rt);
  await rt.ready();
  return rt;
};
after(async () => {
  for (const rt of open) await rt.close();
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await wait(100);
  }
  throw new Error(message);
}
/** Waits until the stand-in provider has had `n` requests that offered tools and then stays quiet for a moment. */
async function settle(rt, n, ms = 30000) {
  const end = Date.now() + ms;
  let last = -1;
  while (Date.now() < end) {
    await wait(700);
    const count = rt.mainRequests().length;
    if (count >= n && count === last) return;
    last = count;
  }
  throw new Error(`expected ${n} requests, saw ${rt.mainRequests().length}\n${rt.log().split("\n").filter((l) => /ERROR/.test(l)).slice(-3).join("\n")}`);
}
const toolResults = (request) => (request.body.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
const stateFiles = (rt, name) => {
  const dir = join(rt.dir, "state", "opencode", "apana", name);
  try {
    return readdirSync(dir).map((f) => join(dir, f));
  } catch {
    return [];
  }
};

describe("on a real OpenCode 2.4.x", { skip: reason, timeout: 600000 }, () => {
  it("registers the OpenCode skills and their commands, and none of the tools of Claude Code", { timeout: 90000 }, async () => {
    const rt = await start({});
    const ids = (await rt.skills()).map((s) => s.id);
    for (const id of OPENCODE_SKILLS) assert.ok(ids.includes(id), `${id} is registered`);
    for (const id of CLAUDE_ONLY_SKILLS) assert.ok(!ids.includes(id), `${id} is not registered`);
    const names = (await rt.commands()).map((c) => c.name);
    for (const id of OPENCODE_SKILLS) assert.ok(names.includes(`apana:${id}`), `apana:${id}`);
    assert.ok(names.includes("apana:explica-optiuni"));
    for (const id of CLAUDE_ONLY_SKILLS) assert.ok(!names.includes(`apana:${id}`), `no command for ${id}`);
    assert.ok(!/\[apana\]|\[logic-test-debug\]/.test(rt.log()), "no warning of the plugin");
    const session = await rt.session();
    await rt.prompt(session, "hello there");
    await settle(rt, 1);
    const system = textOfRole(rt.mainRequests()[0], "system");
    assert.ok(system.includes("<id>scope</id>") && system.includes("<id>variant-check</id>"));
    assert.ok(!system.includes("<id>compact-session</id>"), "compact-session is explicit-only: not offered to the model");
    assert.ok(!system.includes("<id>claude-openai</id>"));
  });

  it("runs a command with its arguments untouched: the text and the skill reach the model", { timeout: 90000 }, async () => {
    const rt = await start({});
    const session = await rt.session();
    const args = 'path with "quotes", $1 $& ünï 𐍈';
    assert.equal((await rt.command(session, "apana:explica-optiuni", args)).status, 204);
    await settle(rt, 1);
    const user = textOfRole(rt.mainRequests()[0], "user");
    assert.ok(user.includes(`Subiect și context:\n${args}`), user.slice(-200));
    assert.ok(!user.includes("$ARGUMENTS"));
    const rt2 = await start({});
    const s2 = await rt2.session();
    assert.equal((await rt2.command(s2, "apana:variant-check", "src/**/*.kt")).status, 204);
    await settle(rt2, 1);
    const text = textOfRole(rt2.mainRequests()[0], "user");
    assert.ok(text.includes("/apana:variant-check src/**/*.kt"));
    assert.ok(text.includes("OpenCode adapter. The tool names") && text.includes(`${join(ROOT, "skills", "variant-check")}/scripts/variants.mjs`), "the skill's adapted text came with the message");
  });

  it("Advisor waits for the in-flight read and delivers one native reply before the next inference", { timeout: 90000 }, async () => {
    const path = tempDir("apana-advisor-plugin-");
    const inTool = join(path, "in-tool");
    const release = join(path, "release");
    writeFileSync(join(path, "server.js"), `
      import { existsSync, writeFileSync } from "node:fs";
      import apana from ${JSON.stringify(join(ROOT, "opencode-plugin.js"))};
      export default { id: "apana-advisor-test", async setup(ctx) {
        const dispose = await apana.setup(ctx);
        await ctx.tool.hook("execute.before", async (event) => {
          if (event.tool !== "read") return;
          writeFileSync(${JSON.stringify(inTool)}, "");
          while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
        });
        return dispose;
      }};
    `);
    const rt = await start({
      plugin: path,
      script: [{ name: "read", args: { path: "fixture.txt" } }, { name: "apana_advisor_archive", args: { path: "blobs/R0000.txt" } }],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { stub: { models: {
        m: { variants: { deep: { reasoningEffort: "high" } } },
        alternative: { name: "Alternative", tool_call: true, limit: { context: 80_000, output: 4_000 } },
      } } } }) },
      setup: (sub) => writeFileSync(sub("ws/fixture.txt"), `${"SOURCE_FILE_RESULT\n".repeat(90)}LAST_LINE_OF_ARCHIVED_RESULT\n`),
    });
    const source = await rt.session("Source");
    const rpc = (method, input = {}) => rt.api("POST", `/api/rpc/apana-advisor/${method}`, { input: { sessionID: source, ...input } });
    const models = await rpc("options");
    assert.equal(models.status, 200, `${models.text}\n${rt.log().slice(-10000)}`);
    assert.equal(models.json.output.models.find(({ providerID }) => providerID === "stub").id, "alternative", "ranks a different model ahead of the source default");
    assert.ok(models.json.output.models.find(({ id }) => id === "m").variants.includes("deep"));
    await rt.prompt(source, "SOURCE_CONVERSATION");
    await until(() => existsSync(inTool), "source read did not start");
    const consultation = rpc("consult", { providerID: "stub", modelID: "m", variant: "deep", question: "ADVISOR_QUESTION" });
    try {
      await until(async () => {
        const check = await rpc("consult", { providerID: "stub", modelID: "missing", question: "" });
        return check.text.includes("already running");
      }, "consultation did not register");
      assert.equal(rt.mainRequests().length, 1);
    } finally {
      writeFileSync(release, "");
    }
    const result = await consultation;
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.output.ok, true, `${result.text}\n${rt.log().slice(-5000)}`);
    const requests = await until(() => rt.mainRequests().length >= 4 && rt.mainRequests(), "source did not resume");
    const [primary, advisor, afterRead, resumed] = requests;
    assert.match(textOfRole(primary, "user"), /SOURCE_CONVERSATION/);
    assert.match(textOfRole(advisor, "user"), /ADVISOR_QUESTION/, JSON.stringify(requests.map((req) => ({
      user: textOfRole(req, "user"), tools: req.body.tools.map((tool) => tool.function.name),
      results: toolResults(req).join("\n").slice(0, 300), effort: req.body.reasoning_effort,
    }))));
    assert.equal(advisor.body.reasoning_effort, "high");
    assert.deepEqual(advisor.body.tools.map((tool) => tool.function.name).sort(), ["apana_advisor_archive", "glob", "grep", "read"]);
    for (const name of ["glob", "grep", "read"]) {
      const original = primary.body.tools.find(({ function: tool }) => tool.name === name).function;
      const advertised = advisor.body.tools.find(({ function: tool }) => tool.name === name).function;
      assert.deepEqual(advertised.parameters, original.parameters);
      assert.ok(advertised.description.length < original.description.length, `${name} kept its full description`);
    }
    assert.match(textOfRole(advisor, "user"), /SOURCE_CONVERSATION/);
    assert.match(textOfRole(advisor, "user"), /MARKER-PAIR:/);
    assert.match(textOfRole(advisor, "user"), /Each Rnnnn marker previews one record/);
    const archive = toolResults(afterRead).join("\n");
    assert.match(archive, /"next": null/);
    assert.match(archive, /1: SOURCE_FILE_RESULT\n2: SOURCE_FILE_RESULT/);
    assert.match(archive, /LAST_LINE_OF_ARCHIVED_RESULT/);
    assert.match(toolResults(resumed).join("\n"), /SOURCE_FILE_RESULT/);
    assert.equal((textOfRole(resumed, "user").match(/<background-result\b/g) ?? []).length, 1);
    await until(async () => JSON.stringify(await rt.messages(source)).includes("<background-result"), "native reply did not reach history");
    assert.equal((JSON.stringify(await rt.messages(source)).match(/<background-result\b/g) ?? []).length, 1);
    const notes = join(rt.dir, "data", "opencode", "apana", "handoffs", "advisor");
    const folder = join(notes, readdirSync(notes)[0]);
    const blobs = join(folder, "blobs");
    assert.ok(readdirSync(blobs).some((name) => readFileSync(join(blobs, name), "utf8").includes("SOURCE_FILE_RESULT")), "archive contains the completed read output");
  });

  it("Advisor includes a medium transcript in one inference and wakes the idle source", { timeout: 90000 }, async () => {
    const rt = await start({});
    const source = await rt.session("Idle source");
    const consult = (sessionID, modelID = "m") => rt.api("POST", "/api/rpc/apana-advisor/consult", { input: { sessionID, providerID: "stub", modelID, question: "" } });
    const invalid = await consult(source, "unknown-model");
    assert.deepEqual(invalid.json.output, { ok: false, message: "That model or effort is no longer available. Choose again." });
    const empty = await consult(source);
    assert.deepEqual(empty.json.output, { ok: false, message: "The verified handoff could not be prepared." });
    assert.equal(rt.requests().length, 0, "failed handoff did not call a provider");
    await rt.prompt(source, `${"Earlier notes about the integration decision.\n".repeat(300)}IDLE_SOURCE_EVIDENCE`);
    const end = await rt.api("POST", `/api/experimental/session/${source}/wait`, {});
    assert.equal(end.status, 204, end.text);
    const result = await consult(source);
    assert.equal(result.json.output.ok, true, `${result.text}\n${rt.log().slice(-5000)}`);
    const requests = await until(() => rt.mainRequests().length >= 3 && rt.mainRequests(), "the idle source did not wake");
    const advisor = requests.filter((req) => req.body.tools.some((tool) => tool.function.name === "apana_advisor_archive"));
    assert.equal(advisor.length, 1);
    assert.match(textOfRole(advisor[0], "user"), /IDLE_SOURCE_EVIDENCE/);
    assert.match(textOfRole(advisor[0], "user"), /The verified HANDOFF\.md follows/);
    assert.doesNotMatch(textOfRole(advisor[0], "user"), /MARKER-PAIR:|Each Rnnnn marker previews one record/);
    assert.doesNotMatch(textOfRole(advisor[0], "user"), /Ce faci după ce l-ai citit/);
    assert.match(textOfRole(requests.at(-1), "user"), /<background-result\b/);
    assert.doesNotMatch(textOfRole(requests.at(-1), "user"), /The verified HANDOFF\.md/);
  });

  it("loads Harness² and runs its read-only check through the bundled helper", { timeout: 90000 }, async () => {
    const helper = join(ROOT, "skills", "harness2", "scripts", "setup.py");
    const rt = await start({ script: [{ name: "shell", args: { command: `python3 ${JSON.stringify(helper)} check` } }] });
    const session = await rt.session();
    assert.equal((await rt.command(session, "apana:harness2", "check")).status, 204);
    await settle(rt, 2);
    const [first, second] = rt.mainRequests();
    assert.ok(textOfRole(first, "user").includes(`python3 "${helper}" check`));
    const result = toolResults(second).join("\n");
    assert.match(result, /Harness²: not installed|Harness² stopped .*requires native macOS arm64/);
    assert.ok(!readdirSync(rt.home).includes(".local"), "the helper did not create its install root");
  });

  it("scope: refuses an edit while it investigates, and allows exactly the approved file after the user's approval", { timeout: 180000 }, async () => {
    const script = [{ name: "edit", args: { path: "src/login.js", oldString: "OLD", newString: "NEW" } }];
    const rt = await start({ script });
    mkdirSync(join(rt.ws, "src"));
    writeFileSync(join(rt.ws, "src", "login.js"), "OLD\n");
    const session = await rt.session();
    assert.equal((await rt.command(session, "apana:scope", "Fix login")).status, 204);
    await settle(rt, 2);
    const [first, second] = rt.mainRequests();
    const note = textOfRole(first, "system");
    assert.ok(note.includes("Scope mode is investigating only"), "the model is told");
    assert.match(toolResults(second).join("\n"), /Apana scope: investigation is read-only/);
    assert.equal(readFileSync(join(rt.ws, "src", "login.js"), "utf8"), "OLD\n", "the file was not changed");
    const [stateFile] = stateFiles(rt, "scope").filter((f) => !f.endsWith(".proposal.json"));
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.phase, "investigating");
    writeFileSync(stateFile.replace(/\.json$/, ".proposal.json"), JSON.stringify({ production_changes: [{ path: "src/login.js" }], test_changes: [{ path: "test/login.test.js", production_paths: ["src/login.js"] }], test_commands: ["node --test test/login.test.js"] }));
    script.push({ name: "edit", args: { path: "src/login.js", oldString: "OLD", newString: "NEW" } }, { name: "edit", args: { path: "README.md", content: "x", oldString: "a", newString: "b" } });
    await rt.command(session, "apana:scope", `approve ${state.nonce}`);
    await settle(rt, 5);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).phase, "approved");
    assert.equal(readFileSync(join(rt.ws, "src", "login.js"), "utf8"), "NEW\n", "the approved file was edited");
    const last = rt.mainRequests().at(-1);
    assert.match(toolResults(last).join("\n"), /outside the approved exact-file scope/);
  });

  it("scope: a fork does not inherit the gate of the session it was copied from", { timeout: 120000 }, async () => {
    const script = [];
    const rt = await start({ script, mode: "script" });
    const session = await rt.session();
    await rt.command(session, "apana:scope", "Fix login");
    await settle(rt, 1);
    assert.equal(stateFiles(rt, "scope").length, 1);
    const fork = await rt.api("POST", `/api/session/${session}/fork`, {});
    assert.equal(fork.status, 200, fork.text);
    const forkID = fork.json.data.id ?? fork.json.data.sessionID;
    script.push({ name: "write", args: { path: "free.txt", content: "hello" } });
    await rt.prompt(forkID, "write a file");
    await settle(rt, 3);
    assert.equal(readFileSync(join(rt.ws, "free.txt"), "utf8"), "hello", "the fork can edit");
    assert.equal(stateFiles(rt, "scope").length, 1, "no state was created for the fork");
    assert.ok(!textOfRole(rt.mainRequests().at(-1), "system").includes("Apana scope"), "the fork is not told about a scope that is not its own");
    await rt.prompt(session, "and the original?");
    script.push({ name: "write", args: { path: "blocked.txt", content: "no" } });
    await settle(rt, 5);
    assert.match(toolResults(rt.mainRequests().at(-1)).join("\n"), /Apana scope: investigation is read-only/, "the original session is still gated");
  });

  it("Jev decision loop: refuses a call no decision allows and Code Mode, and `jev.mjs --off` ends it", { timeout: 180000 }, async () => {
    const script = [
      { name: "read", args: { path: join(ROOT, "package.json") } },
      { name: "execute", args: { code: "return 1" } },
      { name: "shell", args: { command: `node ${JEV} --off` } },
      { name: "read", args: { path: join(ROOT, "package.json") } },
    ];
    const rt = await start({ script });
    const session = await rt.session();
    await rt.command(session, "apana:jev-decision-loop", "");
    await settle(rt, 5);
    const results = rt.mainRequests().map((r) => toolResults(r).at(-1) ?? "");
    assert.match(results[1], /No Jev decision allows this tool call/);
    assert.match(results[2], /Code Mode \(`execute`\) is refused/);
    assert.match(results[3], /JEV LOOP OFF/);
    assert.match(results[4], /"name": "apana-plugin"/);
  });

  it("Jev decision loop: checks the end of a turn once", { timeout: 120000 }, async () => {
    const rt = await start({});
    const session = await rt.session();
    await rt.command(session, "apana:jev-decision-loop", "");
    await settle(rt, 2);
    const requests = rt.mainRequests();
    assert.equal(requests.length, 2, "one forced continuation, then the turn ends");
    assert.match(textOfRole(requests[1], "user") + textOfRole(requests[1], "system"), /No Jev decision covers ending this turn/);
  });

  it("compact-session: replaces the context by the verified text, in the same session, with no summarizer request", { timeout: 240000 }, async () => {
    const big = join(tempDir("apana-big-"), "big.txt");
    writeFileSync(big, Array.from({ length: 900 }, (_, i) => `line ${i} of a long tool output`).join("\n"));
    const script = [{ name: "read", args: { path: big, limit: 900 } }];
    const rt = await start({ script });
    const session = await rt.session();
    await rt.prompt(session, "read the big file");
    await settle(rt, 2);
    const before = rt.requests().length;
    assert.equal((await rt.command(session, "apana:compact-session", "")).status, 204);
    await wait(4000);
    const compaction = (await rt.messages(session)).find((m) => m.type === "compaction");
    assert.equal(compaction.status, "completed", JSON.stringify(compaction).slice(0, 400));
    assert.equal(compaction.metadata.keepID, undefined, "no recent tail");
    const { artifact, beforeChars, afterChars } = compaction.metadata.apana;
    assert.ok(beforeChars > afterChars, `${beforeChars} -> ${afterChars} (measured, n=1)`);
    assert.ok(realpathSync(artifact).startsWith(join(realpathSync(rt.home), ".claude", "handoffs")), "the archive is under the sandbox's home, not the user's");
    assert.equal(rt.requests().length, before, "no request went to the model for a summary");
    await rt.prompt(session, "what now?");
    await settle(rt, 3);
    const request = rt.mainRequests().at(-1);
    const user = textOfRole(request, "user");
    assert.ok(user.includes("Same-session compact context") && user.includes("what now?"));
    assert.ok(!user.includes("<recent-context>"), "the replacement is exactly the verified text");
    assert.ok(!user.includes("line 450 of a long tool output"), "the long output moved to recoverable files");
    assert.ok(readFileSync(join(artifact, "..", "blobs", readdirSync(join(artifact, "..", "blobs"))[0]), "utf8").length > 0);
    assert.match(textOfRole(request, "system"), /compact-session result \(completed; do not rerun\): Context compacted in the same session\. Characters \(measured; n=1\): \d+ -> \d+/);
  });

  it("compact-session: a conversation that would not shrink keeps its whole history and says so", { timeout: 180000 }, async () => {
    const rt = await start({});
    const session = await rt.session();
    await rt.prompt(session, "Hello.");
    await settle(rt, 1);
    const before = rt.requests().length;
    await rt.command(session, "apana:compact-session", "");
    await wait(4000);
    const compaction = (await rt.messages(session)).find((m) => m.type === "compaction");
    assert.equal(compaction.status, "failed");
    assert.match(compaction.error.message, /would not reduce the context .* \(no-op\)/);
    assert.equal(rt.requests().length, before, "no summarizer ran");
    await rt.prompt(session, "and now?");
    await settle(rt, 2);
    const request = rt.mainRequests().at(-1);
    assert.ok(textOfRole(request, "user").includes("Hello.") && textOfRole(request, "user").includes("and now?"), "the history is intact");
    assert.match(textOfRole(request, "system"), /Context unchanged: the verified replacement would not reduce context/);
  });
});

describe("the plugin as an installed package", { skip: reason, timeout: 300000 }, () => {
  it("works from an extracted npm pack, not only from the checkout", { timeout: 120000 }, async () => {
    const out = tempDir("apana-pack-");
    const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: ROOT, encoding: "utf8" });
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = join(out, pack.stdout.trim().split("\n").at(-1));
    const unpacked = join(out, "unpacked");
    mkdirSync(unpacked);
    assert.equal(spawnSync("tar", ["-xzf", tarball, "-C", unpacked], { encoding: "utf8" }).status, 0);
    const plugin = join(unpacked, "package");
    const rt = await start({ plugin });
    const ids = (await rt.skills()).map((s) => s.id);
    for (const id of OPENCODE_SKILLS) assert.ok(ids.includes(id), id);
    const variant = (await rt.skills()).find((s) => s.id === "variant-check");
    const real = realpathSync(plugin);
    assert.ok(realpathSync(variant.path).startsWith(real), `the skill is the packaged one: ${variant.path}`);
    assert.ok(variant.content.includes(`${real}/skills/variant-check/scripts/variants.mjs`) || variant.content.includes(`${plugin}/skills/variant-check/scripts/variants.mjs`), "its commands point into the package");
    assert.ok(!/\[apana\]|\[logic-test-debug\]/.test(rt.log()));
  });
});
