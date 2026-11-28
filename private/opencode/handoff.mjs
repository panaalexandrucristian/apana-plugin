import { spawn } from "node:child_process";

export const HANDOFF_TIMEOUT_MS = 90_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

/** Decode one word as written by Python's shlex.quote. */
export function unquote(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return null;
      out += text.slice(i + 1, end);
      i = end + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The verified note and suggested prompt printed by make_context.py. */
export function parseHandoff(stdout) {
  const ready = /^ready: (.+)$/m.exec(stdout)?.[1];
  const quoted = /^[ \t]*opencode --prompt (.+)$/m.exec(stdout)?.[1];
  const prompt = quoted === undefined ? null : unquote(quoted.trim());
  return ready && prompt ? { ready: ready.trim(), prompt } : null;
}

/** Run a bundled Python helper without a shell. */
export function runHandoffScript(script, args, timeoutMs, { env = process.env, children, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: -1, stdout: "", stderr: "" });
      return;
    }
    const child = spawn("python3", ["-I", "-B", script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    children?.add(child);
    let stdout = "";
    let stderr = "";
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const keep = (current, data) => (current.length < MAX_OUTPUT ? current + data : current);
    child.stdout.setEncoding("utf8").on("data", (data) => (stdout = keep(stdout, data)));
    child.stderr.setEncoding("utf8").on("data", (data) => (stderr = keep(stderr, data)));
    child.on("error", () => {});
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      children?.delete(child);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
