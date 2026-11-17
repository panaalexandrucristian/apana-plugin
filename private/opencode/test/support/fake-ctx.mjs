// A plugin context for OpenCode 2.3.0 made of plain objects: storage over a Map, a skill registry, hook and command recorders,
// and calls that record what they were given. `failAt` names a call that throws; `missing` names a capability to leave out.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Removed when the test process exits (not after the last test: a server that a test started may still be writing its log).
const made = [];
process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
export const tempDir = (prefix = "apana-oc-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

export function fakeCtx({ directory = tempDir("apana-ws-"), directories = {}, skills = [], failAt = null, missing = [], storage = new Map() } = {}) {
  const hooks = new Map();
  const disposed = [];
  const registry = new Map(skills.map((skill) => [skill.id, { ...skill }]));
  const commands = [];
  const calls = { prompt: [], compact: [], synthetic: [] };
  const state = { context: [], compactError: null, contextError: null };
  const guard = (name) => {
    if (failAt === name) throw new Error(`injected failure at ${name}`);
  };
  const order = [];
  const registration = (label, undo = () => {}) => ({
    ...(order.push(label), {}),
    dispose: async () => {
      disposed.push(label);
      undo();
    },
  });
  const ctx = {
    storage: {
      get: async (key) => (storage.has(key) ? structuredClone(storage.get(key)) : undefined),
      set: async (key, value) => {
        storage.set(key, structuredClone(value));
      },
      remove: async (key) => {
        storage.delete(key);
      },
    },
    skill: {
      list: async () => ({ location: { directory }, data: [...registry.values()] }),
      transform: async (callback) => {
        guard("skill.transform");
        const added = [];
        callback({
          get: (id) => registry.get(id),
          add: (skill) => {
            registry.set(skill.id, skill);
            added.push(skill.id);
          },
        });
        return registration("skill.transform", () => added.forEach((id) => registry.delete(id)));
      },
    },
    command: {
      transform: async (callback) => {
        guard("command.transform");
        const before = commands.length;
        callback({ add: (definition) => commands.push(definition) });
        return registration("command.transform", () => commands.splice(before));
      },
    },
    session: {
      hook: async (name, callback) => {
        guard(`session.hook:${name}`);
        if (!hooks.has(`session.${name}`)) hooks.set(`session.${name}`, []);
        hooks.get(`session.${name}`).push(callback);
        return registration(`session.hook:${name}`, () => hooks.set(`session.${name}`, hooks.get(`session.${name}`).filter((f) => f !== callback)));
      },
      get: async ({ sessionID }) => {
        guard("session.get");
        return { id: sessionID, location: { directory: directories[sessionID] ?? directory } };
      },
      prompt: async (input) => {
        guard("session.prompt");
        calls.prompt.push(input);
        return { id: "msg_x" };
      },
      compact: async (input) => {
        if (state.compactError) throw state.compactError;
        calls.compact.push(input);
        return { id: "msg_compact", type: "compaction" };
      },
      context: async () => {
        if (state.contextError) throw state.contextError;
        return state.context;
      },
      synthetic: async (input) => {
        calls.synthetic.push(input);
        return { id: "msg_syn" };
      },
    },
    tool: {
      hook: async (name, callback) => {
        guard(`tool.hook:${name}`);
        const key = `tool.${name}`;
        if (!hooks.has(key)) hooks.set(key, []);
        hooks.get(key).push(callback);
        return registration(`tool.hook:${name}`, () => hooks.set(key, hooks.get(key).filter((f) => f !== callback)));
      },
    },
  };
  for (const path of missing) {
    const [group, name] = path.split(".");
    delete ctx[group][name];
  }
  const fire = async (name, event) => {
    for (const callback of hooks.get(name) ?? []) await callback(event);
    return event;
  };
  return { ctx, storage, registry, commands, disposed, order, calls, state, directory, hooks, fire };
}

/** A user message as the context hook sees it. */
export const userMessage = (id, text, metadata) => ({ id, role: "user", content: [{ type: "text", text }], ...(metadata ? { metadata } : {}) });

/** Runs the prompt hook as OpenCode would and returns the metadata it stored, so that a test can build the admitted message. */
export async function admit(fake, sessionID, messageID, text, skills = []) {
  const event = { sessionID, messageID, prompt: { text, files: [], skills: skills.map((id) => ({ id })) }, delivery: "steer" };
  await fake.fire("session.prompt", event);
  return userMessage(messageID, text, event.metadata);
}
