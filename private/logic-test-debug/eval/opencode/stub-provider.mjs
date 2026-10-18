// A local stand-in for a model provider (OpenAI chat-completions protocol, streaming) used to test the OpenCode adapter without
// a real model: it records every request it receives (system prompt, tool list, messages) and answers from a small script.
// No credentials, no network beyond 127.0.0.1, no cost. Started by run.mjs; can also be run alone: node stub-provider.mjs <log> [port] [mode].
// mode "load-skill": the first reply to a request that offers the `skill` tool is a call of that tool with the id of the skill
// under test; every later reply is plain text. mode "text": plain text only.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

export function startStub({ logFile, port = 0, mode = "text", skillId = "logic-test-debug", reply = "Scope: stub. Method: stub. Result: stub reply, nothing was run.", script = [] }) {
  writeFileSync(logFile, "");
  let n = 0;
  let calledSkill = false;
  let scriptIndex = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // Not JSON: recorded as raw below.
      }
      n += 1;
      appendFileSync(logFile, `${JSON.stringify({ n, method: req.method, url: req.url, headers: { "content-type": req.headers["content-type"] }, body, raw: body ? undefined : raw.slice(0, 2000) })}\n`);
      if (req.method !== "POST" || !/\/chat\/completions$/.test(req.url ?? "")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub: unknown route" } }));
        return;
      }
      const tools = Array.isArray(body?.tools) ? body.tools.map((t) => t?.function?.name ?? t?.name) : [];
      const hasToolResult = Array.isArray(body?.messages) && body.messages.some((m) => m?.role === "tool");
      const wantsSkill = mode === "load-skill" && !calledSkill && !hasToolResult && tools.includes("skill");
      // mode "script": one scripted tool call per main request (a request that offers tools), then plain text.
      const scripted = mode === "script" && tools.length > 0 && scriptIndex < script.length ? script[scriptIndex++] : null;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `stub-${n}`, object: "chat.completion.chunk", created: 0, model: body?.model ?? "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (scripted) {
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_script_${scriptIndex}`, type: "function", function: { name: scripted.name, arguments: JSON.stringify(scripted.args) } }] });
        chunk({}, "tool_calls");
      } else if (wantsSkill) {
        calledSkill = true;
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_stub_1", type: "function", function: { name: "skill", arguments: JSON.stringify({ id: skillId }) } }] });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: reply });
        chunk({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ id: `stub-${n}`, object: "chat.completion.chunk", created: 0, model: body?.model ?? "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [logFile, port, mode] = process.argv.slice(2);
  const stub = await startStub({ logFile, port: Number(port) || 0, mode: mode ?? "text" });
  console.log(`stub provider on http://127.0.0.1:${stub.port}/v1`);
}
