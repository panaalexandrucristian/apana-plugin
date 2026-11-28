// A private OpenCode server for tests that need the real host: its own HOME and XDG folders (nothing of the user's is read or
// written), a stand-in provider on 127.0.0.1 that records every request (no model, no credentials, no cost), the plugin under
// test listed under `plugins`, and a small HTTP client for the server's API. Used only when APANA_OPENCODE_RUNTIME=1.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStub } from "../../../logic-test-debug/eval/opencode/stub-provider.mjs";

const OPENCODE = process.env.APANA_OPENCODE ?? "opencode";

export function opencodeVersion() {
  const r = spawnSync(OPENCODE, ["--version"], { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? r.stdout.trim().replace(/^opencode\s+/, "") : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the server. `plugin`: the folder listed under `plugins` (none: the server lists no plugin, and `setup` may put one in plugins/ itself).
 * `script`: tool calls the stand-in provider makes, one per main request. `usage`: the token usage it reports ({ prompt, completion, cached? }).
 * `setup(sub)`: runs before the server starts, with the function that names a folder of this run.
 */
export async function startRuntime({ dir, plugin, script = [], mode = script.length ? "script" : "text", usage, respond, env = {}, port, setup, workspace }) {
  rmSync(dir, { recursive: true, force: true });
  const sub = (name) => join(dir, name);
  for (const name of ["config/opencode", "data", "cache", "state", "tmp", "ws", "home"]) mkdirSync(sub(name), { recursive: true });
  if (setup) await setup(sub);
  const stub = await startStub({ logFile: sub("requests.jsonl"), mode, script, usage, respond });
  const config = {
    plugins: plugin ? [plugin] : [],
    provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "Stub", options: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: "stub" }, models: { m: { name: "m", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
    model: "stub/m",
    small_model: "stub/m",
    autoupdate: false,
    share: "disabled",
  };
  writeFileSync(sub("config/opencode/opencode.jsonc"), JSON.stringify(config, null, 2));
  const childEnv = { PATH: process.env.PATH, HOME: sub("home"), XDG_CONFIG_HOME: sub("config"), XDG_DATA_HOME: sub("data"), XDG_CACHE_HOME: sub("cache"), XDG_STATE_HOME: sub("state"), TMPDIR: sub("tmp"), ...env };
  const listen = port ?? 20000 + Math.floor(Math.random() * 20000);
  const ws = workspace ?? sub("ws");
  const child = spawn(OPENCODE, ["serve", "--hostname", "127.0.0.1", "--port", String(listen), "--print-logs"], { cwd: ws, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const closed = new Promise((resolve) => child.once("close", resolve));
  writeFileSync(sub("server.log"), "");
  let log = "";
  const collect = (chunk) => {
    log += chunk;
    try {
      appendFileSync(sub("server.log"), chunk);
    } catch {
      // Directory already cleaned up on exit.
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await Promise.allSettled([closed, stub.close()]);
  };
  let password;
  for (let i = 0; i < 100 && !password; i += 1) {
    password = /server password (\S+)/.exec(log)?.[1];
    if (!password) await sleep(200);
  }
  if (!password) {
    await stop();
    throw new Error(`OpenCode did not start:\n${log.slice(0, 1500)}`);
  }
  const base = `http://127.0.0.1:${listen}`;
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json", "x-opencode-directory": ws };
  const api = async (method, path, body, directory) => {
    const res = await fetch(`${base}${path}`, { method, headers: directory ? { ...headers, "x-opencode-directory": directory } : headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON.
    }
    return { status: res.status, json, text };
  };
  const runtime = {
    dir,
    ws,
    home: sub("home"),
    api,
    log: () => log,
    close: stop,
    /** Changes the usage the stand-in provider reports from the next reply on. */
    setUsage: stub.setUsage,
    requests: () => readFileSync(sub("requests.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    /** The requests that offered tools (the agent's own), not the title request. */
    mainRequests: () => runtime.requests().filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0),
    async session(title = "t", extra = {}) {
      const res = await api("POST", "/api/session", { title, ...extra });
      if (res.status !== 200) throw new Error(`session: ${res.status} ${res.text}`);
      return res.json.data.id;
    },
    async prompt(sessionID, text, extra = {}) {
      const res = await api("POST", `/api/session/${sessionID}/prompt`, { text, ...extra });
      if (res.status !== 200) throw new Error(`prompt: ${res.status} ${res.text}`);
      return res.json.data;
    },
    async command(sessionID, name, text = "") {
      return api("POST", `/api/session/${sessionID}/command`, { name, text });
    },
    async messages(sessionID) {
      return (await api("GET", `/api/session/${sessionID}/message`)).json?.data ?? [];
    },
    async skills() {
      return (await api("GET", "/api/skill")).json?.data ?? [];
    },
    async commands() {
      return (await api("GET", "/api/command")).json?.data ?? [];
    },
  };
  // The server loads a location's plugins on its first request; wait until this plugin's commands are listed.
  runtime.ready = async (prefix = "apana:", ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await runtime.commands()).some((c) => c.name.startsWith(prefix))) return;
      await sleep(400);
    }
    throw new Error(`the plugin did not load:\n${log.split("\n").filter((l) => /apana|ERROR|WARN/.test(l)).slice(0, 8).join("\n")}`);
  };
  return runtime;
}

/** The text of one request's messages with `role`, as one string (content may be a string or a list of parts). */
export function textOfRole(request, role) {
  return (request.body.messages ?? [])
    .filter((m) => m.role === role)
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p?.text === "string" ? p.text : JSON.stringify(p))).join("\n")
          : JSON.stringify(m.content),
    )
    .join("\n");
}
