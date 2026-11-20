import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAuto, markOf, setupAutoTui } from "../tui.mjs";

const AUTO = { APANA_OPENCODE_AUTO: "1" };

/** A TUI plugin context made of plain objects. `get` answers the session itself (as 2.3.0 does) and `update` replaces metadata as a whole. */
function fakeTui({ route = { type: "home" }, sessions = {}, failGet = false } = {}) {
  const state = { route, failGet, failNavigate: false, failArchive: false };
  const listeners = new Set();
  // `archive` holds the updates that carry `archived` (with the route at that moment), `update` the ones that write metadata.
  const calls = { get: [], update: [], archive: [], navigate: [], toast: [] };
  const store = new Map(Object.entries(sessions).map(([id, s]) => [id, { id, ...structuredClone(s) }]));
  const context = {
    data: {
      on: (type, callback) => {
        const entry = { type, callback };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    },
    ui: {
      router: {
        current: () => structuredClone(state.route),
        navigate: (to) => {
          if (state.failNavigate) throw new Error("injected");
          calls.navigate.push(to);
          state.route = structuredClone(to);
        },
      },
      toast: { show: (toast) => calls.toast.push(toast) },
    },
    client: {
      session: {
        get: async ({ sessionID }) => {
          calls.get.push(sessionID);
          if (state.failGet) throw new Error("server down");
          return structuredClone(store.get(sessionID) ?? { id: sessionID });
        },
        update: async ({ sessionID, metadata, archived }) => {
          if (archived !== undefined) {
            calls.archive.push({ sessionID, archived, metadata, route: structuredClone(state.route) });
            if (state.failArchive) throw new Error("injected");
            return {};
          }
          calls.update.push({ sessionID, metadata: structuredClone(metadata) });
          store.get(sessionID).metadata = structuredClone(metadata);
          return {};
        },
      },
    },
  };
  const emit = (type, event) => [...listeners].filter((l) => l.type === type).forEach((l) => l.callback(event));
  const metadataEvent = (sessionID, metadata) => emit("session.metadata.updated", { type: "session.metadata.updated", data: { sessionID, metadata } });
  return { context, state, calls, store, listeners, emit, metadataEvent };
}

const start = (fake, env = AUTO, options = {}) => setupAutoTui(fake.context, env, { pollMs: 0, ...options });
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const open = (sessionID) => ({ type: "session", sessionID });

describe("the environment", () => {
  it("is automatic only when the launcher set the variable", () => {
    assert.equal(isAuto({}), false);
    assert.equal(isAuto({ APANA_OPENCODE_AUTO: "" }), false);
    assert.equal(isAuto({ APANA_OPENCODE_AUTO: "0" }), false);
    assert.equal(isAuto({ APANA_OPENCODE_AUTO: "1" }), true);
  });
  it("turns the settings of the launcher into the mark: numbers as numbers, text as text, anything else left out", () => {
    assert.deepEqual(markOf({}), {});
    assert.deepEqual(
      markOf({
        APANA_OPENCODE_AUTO_TOKENS: "150000", APANA_OPENCODE_AUTO_PRETOOL_MARGIN: "10000", APANA_OPENCODE_AUTO_DEFER_EXTRA: "0",
        APANA_OPENCODE_AUTO_COOLDOWN: "30", APANA_OPENCODE_AUTO_MAX: "3", APANA_OPENCODE_AUTO_SKILLS: " caveman ", APANA_OPENCODE_AUTO_DIR: "/notes",
      }),
      { tokens: 150000, margin: 10000, deferExtra: 0, cooldown: 30, max: 3, skills: "caveman", dir: "/notes" },
    );
    assert.deepEqual(markOf({ APANA_OPENCODE_AUTO_TOKENS: "12k", APANA_OPENCODE_AUTO_MAX: "-1", APANA_OPENCODE_AUTO_COOLDOWN: "", APANA_OPENCODE_AUTO_DIR: "  " }), {});
  });
});

describe("setup", () => {
  it("refuses to start, with nothing registered, when OpenCode lacks a call it needs, also without the variable", async () => {
    for (const missing of ["data.on", "ui.router.current", "ui.router.navigate", "ui.toast.show", "client.session.get", "client.session.update"]) {
      const fake = fakeTui();
      const [group, ...rest] = missing.split(".");
      const owner = rest.slice(0, -1).reduce((value, key) => value[key], fake.context[group]);
      delete owner[rest.at(-1)];
      await assert.rejects(setupAutoTui(fake.context, {}, { pollMs: 0 }), new RegExp(`does not offer ${missing}`));
      assert.equal(fake.listeners.size, 0);
    }
    await assert.rejects(setupAutoTui({}, AUTO, { pollMs: 0 }), /does not offer/);
  });
  it("does nothing without the variable: no subscription, no read, no write, no move", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake, {});
    await auto.check();
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    await flush();
    assert.equal(fake.listeners.size, 0);
    assert.deepEqual(fake.calls, { get: [], update: [], archive: [], navigate: [], toast: [] });
    auto.dispose();
  });
  it("subscribes once and takes the subscription back when it is disposed", async () => {
    const fake = fakeTui();
    const auto = await start(fake);
    assert.equal(fake.listeners.size, 1);
    auto.dispose();
    assert.equal(fake.listeners.size, 0);
  });
});

describe("marking the open session", () => {
  it("writes the mark with the settings and keeps what the metadata already had", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: { metadata: { keep: 1, apana: { other: true } } } } });
    const auto = await start(fake, { ...AUTO, APANA_OPENCODE_AUTO_TOKENS: "150000" });
    await auto.check();
    assert.deepEqual(fake.calls.update, [{ sessionID: "ses_a", metadata: { keep: 1, apana: { other: true, auto: { tokens: 150000 } } } }]);
    auto.dispose();
  });
  it("marks a session whose metadata is missing", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    assert.deepEqual(fake.calls.update, [{ sessionID: "ses_a", metadata: { apana: { auto: {} } } }]);
    auto.dispose();
  });
  it("marks a session once, and the next one when the route changes", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {}, ses_b: {} } });
    const auto = await start(fake);
    await auto.check();
    await auto.check();
    assert.deepEqual(fake.calls.get, ["ses_a"]);
    fake.state.route = open("ses_b");
    await auto.check();
    assert.deepEqual(fake.calls.get, ["ses_a", "ses_b"]);
    assert.equal(fake.calls.update.length, 2);
    auto.dispose();
  });
  it("leaves the home screen alone", async () => {
    const fake = fakeTui({ route: { type: "home" } });
    const auto = await start(fake);
    await auto.check();
    assert.deepEqual(fake.calls.get, []);
    auto.dispose();
  });
  it("does not touch a session that already has the mark (the chain keeps its settings), has a parent, or was handed off", async () => {
    const sessions = {
      ses_marked: { metadata: { apana: { auto: { tokens: 90000, chain: 2 } } } },
      ses_child: { parentID: "ses_marked" },
      ses_done: { metadata: { apana: { next: "ses_x" } } },
    };
    const fake = fakeTui({ sessions });
    const auto = await start(fake);
    for (const id of Object.keys(sessions)) {
      fake.state.route = open(id);
      await auto.check();
    }
    assert.deepEqual(fake.calls.get, Object.keys(sessions));
    assert.deepEqual(fake.calls.update, []);
    auto.dispose();
  });
  it("replaces a mark that is not an object", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: { metadata: { apana: { auto: true } } } } });
    const auto = await start(fake);
    await auto.check();
    assert.deepEqual(fake.calls.update[0].metadata, { apana: { auto: {} } }, "the server does not count it as a mark, so the TUI puts a real one");
    auto.dispose();
  });
  it("does not write the same mark twice when a second look comes while the first is still reading", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await Promise.all([auto.check(), auto.check(), auto.check()]);
    assert.equal(fake.calls.get.length, 1);
    assert.equal(fake.calls.update.length, 1);
    auto.dispose();
  });
  it("survives a server that fails and tries again no sooner than the retry delay", async () => {
    let t = 1_000;
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} }, failGet: true });
    const auto = await start(fake, AUTO, { now: () => t, retryMs: 5_000 });
    await auto.check();
    t += 4_999;
    await auto.check();
    assert.equal(fake.calls.get.length, 1, "no hammering");
    fake.state.failGet = false;
    t += 1;
    await auto.check();
    assert.equal(fake.calls.get.length, 2);
    assert.equal(fake.calls.update.length, 1);
    auto.dispose();
  });
  it("polls the route on its own and stops when it is disposed", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {}, ses_b: {} } });
    const auto = await setupAutoTui(fake.context, AUTO, { pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fake.calls.get, ["ses_a"]);
    auto.dispose();
    fake.state.route = open("ses_b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fake.calls.get, ["ses_a"], "nothing is read after dispose");
  });
});

describe("following a handoff", () => {
  it("moves the window to the new session and says so, when the session that is open got `next`", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.metadataEvent("ses_a", { apana: { auto: {}, next: "ses_b" } });
    assert.deepEqual(fake.calls.navigate, [{ type: "session", sessionID: "ses_b" }]);
    assert.equal(fake.calls.toast.length, 1);
    assert.match(fake.calls.toast[0].message, /moved to the new session/);
    auto.dispose();
  });
  it("only tells the user, and does not move, when the handed-off session is not the open one", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {}, ses_b: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.state.route = open("ses_b");
    fake.metadataEvent("ses_a", { apana: { next: "ses_c" } });
    assert.deepEqual(fake.calls.navigate, []);
    assert.equal(fake.calls.toast.length, 1);
    assert.match(fake.calls.toast[0].message, /handed off to ses_c/);
    auto.dispose();
  });
  it("ignores a session that was never open in this window, events without `next`, and bad events", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.metadataEvent("ses_other", { apana: { next: "ses_x" } });
    fake.metadataEvent("ses_a", { apana: { auto: {} } });
    fake.metadataEvent("ses_a", null);
    fake.metadataEvent("ses_a", { apana: { next: 7 } });
    fake.emit("session.metadata.updated", null);
    fake.emit("session.metadata.updated", { data: null });
    assert.deepEqual(fake.calls.navigate, []);
    assert.deepEqual(fake.calls.toast, []);
    auto.dispose();
  });
  it("follows a session once, however many events carry its `next`", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    assert.equal(fake.calls.navigate.length, 1);
    assert.equal(fake.calls.toast.length, 1);
    auto.dispose();
  });
  it("follows the chain: a handoff of the new session moves the window again", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {}, ses_b: { metadata: { apana: { auto: { chain: 1 } } } } } });
    const auto = await start(fake);
    await auto.check();
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    await auto.check();
    fake.metadataEvent("ses_b", { apana: { auto: { chain: 1 }, next: "ses_c" } });
    assert.deepEqual(fake.calls.navigate.map((n) => n.sessionID), ["ses_b", "ses_c"]);
    auto.dispose();
  });
  it("does not throw into OpenCode when the move fails", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.state.failNavigate = true;
    assert.doesNotThrow(() => fake.metadataEvent("ses_a", { apana: { next: "ses_b" } }));
    auto.dispose();
  });
});

describe("archiving the session that was handed off", () => {
  it("archives it once the window has moved to the new one, with `archived` alone (metadata is not touched)", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.metadataEvent("ses_a", { apana: { auto: {}, next: "ses_b" } });
    await flush();
    assert.deepEqual(fake.calls.archive, [{ sessionID: "ses_a", archived: true, metadata: undefined, route: open("ses_b") }], "the window was already on the new session when the old one was archived");
    auto.dispose();
  });
  it("archives it too when the window is on another session", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {}, ses_b: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.state.route = open("ses_b");
    fake.metadataEvent("ses_a", { apana: { next: "ses_c" } });
    await flush();
    assert.deepEqual(fake.calls.archive.map((a) => a.sessionID), ["ses_a"]);
    auto.dispose();
  });
  it("leaves it alone when the window could not be moved off it: the user would lose the session on screen", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.state.failNavigate = true;
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    await flush();
    assert.deepEqual(fake.calls.archive, []);
    auto.dispose();
  });
  it("archives once, however many events carry its `next`, and never a session that was not open in this window", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.metadataEvent("ses_other", { apana: { next: "ses_x" } });
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    await flush();
    assert.deepEqual(fake.calls.archive.map((a) => a.sessionID), ["ses_a"]);
    auto.dispose();
  });
  it("archives each session of the chain", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {}, ses_b: { metadata: { apana: { auto: { chain: 1 } } } } } });
    const auto = await start(fake);
    await auto.check();
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    await auto.check();
    fake.metadataEvent("ses_b", { apana: { auto: { chain: 1 }, next: "ses_c" } });
    await flush();
    assert.deepEqual(fake.calls.archive.map((a) => a.sessionID), ["ses_a", "ses_b"]);
    auto.dispose();
  });
  it("does not fail, and the window has still moved, when the server refuses to archive", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake);
    await auto.check();
    fake.state.failArchive = true;
    assert.doesNotThrow(() => fake.metadataEvent("ses_a", { apana: { next: "ses_b" } }));
    await flush();
    assert.equal(fake.calls.archive.length, 1, "it was tried");
    assert.deepEqual(fake.calls.navigate, [{ type: "session", sessionID: "ses_b" }]);
    auto.dispose();
  });
});
