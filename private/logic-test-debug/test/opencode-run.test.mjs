import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LOGIC_DIRECTIVE } from "../check.mjs";
import { sessionConfig, summarizeRequests } from "../eval/opencode/run.mjs";
import { startStub } from "../eval/opencode/stub-provider.mjs";

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ltd-ocr-"));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const row = (n, body) => JSON.stringify({ n, method: "POST", url: "/v1/chat/completions", body });
const main = (system, extra = []) => ({
  model: "m",
  tools: [{ function: { name: "skill" } }, { function: { name: "read" } }],
  messages: [{ role: "system", content: system }, { role: "user", content: '"Fix the bug"' }, ...extra],
});

describe("summarizeRequests", () => {
  it("separates the title request from the main ones and reads the directive, the skill list and the skill body", () => {
    const withDirective = `x <skill><id>logic-test-debug</id></skill> ${LOGIC_DIRECTIVE}`;
    const log = [
      row(1, main(withDirective)),
      row(2, { model: "m", messages: [{ role: "system", content: "You are a title generator" }, { role: "user", content: "x" }] }),
      row(3, main("x <skill><id>logic-test-debug</id></skill>", [{ role: "tool", content: "<skill_content>\n## Work record\n</skill_content>" }])),
    ].join("\n");
    const s = summarizeRequests(log);
    assert.equal(s.requests, 3);
    assert.equal(s.mainRequests, 2);
    assert.deepEqual(s.directiveInSystem, [true, false]);
    assert.deepEqual(s.skillListed, [true, true]);
    assert.equal(s.skillBodyReturned, true);
    assert.deepEqual(s.tools, ["skill", "read"]);
    assert.equal(s.lastUserText, '"Fix the bug"');
  });
  it("reports nothing found for a session without the plugin", () => {
    const s = summarizeRequests(row(1, main("plain system prompt")));
    assert.deepEqual(s.directiveInSystem, [false]);
    assert.deepEqual(s.skillListed, [false]);
    assert.equal(s.skillBodyReturned, false);
  });
  it("accepts system content given as a list of text parts", () => {
    const s = summarizeRequests(row(1, main([{ type: "text", text: LOGIC_DIRECTIVE }])));
    assert.deepEqual(s.directiveInSystem, [true]);
  });
});

describe("sessionConfig", () => {
  it("points the stand-in provider at the local port, lists the plugin and carries no secret", () => {
    const config = sessionConfig({ pluginDir: "/p", port: 4321 });
    assert.deepEqual(config.plugin, ["/p"]);
    assert.equal(config.provider.stub.options.baseURL, "http://127.0.0.1:4321/v1");
    assert.equal(config.provider.stub.options.apiKey, "stub");
    assert.equal(config.model, "stub/m");
    assert.ok(config.mcp.servers.jev, "a harmless jev server entry keeps the plugin from starting the real one");
    assert.equal(JSON.stringify(config).match(/key|token|secret/gi)?.length, 1, "only the fixed apiKey placeholder");
  });
  it("leaves out the plugin and the server entry when asked", () => {
    const config = sessionConfig({ pluginDir: "/p", port: 1, withPlugin: false });
    assert.equal(config.plugin, undefined);
    assert.equal(config.mcp, undefined);
  });
  it("takes several plugin folders", () => {
    assert.deepEqual(sessionConfig({ pluginDir: ["/a", "/b"], port: 1 }).plugin, ["/a", "/b"]);
  });
});

describe("stub provider", () => {
  const post = async (stub, body) => {
    const res = await fetch(`http://127.0.0.1:${stub.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  it("answers with text and records the request", async () => {
    const logFile = join(tempDir(), "requests.jsonl");
    const stub = await startStub({ logFile, mode: "text", reply: "hello" });
    try {
      const res = await post(stub, { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
      assert.equal(res.status, 200);
      assert.match(res.text, /"content":"hello"/);
      assert.match(res.text, /data: \[DONE\]/);
      const rows = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].body.messages[0].content, "hi");
    } finally {
      await stub.close();
    }
  });
  it("calls the skill tool once in load-skill mode, then answers with text", async () => {
    const stub = await startStub({ logFile: join(tempDir(), "requests.jsonl"), mode: "load-skill", skillId: "demo" });
    try {
      const tools = [{ type: "function", function: { name: "skill" } }];
      const first = await post(stub, { model: "m", tools, messages: [{ role: "user", content: "x" }] });
      assert.match(first.text, /"name":"skill"/);
      assert.match(first.text, /demo/);
      assert.match(first.text, /"finish_reason":"tool_calls"/);
      const second = await post(stub, { model: "m", tools, messages: [{ role: "user", content: "x" }, { role: "tool", content: "body" }] });
      assert.doesNotMatch(second.text, /"name":"skill"/);
      assert.match(second.text, /"finish_reason":"stop"/);
    } finally {
      await stub.close();
    }
  });
  it("refuses other routes", async () => {
    const stub = await startStub({ logFile: join(tempDir(), "requests.jsonl") });
    try {
      const res = await fetch(`http://127.0.0.1:${stub.port}/v1/other`, { method: "POST", body: "{}" });
      assert.equal(res.status, 404);
    } finally {
      await stub.close();
    }
  });
});
