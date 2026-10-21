import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, renameSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// Reject symlinks at every existing path component, including dangling links.
// Resolve the macOS /var alias before inspecting descendants.
function checkedPath(path) {
  const absolute = resolve(path);
  const parts = absolute.split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (current === '/var' || current === '/tmp') current = realpathSync(current);
        else throw new Error('unsafe symlink path');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}
function testCommand(command) {
  if (typeof command !== 'string' || !/^[A-Za-z0-9_./:=@#,* -]+$/.test(command)) return false;
  const a = command.split(' ');
  if (a.some(x => !x)) return false;
  const file = x => /^[A-Za-z0-9_./-]+(?:::[A-Za-z0-9_]+)*$/.test(x) && !x.startsWith('-') && !x.split('/').includes('..');
  if (a[0] === 'node') return a[1] === '--test' && a.length > 2 && a.slice(2).every(file);
  if (a[0] === 'python' || a[0] === 'python3') return a[1] === '-m' && ['unittest', 'pytest'].includes(a[2]) && a.length > 3 && a.slice(3).every(file);
  if (a[0] === 'pytest') return a.length > 1 && a.slice(1).every(file);
  if (a[0] === 'npm') return a[1] === 'test' && a[2] === '--' && a.length > 3 && a.slice(3).every(file);
  if (a[0] === './gradlew') return /^:[A-Za-z0-9_:]+:test[A-Za-z0-9_]*$/.test(a[1] || '') && a[2] === '--tests' && a.length === 4 && /^[A-Za-z0-9_.*#]+$/.test(a[3]);
  return false;
}
const PREFIX = "/apana:scope";
const safe = (v) => typeof v === "string" && v.length > 0 && !/[\0\n]/.test(v);
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + "/");
export const stateDir = (env = process.env) => resolve(env.APANA_SCOPE_STATE_DIR || `${homedir()}/.claude/apana-scope`);
const sessionId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export const statePath = (id, env) => { if (!sessionId(id)) throw new Error("invalid session id"); return resolve(stateDir(env), `${id}.json`); };
export const proposalPath = (id, env) => { if (!sessionId(id)) throw new Error("invalid session id"); return resolve(stateDir(env), `${id}.proposal.json`); };
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Apana scope: ${reason}` } });
const context = (text) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });
function writeAtomic(path, data) { checkedPath(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, path); }
function load(id, env) { if (!sessionId(id)) return null; try { const path = statePath(id, env); checkedPath(path); if (!existsSync(path)) return null; return JSON.parse(readFileSync(path, "utf8")); } catch { return { corrupt: true }; } }
function exact(root, value) { if (!safe(value) || value.startsWith("/") || value.split("/").includes("..") || /[*?\[\]{}]/.test(value)) throw new Error("path must be an exact repository-relative path"); const candidate = resolve(root, value); checkedPath(candidate); if (!inside(root, candidate)) throw new Error("path escapes repository"); return value; }
export function validateProposal(value, root) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("proposal must be an object"); const prod = value.production_changes, tests = value.test_changes, commands = value.test_commands; if (!Array.isArray(prod) || !Array.isArray(tests) || !prod.length || !Array.isArray(commands) || !commands.length) throw new Error("proposal needs production_changes, test_changes and test_commands arrays"); if (prod.length > 12 || tests.length > 12 || commands.length > 12) throw new Error("proposal is too broad; ask the user to split the task"); const p = new Set(); for (const e of prod) { if (!e || typeof e !== "object") throw new Error("invalid production entry"); p.add(exact(root, e.path)); }
 const t = new Set(); for (const e of tests) { if (!e || typeof e !== "object") throw new Error("invalid test entry"); const path = exact(root, e.path); if (p.has(path)) throw new Error("a test cannot also be production"); if (!Array.isArray(e.production_paths) || !e.production_paths.length || e.production_paths.some(x => !p.has(exact(root, x)))) throw new Error("each test must map only to proposed production paths"); t.add(path); }
 if (!t.size) throw new Error("scope requires focused tests; ask the user to explicitly choose tests-only or refactor otherwise"); for (const command of commands) if (!testCommand(command)) throw new Error("test command must use a supported narrow test runner form"); return { production_changes: [...p], test_changes: [...t], test_commands: [...commands] }; }
export function onPrompt(input, env = process.env) { const prompt = input?.prompt, id = input?.session_id, root = resolve(input?.cwd || "."); if (!safe(prompt) || !safe(id)) return null; const task = prompt.match(/^\/apana:scope\s+(.+)$/s); const approve = prompt.match(/^\/apana:scope\s+approve\s+([a-f0-9-]+)\s*$/i); if (prompt.startsWith("/apana:scope approve") && !approve) return context("Scope approval was not accepted: approval needs the exact nonce shown with the proposed scope.");
 if (task && !approve) { const state = { version: 1, phase: "investigating", root, task: task[1].trim(), nonce: randomUUID(), session_id: id }; writeAtomic(statePath(id, env), state); return context(`Scope mode is investigating only. Continue reading/tracing every question resolvable from the repository. Do not edit. If user intent is needed, use AskUserQuestion and wait; do not invent requirements. When ready, write the proposed JSON only to ${proposalPath(id, env)} with production_changes:[{path}], test_changes:[{path,production_paths:[...]}], and test_commands:["node --test test/example.test.js"]. Then show the user the file list and ask them to type /apana:scope approve ${state.nonce}.`); }
 if (!approve) return null; const state = load(id, env); if (!state || state.phase !== "investigating" || state.nonce !== approve[1] || state.root !== root) return context("Scope approval was not accepted: no matching investigating scope exists for this repository/session."); try { checkedPath(proposalPath(id, env)); const proposal = JSON.parse(readFileSync(proposalPath(id, env), "utf8")); state.manifest = validateProposal(proposal, root); state.phase = "approved"; writeAtomic(statePath(id, env), state); return context(`Scope approved. You may edit only these exact files: ${[...state.manifest.production_changes, ...state.manifest.test_changes].join(", ")}. Do not broaden scope; a new file or changed intent needs a user question and a new /apana:scope task.`); } catch (e) { return context(`Scope approval is blocked: ${String(e.message)}. Continue safe investigation or ask the user; do not edit.`); } }
export function onTool(input, env = process.env) { const state = load(input?.session_id, env); if (state?.corrupt) return deny("scope state is invalid or unsafe; start a new scope"); if (!state) return null; const tool = input.tool_name, root = resolve(input?.cwd || "."); if (state.root !== root) return deny("scope state belongs to another repository"); if (state.phase === "investigating") { const proposal = proposalPath(input.session_id, env); if (tool === "Write" && resolve(input?.tool_input?.file_path || "") === proposal) { try { checkedPath(proposal); return null; } catch { return deny("unsafe proposal path"); } } if (["Read", "Glob", "Grep", "AskUserQuestion"].includes(tool)) return null; return deny("investigation is read-only until the user approves the proposed scope"); }
 if (state.phase !== "approved") return deny("invalid scope state"); if (["Edit", "Write", "NotebookEdit"].includes(tool)) { const path = input?.tool_input?.file_path || input?.tool_input?.notebook_path; if (!safe(path) || !inside(root, resolve(path))) return deny("write path is invalid"); const rel = relative(root, resolve(path)); try { checkedPath(resolve(path)); } catch { return deny("unsafe write path"); } if (![...state.manifest.production_changes, ...state.manifest.test_changes].includes(rel)) return deny("write is outside the approved exact-file scope"); return null; }
 if (tool === "Bash" && state.manifest.test_commands.includes(input?.tool_input?.command)) return null;
 if (["Read", "Glob", "Grep", "AskUserQuestion"].includes(tool)) return null; return deny("Bash is allowed only for an exact approved test command; MCP, agents and other tools are disabled in approved scope"); }
