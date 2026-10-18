// One OpenCode session against a local stand-in provider (stub-provider.mjs): no credentials, no cost, nothing outside the
// session folder. It answers the questions the adapter left open on OpenCode 2.0.x: does the directive reach the model, is the
// skill listed and loadable, what do the prompt and context hooks receive.
//
// Isolation: its own XDG_* folders and TMPDIR inside `dir`, a minimal environment (no keys, no tokens), a private server
// (`--standalone`, never the user's background service), stdin closed, a hard time limit that kills the whole process group.
// Facts found while building it (OpenCode 2.0.22): `--format json` and `--print-logs` made `run` wait forever with this stub, so
// neither is used; `opencode debug config` and `opencode plugin list` try to start the managed service and must not be run here.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGIC_DIRECTIVE } from "../../check.mjs";
import { startStub } from "./stub-provider.mjs";

const OPENCODE = process.env.LTD_OPENCODE ?? "opencode";

export function sessionConfig({ pluginDir, port, withPlugin = true, permission = null, model = null }) {
  return {
    ...(withPlugin ? { plugin: [].concat(pluginDir), mcp: { servers: { jev: { type: "local", command: ["node", "-e", "setTimeout(()=>{},1000)"] } } } } : {}),
    provider: {
      stub: {
        npm: "@ai-sdk/openai-compatible",
        name: "Stub",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "stub" },
        models: { m: { name: "m", tool_call: true, limit: { context: 100000, output: 4000 } } },
      },
    },
    model: "stub/m",
    small_model: "stub/m",
    autoupdate: false,
    share: "disabled",
    ...(permission ? { permission } : {}),
  };
}

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("\n") : "");

/** Reads the stub's request log and answers the questions above. Pure over the file contents. */
export function summarizeRequests(logText, { directive = LOGIC_DIRECTIVE, skillId = "logic-test-debug" } = {}) {
  const rows = logText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const main = rows.filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0);
  const system = (r) => (r.body.messages ?? []).filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const toolMessages = main.flatMap((r) => (r.body.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content)));
  return {
    requests: rows.length,
    mainRequests: main.length,
    tools: main[0] ? main[0].body.tools.map((t) => t?.function?.name) : [],
    directiveInSystem: main.map((r) => system(r).includes(directive)),
    // OpenCode 2.0.22 lists the available skills in the system prompt, as <skill><id>...</id>...</skill>.
    skillListed: main.map((r) => system(r).includes(`<id>${skillId}</id>`)),
    skillBodyReturned: toolMessages.some((t) => t.includes("Work record")),
    systemChars: main.map((r) => system(r).length),
    lastUserText: main.length ? textOf((main[0].body.messages ?? []).filter((m) => m.role === "user").at(-1)?.content) : null,
  };
}

/**
 * Runs one session. `env` adds variables for the OpenCode process (for example APANA_LOGIC_TEST_DEBUG=off).
 * Returns {exit, timedOut, summary, dir}.
 */
export async function runSession({ dir, pluginDir, prompt, mode = "text", script = [], permission = null, withPlugin = true, env = {}, timeoutMs = 90000, cwd, keepWorkspace = false }) {
  if (!keepWorkspace) rmSync(dir, { recursive: true, force: true });
  const sub = (name) => join(dir, name);
  for (const name of ["config/opencode", "data", "cache", "state", "tmp", "ws"]) mkdirSync(sub(name), { recursive: true });
  const logFile = sub("requests.jsonl");
  const stub = await startStub({ logFile, mode, script });
  writeFileSync(sub("config/opencode/opencode.jsonc"), JSON.stringify(sessionConfig({ pluginDir, port: stub.port, withPlugin, permission }), null, 2));
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: sub("config"),
    XDG_DATA_HOME: sub("data"),
    XDG_CACHE_HOME: sub("cache"),
    XDG_STATE_HOME: sub("state"),
    TMPDIR: sub("tmp"),
    ...env,
  };
  const child = spawn(OPENCODE, ["run", "--standalone", "-m", "stub/m", prompt], { cwd: cwd ?? sub("ws"), env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, timeoutMs);
  const exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(timer);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone, as it should be.
  }
  await stub.close();
  writeFileSync(sub("output.txt"), out);
  const summary = summarizeRequests(readFileSync(logFile, "utf8"));
  return { exit, timedOut, summary, dir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, pluginDir, prompt, mode, withPlugin] = process.argv.slice(2);
  const result = await runSession({ dir, pluginDir, prompt, mode: mode ?? "text", withPlugin: withPlugin !== "no" });
  console.log(JSON.stringify(result, null, 2));
}
