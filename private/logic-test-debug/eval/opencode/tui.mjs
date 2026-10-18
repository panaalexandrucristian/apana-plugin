// The terminal UI of OpenCode against the stand-in provider: does the prompt typed in the UI reach the prompt hook in the same shape as
// with `opencode run` (which wraps the text in double quotes), and does the directive reach the model? No model, no credentials, no cost.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionConfig, summarizeRequests } from "./run.mjs";
import { startStub } from "./stub-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function runTui({ dir, pluginDir, prompt, env = {} }) {
  rmSync(dir, { recursive: true, force: true });
  for (const name of ["config/opencode", "data", "cache", "state", "tmp", "ws"]) mkdirSync(join(dir, name), { recursive: true });
  const logFile = join(dir, "requests.jsonl");
  const stub = await startStub({ logFile, mode: "text" });
  writeFileSync(join(dir, "config/opencode/opencode.jsonc"), JSON.stringify(sessionConfig({ pluginDir, port: stub.port }), null, 2));
  // Asynchronous on purpose: the stand-in provider lives in this process and must keep answering while the terminal UI runs.
  const out = await new Promise((resolve) => {
    const child = spawn("python3", [join(HERE, "tui-driver.py"), "-", join(dir, "ws"), dir, prompt], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  await stub.close();
  const rows = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const main = rows.filter((r) => r.body?.tools?.length);
  const user = main[0] ? (main[0].body.messages ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).at(-1) : null;
  return { status: out.status, stdout: (out.stdout ?? "").trim(), stderr: (out.stderr ?? "").slice(0, 300), summary: summarizeRequests(readFileSync(logFile, "utf8")), userMessageAsSeenByTheModel: user };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, pluginDir, prompt] = process.argv.slice(2);
  console.log(JSON.stringify(await runTui({ dir, pluginDir, prompt }), null, 2));
}
