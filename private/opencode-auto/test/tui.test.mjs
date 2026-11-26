import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isAuto, markOf, setupAutoTui, sidebarLabel } from "../tui.mjs";

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

// `log` is replaced everywhere: the default writes to the real auto.log under ~/.local/state.
const start = (fake, env = AUTO, options = {}) => setupAutoTui(fake.context, env, { pollMs: 0, log: () => {}, ...options });
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const open = (sessionID) => ({ type: "session", sessionID });

it("recovers a persisted handoff without the metadata event, but does not follow an archived source", async () => {
  for (const archived of [undefined, 123]) {
    const fake = fakeTui({ route: open("ses_a"), sessions: {
      ses_a: { time: { archived }, metadata: { apana: { auto: {}, next: "ses_b" } } },
    } });
    const plugin = await start(fake);
    await flush();
    assert.deepEqual(fake.state.route, open(archived ? "ses_a" : "ses_b"));
    assert.equal(fake.calls.archive.length, archived ? 0 : 1);
    plugin.dispose();
  }
});

it("reconciles a missed event on reconnect and retries a failed route change", async () => {
  const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
  const plugin = await start(fake);
  await flush();
  fake.store.get("ses_a").metadata.apana.next = "ses_b";
  fake.state.failNavigate = true;
  fake.emit("server.connected", {});
  await flush();
  assert.deepEqual(fake.state.route, open("ses_a"));
  assert.equal(fake.calls.archive.length, 0);
  fake.state.failNavigate = false;
  fake.emit("server.connected", {});
  await flush();
  fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
  assert.deepEqual(fake.calls.navigate, [open("ses_b")]);
  assert.deepEqual(fake.calls.archive.map((call) => call.route), [open("ses_b")]);
  plugin.dispose();
});

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
  it("follows nothing without the variable: no subscription, so no move, no toast, no archive when `next` appears", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake, {});
    await auto.check();
    fake.metadataEvent("ses_a", { apana: { next: "ses_b" } });
    await flush();
    assert.equal(fake.listeners.size, 0);
    assert.deepEqual(fake.calls, { get: ["ses_a"], update: [], archive: [], navigate: [], toast: [] });
    auto.dispose();
  });
  it("subscribes to metadata and reconnects, and takes both subscriptions back on dispose", async () => {
    const fake = fakeTui();
    const auto = await start(fake);
    assert.deepEqual([...fake.listeners].map((l) => l.type), ["session.metadata.updated", "server.connected"]);
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
    const auto = await setupAutoTui(fake.context, AUTO, { pollMs: 5, log: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fake.calls.get, ["ses_a"]);
    auto.dispose();
    fake.state.route = open("ses_b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fake.calls.get, ["ses_a"], "nothing is read after dispose");
  });
});

describe("a plain window (no variable) takes the mark off the session it opens", () => {
  // The mark outlives the window that set it (the new session of a chain carries it, and a marked session can be reopened in a plain `opencode`),
  // and a plain window cannot follow a handoff: measured 2026-11-21 (n=1), the server handed such a session off and refused its tool calls on screen.
  const PLAIN = {};

  it("removes the mark and keeps the rest of the metadata", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: { metadata: { keep: 1, apana: { other: true, auto: { tokens: 90000, chain: 3 } } } } } });
    const auto = await start(fake, PLAIN);
    await auto.check();
    assert.deepEqual(fake.calls.update, [{ sessionID: "ses_a", metadata: { keep: 1, apana: { other: true } } }]);
    auto.dispose();
  });
  it("drops `apana` when the mark was all it held, so the metadata is as it was before the session was marked", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: { metadata: { keep: 1, apana: { auto: {} } } }, ses_b: { metadata: { apana: { auto: { chain: 1 } } } } } });
    const auto = await start(fake, PLAIN);
    await auto.check();
    fake.state.route = open("ses_b");
    await auto.check();
    assert.deepEqual(fake.calls.update, [{ sessionID: "ses_a", metadata: { keep: 1 } }, { sessionID: "ses_b", metadata: {} }]);
    auto.dispose();
  });
  it("writes nothing to a session without the mark, to one already handed off, or to one whose `auto` is not a mark, and marks nothing", async () => {
    const sessions = {
      ses_plain: {},
      ses_other: { metadata: { apana: { other: true } } },
      ses_done: { metadata: { apana: { auto: { chain: 1 }, next: "ses_x" } } },
      ses_odd: { metadata: { apana: { auto: true } } },
    };
    const fake = fakeTui({ sessions });
    const auto = await start(fake, PLAIN);
    for (const id of Object.keys(sessions)) {
      fake.state.route = open(id);
      await auto.check();
    }
    assert.deepEqual(fake.calls.get, Object.keys(sessions));
    assert.deepEqual(fake.calls.update, []);
    auto.dispose();
  });
  it("looks at a session once, also when looks overlap, and at the next one when the route changes", async () => {
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: { metadata: { apana: { auto: {} } } }, ses_b: { metadata: { apana: { auto: {} } } } } });
    const auto = await start(fake, PLAIN);
    await Promise.all([auto.check(), auto.check(), auto.check()]);
    await auto.check();
    assert.deepEqual(fake.calls.get, ["ses_a"]);
    fake.state.route = open("ses_b");
    await auto.check();
    assert.deepEqual(fake.calls.update.map((u) => u.sessionID), ["ses_a", "ses_b"]);
    auto.dispose();
  });
  it("leaves the home screen alone and tries again after a failure, no sooner than the retry delay", async () => {
    let t = 1_000;
    const fake = fakeTui({ route: { type: "home" }, sessions: { ses_a: { metadata: { apana: { auto: {} } } } }, failGet: true });
    const auto = await start(fake, PLAIN, { now: () => t, retryMs: 5_000 });
    await auto.check();
    assert.deepEqual(fake.calls.get, []);
    fake.state.route = open("ses_a");
    await auto.check();
    t += 4_999;
    await auto.check();
    assert.equal(fake.calls.get.length, 1, "no hammering");
    fake.state.failGet = false;
    t += 1;
    await auto.check();
    assert.deepEqual(fake.calls.update, [{ sessionID: "ses_a", metadata: {} }]);
    auto.dispose();
  });
  it("polls the route on its own, so that a session picked after the start is seen too, and stops when it is disposed", async () => {
    // A plain `opencode` often starts on the home screen and the session is picked from the list: only the poll sees that route.
    const fake = fakeTui({ sessions: { ses_a: { metadata: { apana: { auto: {} } } }, ses_b: { metadata: { apana: { auto: {} } } } } });
    const auto = await setupAutoTui(fake.context, PLAIN, { pollMs: 5, log: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.state.route = open("ses_a");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fake.calls.update, [{ sessionID: "ses_a", metadata: {} }]);
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
  it("follows a session that was handed off before this window opened it", async () => {
    // Seen 2026-11-26 on 2.4.2 (n=2): after a handoff the window stayed on the old session, whose tool calls the server then refused. The logs of
    // one case fit a window restarted before the handoff that opened the old session after its event (not proven: the TUI part logged nothing then).
    const fake = fakeTui({ route: open("ses_x"), sessions: { ses_x: {}, ses_a: { metadata: { apana: { auto: {}, next: "ses_b" } } } } });
    const auto = await start(fake);
    await auto.check();
    fake.state.route = open("ses_a");
    await auto.check();
    await flush();
    assert.deepEqual(fake.calls.navigate, [open("ses_b")]);
    assert.deepEqual(fake.calls.archive.map((call) => call.sessionID), ["ses_a"]);
    assert.match(fake.calls.toast.at(-1).message, /moved to the new session/);
    auto.dispose();
  });
  it("follows a `next` whose event never came, at the first read after the retry delay", async () => {
    let t = 1_000;
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } });
    const auto = await start(fake, AUTO, { now: () => t, retryMs: 5_000 });
    await auto.check();
    fake.store.get("ses_a").metadata.apana.next = "ses_b";
    t += 4_999;
    await auto.check();
    assert.deepEqual(fake.calls.navigate, [], "no read before the delay");
    t += 1;
    await auto.check();
    assert.deepEqual(fake.calls.navigate, [open("ses_b")]);
    auto.dispose();
  });
  it("logs its start, a move, and a failed move once although every read tries again; a plain window logs nothing", async () => {
    let t = 1_000;
    const lines = [];
    const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: { metadata: { apana: { auto: {}, next: "ses_b" } } } } });
    fake.state.failNavigate = true;
    const auto = await start(fake, AUTO, { now: () => t, retryMs: 5_000, log: (line) => lines.push(line) });
    await flush();
    t += 5_000;
    await auto.check();
    fake.state.failNavigate = false;
    t += 5_000;
    await auto.check();
    assert.deepEqual(lines, ["automatic window started", "could not move the window from ses_a to ses_b (injected)", "moved the window from ses_a to ses_b"]);
    auto.dispose();
    const plainLines = [];
    const plain = await start(fakeTui({ route: open("ses_a"), sessions: { ses_a: {} } }), {}, { log: (line) => plainLines.push(line) });
    await plain.check();
    assert.deepEqual(plainLines, []);
    plain.dispose();
  });
  it("writes its lines to auto.log under XDG_STATE_HOME when no log is given", async () => {
    const state = mkdtempSync(join(tmpdir(), "apana-auto-tui-"));
    try {
      const fake = fakeTui({ route: open("ses_a"), sessions: { ses_a: { metadata: { apana: { auto: {}, next: "ses_b" } } } } });
      const auto = await setupAutoTui(fake.context, { ...AUTO, XDG_STATE_HOME: state }, { pollMs: 0 });
      await flush();
      const text = readFileSync(join(state, "opencode", "apana", "auto", "auto.log"), "utf8");
      assert.match(text, new RegExp(`^\\S+Z tui ${process.pid}: automatic window started\\n\\S+Z tui ${process.pid}: moved the window from ses_a to ses_b\\n$`));
      auto.dispose();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
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

describe("the sidebar line", () => {
  const withSlot = (fake) => {
    fake.context.ui.slot = () => () => {};
    return fake;
  };
  it("says on for a marked root session, done once it was handed off, and nothing for the rest", () => {
    assert.equal(sidebarLabel({ id: "a", metadata: { apana: { auto: {} } } }), "Auto handoff: on");
    assert.equal(sidebarLabel({ id: "a", metadata: { apana: { auto: { tokens: 1 } } } }), "Auto handoff: on");
    assert.equal(sidebarLabel({ id: "a", metadata: { apana: { auto: {}, next: "b" } } }), "Auto handoff: done");
    assert.equal(sidebarLabel({ id: "a", metadata: { apana: {} } }), null);
    assert.equal(sidebarLabel({ id: "a", metadata: { apana: { auto: "yes" } } }), null);
    assert.equal(sidebarLabel({ id: "a", metadata: { other: 1 } }), null);
    assert.equal(sidebarLabel({ id: "a" }), null);
    assert.equal(sidebarLabel(undefined), null);
    assert.equal(sidebarLabel({ id: "c", parentID: "a", metadata: { apana: { auto: {} } } }), null, "a child is never handed off");
  });
  it("is registered with the label function, also in a window that was not started by opencode-auto, and taken back on dispose", async () => {
    const fake = withSlot(fakeTui());
    const calls = [];
    let removed = 0;
    const sidebar = (context, label) => {
      calls.push({ context, label });
      return () => (removed += 1);
    };
    const plain = await start(fake, {}, { sidebar });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context, fake.context);
    assert.equal(calls[0].label, sidebarLabel);
    plain.dispose();
    assert.equal(removed, 1);
    const auto = await start(withSlot(fakeTui()), AUTO, { sidebar });
    assert.equal(calls.length, 2);
    auto.dispose();
    assert.equal(removed, 2);
  });
  it("is not asked for when OpenCode has no slot, or when no sidebar was given", async () => {
    let asked = 0;
    const sidebar = () => (asked += 1);
    (await start(fakeTui(), AUTO, { sidebar })).dispose();
    assert.equal(asked, 0);
    (await start(withSlot(fakeTui()), AUTO)).dispose();
    assert.equal(asked, 0);
  });
  it("does not stop the marking when the sidebar cannot be registered", async () => {
    const fake = withSlot(fakeTui({ route: open("s1"), sessions: { s1: {} } }));
    const auto = await start(fake, AUTO, { sidebar: () => { throw new Error("injected"); } });
    await auto.check();
    assert.equal(fake.calls.update.length, 1);
    assert.ok(fake.store.get("s1").metadata.apana.auto);
    auto.dispose();
  });
});
