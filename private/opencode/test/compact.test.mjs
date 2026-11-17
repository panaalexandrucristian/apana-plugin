// compact.py on messages shaped like those of OpenCode 2.3.0's compaction hook, through the real shared engine (archive, blobs and
// round trip). The shape of the messages is the one recorded from a running 2.3.0 (ids on user and assistant messages, none on tool
// messages) and the one its published schema declares (@opencode/ai 2.3.0, schema/messages).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { tempDir } from "./support/fake-ctx.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "compact.py");
const handoff = join(here, "..", "..", "..", "skills", "compact-handoff", "scripts");

const fixture = () => {
  const home = tempDir("apana-compact-home-");
  return { home, env: { ...process.env, HOME: home } };
};
const run = (f, snapshot) =>
  spawnSync("python3", ["-I", "-B", script], { env: f.env, cwd: f.home, encoding: "utf8", input: typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot), maxBuffer: 32 * 1024 * 1024 });
const ok = (result) => {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ["afterChars", "artifact", "beforeChars", "text"]);
  assert.ok(isAbsolute(value.artifact));
  assert.equal(readFileSync(value.artifact, "utf8"), value.text);
  return value;
};
const refused = (f, result) => {
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.stdout, "", "nothing on stdout for a refusal");
  assert.match(result.stderr, /^compact-session: /);
  assert.deepEqual(readdirSync(f.home), [], "no archive is made for a refusal");
};
const expand = (f, artifact) => {
  const r = spawnSync("python3", ["-I", "-B", join(handoff, "compact_context.py"), "expand", dirname(artifact)], { env: f.env, cwd: f.home, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

const BIG = "tool output line\n".repeat(900);
const conversation = () => [
  { id: "msg_1", role: "user", metadata: { note: "METADATA-SENTINEL" }, content: [{ type: "text", text: "Keep the task. Unicode: 𐍈 ünï", providerMetadata: { x: { y: "PROVIDER-SENTINEL" } } }] },
  { id: "msg_2", role: "assistant", providerMetadata: { x: { y: "MESSAGE-PROVIDER-SENTINEL" } }, content: [
    { type: "reasoning", text: "REASONING-SENTINEL", encrypted: "zzz" },
    { type: "text", text: "I will read it." },
    { type: "tool-call", id: "call_1", name: "read", input: { path: "/p/a.txt" } },
  ] },
  { role: "tool", content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: BIG } }] },
  { id: "msg_3", role: "assistant", content: [
    { type: "tool-call", id: "call_2", name: "search", namespace: "acme", input: { q: "x" }, providerExecuted: true },
    { type: "tool-result", id: "call_2", name: "search", namespace: "acme", providerExecuted: true, result: { type: "json", value: { hits: [1, 2] } } },
    { type: "text", text: "Found it." },
  ] },
  { id: "msg_4", role: "user", content: [{ type: "text", text: "Continue the unfinished task." }] },
];
const snapshot = (messages = conversation()) => ({ sessionId: "ses_x", messages });

describe("compact.py on OpenCode messages", () => {
  it("accepts the ids that OpenCode puts on its messages (the shape that made the first draft refuse every history)", () => {
    const f = fixture();
    const value = ok(run(f, snapshot()));
    assert.ok(value.beforeChars > value.afterChars, `${value.beforeChars} -> ${value.afterChars} (measured, n=1)`);
  });
  it("archives the exact input, keeps long tool output recoverable and renders calls, hosted results and text", () => {
    const f = fixture();
    const raw = JSON.stringify(snapshot(), null, 2) + "\n";
    const result = run(f, raw);
    const value = ok(result);
    const dir = dirname(value.artifact);
    assert.equal(readFileSync(join(dir, "snapshot.json"), "utf8"), raw);
    assert.match(result.stderr, /roundtrip IDENTICAL/);
    const expanded = expand(f, value.artifact);
    assert.ok(expanded.includes(BIG), "the complete output is recoverable");
    assert.ok(expanded.includes("[tool_use read]") && expanded.includes("[tool_use acme_search]"));
    assert.ok(expanded.includes('{"hits": [1, 2]}'), "a hosted result stays");
    for (const text of ["Keep the task. Unicode: 𐍈 ünï", "I will read it.", "Found it.", "Continue the unfinished task."]) assert.ok(value.text.includes(text), text);
    assert.ok(expanded.indexOf("[tool_use read]") < expanded.indexOf(BIG) && expanded.indexOf(BIG) < expanded.indexOf("Found it."), "order is kept");
  });
  it("does not turn metadata, provider metadata or reasoning into text for the model, and keeps them in the archive", () => {
    const f = fixture();
    const value = ok(run(f, snapshot()));
    const expanded = expand(f, value.artifact);
    const archive = readFileSync(join(dirname(value.artifact), "snapshot.json"), "utf8");
    for (const sentinel of ["METADATA-SENTINEL", "PROVIDER-SENTINEL", "MESSAGE-PROVIDER-SENTINEL", "REASONING-SENTINEL"]) {
      assert.ok(!value.text.includes(sentinel) && !expanded.includes(sentinel), `${sentinel} is not rendered`);
      assert.ok(archive.includes(sentinel), `${sentinel} is archived`);
    }
  });
  it("renders system text, an effort change and the text of a provider checkpoint, and a tool input that is not an object", () => {
    const f = fixture();
    const value = ok(run(f, snapshot([
      { id: "msg_1", role: "system", content: [{ type: "text", text: "instruction update" }, { type: "effort", effort: "high", previous: "low" }] },
      { id: "msg_2", role: "user", content: "plain string content" },
      { id: "msg_3", role: "assistant", content: [
        { type: "compaction", provider: "openai", text: "provider summary" },
        { type: "tool-call", id: "c", name: "echo", input: "raw string input" },
        { type: "tool-result", id: "c", name: "echo", result: { type: "error", value: "boom" } },
        { type: "tool-result", id: "d", name: "echo", result: { type: "content", value: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } },
      ] },
    ])));
    const expanded = expand(f, value.artifact);
    for (const text of ["[OpenCode system] instruction update", '[OpenCode effort] {"effort": "high", "previous": "low"}', "plain string content", "[OpenCode provider checkpoint] provider summary", "raw string input", "boom", "a\nb"]) {
      assert.ok(expanded.includes(text), text);
    }
    assert.match(expanded, /\[tool_result ERROR\]/);
  });
  it("refuses media, an encrypted checkpoint and a field it does not know, making no archive", () => {
    const f = fixture();
    const cases = [
      [{ id: "m", role: "user", content: [{ type: "text", text: "x" }, { type: "media", media: { source: { type: "base64", data: "AAAA", mediaType: "image/png" } } }] }],
      [{ id: "m", role: "assistant", content: [{ type: "text", text: "x" }, { type: "compaction", provider: "openai", encrypted: "blob" }] }],
      [{ role: "tool", content: [{ type: "tool-result", id: "c", name: "t", result: { type: "content", value: [{ type: "file", uri: "file:///x", mime: "image/png" }] } }] }],
      [{ id: "m", role: "user", content: [{ type: "text", text: "x" }], surprise: 1 }],
      [{ id: "m", role: "user", content: [{ type: "text", text: "x", surprise: 1 }] }],
      [{ id: "m", role: "robot", content: [{ type: "text", text: "x" }] }],
      [{ id: 5, role: "user", content: [{ type: "text", text: "x" }] }],
      [{ id: "m", role: "user", content: [] }],
      [{ id: "m", role: "user", content: [{ type: "tool-call", id: "c", name: "t", input: {} }] }],
    ];
    for (const messages of cases) {
      const result = run(f, snapshot(messages));
      refused(f, result);
      rmSync(f.home, { recursive: true, force: true });
      mkdirSync(f.home);
    }
    refused(f, run(f, "{not json"));
    refused(f, run(f, { sessionId: "", messages: conversation() }));
    refused(f, run(f, { sessionId: "s", messages: [] }));
    refused(f, run(f, '{"sessionId":"s","messages":[{"role":"user","content":"a","content":"b"}]}'));
  });
  it("a later compaction keeps the earlier artifacts and their blobs unchanged, and the earlier text is part of the next one", () => {
    const f = fixture();
    const first = ok(run(f, snapshot()));
    const files = readdirSync(dirname(first.artifact)).sort();
    const before = readFileSync(first.artifact);
    const checkpoint = `<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation.\n\n<summary>\n${first.text}\n</summary>\n</conversation-checkpoint>`;
    const second = ok(run(f, snapshot([
      { id: "msg_a", role: "user", content: [{ type: "text", text: checkpoint }] },
      { id: "msg_b", role: "user", content: [{ type: "text", text: "A newer request." }] },
    ])));
    assert.notEqual(second.artifact, first.artifact);
    assert.ok(expand(f, second.artifact).includes(first.artifact), "the earlier artifact stays referred to");
    assert.deepEqual(readdirSync(dirname(first.artifact)).sort(), files);
    assert.deepEqual(readFileSync(first.artifact), before);
    assert.ok(expand(f, first.artifact).includes(BIG), "the earlier blobs are still readable");
  });
  it("does not shrink a conversation that has nothing long in it, which the plugin then reports as a no-op", () => {
    const f = fixture();
    const value = ok(run(f, snapshot([{ id: "m", role: "user", content: [{ type: "text", text: "Hello." }] }])));
    assert.ok(value.afterChars >= value.beforeChars, `${value.beforeChars} -> ${value.afterChars} (measured, n=1)`);
  });
  it("ignores a cwd module, PYTHONPATH and an external preparer (isolated execution, as for Claude Code)", () => {
    const f = fixture();
    const evil = tempDir("apana-evil-");
    for (const name of ["json.py", "prepare.py", "compact_session.py"]) mkdirSync(join(evil, name), { recursive: true });
    f.env.PYTHONPATH = evil;
    f.env.HV_SCRIPTS = evil;
    ok(run(f, snapshot()));
  });
});
