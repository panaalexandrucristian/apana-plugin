// opencode-auto on a real OpenCode 2.4.x: a private server (own HOME and XDG folders), the plugin folder reached through a link in
// plugins/ as the installer makes it, a stand-in provider that reports the token usage a test chooses, no credentials, no cost.
// Off unless APANA_OPENCODE_RUNTIME=1, and only for the release line it was written for: a run that skips proves nothing about OpenCode.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../opencode/catalog.mjs";
import { tempDir } from "../../opencode/test/support/fake-ctx.mjs";
import { opencodeVersion, startRuntime, textOfRole } from "../../opencode/test/support/runtime.mjs";

const version = process.env.APANA_OPENCODE_RUNTIME === "1" ? opencodeVersion() : null;
const reason = process.env.APANA_OPENCODE_RUNTIME !== "1" ? "set APANA_OPENCODE_RUNTIME=1 to run the tests on a real OpenCode" : !/^v?2\.4\./.test(version ?? "") ? `written for OpenCode 2.4.x, found ${version}` : false;

// The stand-in provider's model has a window of 100000 tokens: OpenCode's compaction ceiling is then 84000 (100000 - max(15%, 16000)),
// and a session marked with `tokens: 60000` hands off at the end of a step at 60000 and before a tool call at 45000.
const MARK = { tokens: 60_000, cooldown: 0, max: 1 };

const open = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A server whose plugins/ folder holds the link to opencode-auto/ and whose state has the `enabled` file (unless `enabled` is false). */
const start = async ({ enabled = true, entry, ...options } = {}) => {
  const rt = await startRuntime({
    dir: join(tempDir("apana-auto-rt-"), "run"),
    plugin: null,
    setup: (sub) => {
      mkdirSync(join(sub("config/opencode"), "plugins"), { recursive: true });
      const path = join(sub("config/opencode"), "plugins", "apana-auto");
      if (entry) {
        mkdirSync(path);
        writeFileSync(join(path, "server.js"), entry);
      } else {
        symlinkSync(join(ROOT, "opencode-auto"), path);
      }
      if (enabled) {
        mkdirSync(join(sub("state"), "opencode", "apana", "auto"), { recursive: true });
        writeFileSync(join(sub("state"), "opencode", "apana", "auto", "enabled"), "");
      }
    },
    ...options,
  });
  open.push(rt);
  // The server loads a location's plugins on its first request; its log says which file it loaded (the real path, not the link).
  await rt.commands();
  const end = Date.now() + 30000;
  while (!/loading plugin" id=\S*plugins\/apana-auto /.test(rt.log())) {
    if (Date.now() > end) throw new Error(`the plugin was not loaded:\n${rt.log().split("\n").filter((l) => /plugin|ERROR|WARN/.test(l)).slice(0, 8).join("\n")}`);
    await wait(200);
  }
  await wait(700);
  assert.ok(!rt.log().includes("[apana-auto]"), `the plugin warned:\n${rt.log().split("\n").filter((l) => l.includes("[apana-auto]")).join("\n")}`);
  return rt;
};
after(async () => {
  for (const rt of open) await rt.close();
});

const getSession = async (rt, id) => (await rt.api("GET", `/api/session/${id}`)).json?.data;
async function getGoal(rt, sessionID) {
  const result = await rt.api("POST", "/api/rpc/opencode.goal/get", { input: { sessionID } });
  assert.equal(result.status, 200, result.text);
  return result.json.output;
}
/** Waits until `check(value)` is true for `read()`, or fails with `what` and the last value. */
async function until(what, read, check, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (check(last)) return last;
    await wait(400);
  }
  throw new Error(`${what}; last seen: ${JSON.stringify(last)?.slice(0, 600)}`);
}
const autoLog = (rt) => {
  try {
    return readFileSync(join(rt.dir, "state", "opencode", "apana", "auto", "auto.log"), "utf8");
  } catch {
    return "";
  }
};
const notes = (rt) => {
  const dir = join(rt.dir, "data", "opencode", "apana", "handoffs", "auto");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
};
const allSessions = async (rt) => (await rt.api("GET", "/api/session")).json?.data ?? [];
const nextSession = async (rt, id) => {
  const source = await until(`session ${id} never got \`next\``, () => getSession(rt, id), (s) => typeof s?.metadata?.apana?.next === "string");
  return source.metadata.apana.next;
};
const firstUserText = (rt, id) => until(
  `session ${id} never received its first message`,
  async () => {
    const result = await rt.api("GET", `/api/session/${id}/message?type=user&order=asc&limit=1`);
    assert.equal(result.status, 200, result.text);
    return result.json.data[0]?.text;
  },
  (text) => typeof text === "string",
);

// Use the real plugin with a test barrier before durable inbox admission or immediately after it, before the plugin writes its receipt.
function stoppedGoalEntry(phase, barrier) {
  const server = pathToFileURL(join(ROOT, "private", "opencode-auto", "server.mjs"));
  return `
    import { writeFileSync } from "node:fs";
    import { setupAuto } from ${JSON.stringify(server.href)};
    export default {
      id: "apana-auto",
      async setup(ctx) {
        const stop = (id) => {
          writeFileSync(${JSON.stringify(barrier)}, id);
          return new Promise(() => {});
        };
        const auto = await setupAuto({
          ...ctx,
          session: { ...ctx.session, hook: (name, callback) => ctx.session.hook(name, async (event) => {
            await callback(event);
            if (${phase === "before"} && name === "prompt" && event.metadata?.apanaGoalHandoff) await stop(event.sessionID);
          }) },
          storage: { ...ctx.storage, set: async (key, value) => {
            if (${phase === "after"} && key.startsWith("goal-handoff/") && value.phase === "accepted") await stop(value.destinationID);
            await ctx.storage.set(key, value);
          } },
        });
        return () => auto.dispose();
      },
    };`;
}

describe("opencode-auto on a real OpenCode 2.4.x", { skip: reason, timeout: 600000 }, () => {
  it("carries the exact goal twice, then the native reviewer has the agent read the note and completes the goal", async () => {
    const objective = '"Check <proof> & keep the quotes.\nRead the note and verify the result."';
    const evidence = "Verified by reading the handoff note.";
    const rt = await start({
      usage: { prompt: 70_000, completion: 10 },
      respond({ body, tools }) {
        const request = { body };
        const user = textOfRole(request, "user");
        const system = textOfRole(request, "system");
        if (user.includes("Reply with exactly one line of JSON")) {
          const done = textOfRole(request, "assistant").includes(evidence);
          return { text: JSON.stringify({
            verdict: done ? "done" : "continue",
            reason: done ? "The note was read and verified." : "The note still needs to be read.",
            ...(done ? {} : { next_step: "GOAL-READ-NOTE: read the handoff note now." }),
          }) };
        }
        if (tools.includes("read") && user.includes("GOAL-READ-NOTE") && system.includes('Titlul sesiunii noi: "Goal chain (3)"')) {
          if (textOfRole(request, "tool").includes("Handoff: continuarea unei sesiuni")) return { text: evidence };
          const path = /Citește (\S+\/HANDOFF\.md) mai întâi/.exec(system)?.[1];
          if (path) return { tool: { name: "read", args: { path, offset: 1, limit: 24 } } };
        }
        return { text: "Work in progress." };
      },
    });
    const source = await rt.session("Goal chain", { metadata: { apana: { auto: { ...MARK, max: 2 } } } });
    assert.equal((await rt.command(source, "goal", `"${objective}"`)).status, 204);
    const second = await nextSession(rt, source);
    const third = await nextSession(rt, second);
    const end = await until("the native reviewer did not finish the transferred goal",
      () => getGoal(rt, third), (goal) => ["complete", "paused"].includes(goal?.status));
    assert.equal(end.status, "complete", end.reason);
    assert.equal(end.objective, objective);
    assert.equal(end.rounds, 1);
    const goals = [await getGoal(rt, source), await getGoal(rt, second), end];
    assert.deepEqual(goals.map((goal) => goal.status), ["paused", "paused", "complete"]);
    assert.deepEqual(goals.map((goal) => goal.objective), [objective, objective, objective]);
    assert.equal(new Set(goals.map((goal) => goal.id)).size, 3);
    for (const [index, destination] of [second, third].entries()) {
      const saved = await getSession(rt, destination);
      const kickoffs = (await rt.messages(destination)).filter((m) => m.type === "user" && m.metadata?.apanaGoalHandoff);
      assert.equal(kickoffs.length, 1);
      assert.equal(kickoffs[0].metadata.goalID, goals[index + 1].id);
      assert.equal(kickoffs[0].metadata.apanaGoalHandoff, saved.metadata.apana.goalHandoff.id);
      const request = rt.mainRequests().find((r) => textOfRole(r, "system").includes(`Titlul sesiunii noi: ${JSON.stringify(saved.title)}`));
      assert.ok(request);
      assert.match(textOfRole(request, "system"), /Citește .*\/HANDOFF\.md mai întâi/);
      assert.match(textOfRole(request, "user"), /Check &lt;proof&gt; &amp; keep the quotes\.\nRead the note/);
      assert.doesNotMatch(JSON.stringify(request.body), /apana-goal-handoff\.txt/);
    }
    assert.ok(rt.mainRequests().some((r) => textOfRole(r, "tool").includes("Handoff: continuarea unei sesiuni")));
    assert.equal((await allSessions(rt)).length, 3);
  });

  for (const phase of ["before", "after"]) {
    it(`recovers a crash ${phase} native prompt admission without submitting another goal`, async () => {
      const root = tempDir("apana-auto-goal-recovery-");
      const data = join(root, "data");
      const workspace = join(root, "workspace");
      const barrier = join(root, "barrier");
      mkdirSync(data);
      mkdirSync(workspace);
      const options = { workspace, env: { XDG_DATA_HOME: data }, usage: { prompt: 70_000, completion: 10 } };
      const first = await start({ ...options, entry: stoppedGoalEntry(phase, barrier) });
      const source = await first.session("Goal recovery", { metadata: { keep: "source metadata", apana: { auto: MARK } } });
      const objective = `Verify admission ${phase} a crash.`;
      assert.equal((await first.command(source, "goal", objective)).status, 204);
      const destination = await until("the crash barrier was not reached", async () => existsSync(barrier) && readFileSync(barrier, "utf8"), Boolean, 15000);
      const goal = await getGoal(first, destination);
      assert.equal(goal.objective, objective, "OpenCode has already persisted the goal");
      const markedKickoff = async (rt) => (await rt.messages(destination)).find((m) => m.metadata?.apanaGoalHandoff);
      if (phase === "after") {
        const admitted = await until("the kickoff was not delivered before the crash", () => markedKickoff(first), Boolean);
        assert.equal(admitted.metadata.goalID, goal.id);
        await until("the admitted kickoff did not reach the model", async () => first.mainRequests(),
          (requests) => requests.some((r) => textOfRole(r, "system").includes("HANDOFF.md")));
      } else {
        assert.equal(await markedKickoff(first), undefined);
        const inbox = await first.api("GET", `/api/session/${destination}/inbox`);
        assert.equal(inbox.status, 200, inbox.text);
        assert.deepEqual(inbox.json.data, []);
      }
      assert.equal((await getSession(first, source)).metadata.apana.next, undefined);
      open.splice(open.indexOf(first), 1);
      await first.close(); // SIGKILL, keeping the same OpenCode database for the replacement server.

      const second = await start(options);
      if (phase === "after") {
        assert.equal(await nextSession(second, source), destination);
        assert.equal((await markedKickoff(second)).metadata.goalID, goal.id);
      } else {
        await until("recovery did not report the unadmitted kickoff", async () => autoLog(second),
          (log) => log.includes(`${source}: goal handoff to ${destination} has no durable admission proof`));
        assert.equal((await getSession(second, source)).metadata.apana.next, undefined);
        assert.equal(await markedKickoff(second), undefined);
      }
      assert.equal((await getSession(second, source)).metadata.keep, "source metadata");
      assert.equal((await getGoal(second, destination)).id, goal.id);
      assert.equal((await allSessions(second)).length, 2);
      assert.equal(second.mainRequests().length, 0);
    });
  }

  it("hands a marked session off once the stand-in provider reports a context over the threshold: a note, a new session with the same agent, model and directory, and `next` on the old one", async () => {
    const rt = await start({ usage: { prompt: 70_000, completion: 10 } });
    const id = await rt.session("marked", { agent: "plan", metadata: { apana: { auto: MARK } } }); // not the default agent: a lost agent must show
    await rt.prompt(id, "do the task");
    const old = await until("the old session never got `next`", () => getSession(rt, id), (s) => typeof s?.metadata?.apana?.next === "string");
    const made = await getSession(rt, old.metadata.apana.next);
    assert.ok(made, "the new session exists");
    assert.equal(old.agent, "plan");
    assert.equal(made.agent, "plan");
    assert.deepEqual({ id: made.model?.id, providerID: made.model?.providerID }, { id: old.model?.id, providerID: old.model?.providerID });
    assert.equal(made.location?.directory, old.location?.directory);
    assert.equal(made.metadata?.apana?.auto?.chain, 1, "the chain counts the handoffs");
    assert.equal(made.metadata?.apana?.next, undefined);
    // The note was written by the real make_context.py, in the durable folder.
    const folders = notes(rt);
    assert.equal(folders.length, 1, `one note folder, saw ${folders}`);
    assert.ok(existsSync(join(folders[0], "HANDOFF.md")));
    // The new session was told to read it and to continue.
    const told = await until("the stand-in provider never saw the prompt of the new session", async () => rt.requests(), (rs) => rs.some((r) => /HANDOFF\.md/.test(textOfRole(r, "user")) && /oprită automat/.test(textOfRole(r, "user"))));
    assert.ok(told.length > 0);
    // Exactly one handoff: the new session is over the threshold too, but its chain has reached the limit (`max: 1`).
    await wait(3000);
    const log = autoLog(rt);
    assert.equal((log.match(/handoff \(step\)/g) ?? []).length, 1, log);
    assert.match(log, /limit of 1 handoffs is reached/);
    assert.equal((await allSessions(rt)).filter((s) => s.metadata?.apana?.auto).length, 2, "the old session and one new one");
  });

  it("keeps the numbered title in the session and the first message across two consecutive handoffs", async () => {
    const rt = await start({ usage: { prompt: 70_000, completion: 10 } });
    const id = await rt.session("X", { metadata: { apana: { auto: { ...MARK, max: 2 } } } });
    await rt.prompt(id, "do the task");
    const second = await nextSession(rt, id);
    const third = await nextSession(rt, second);
    await until("the second successor never reached the handoff limit", async () => autoLog(rt), (log) => log.includes(`${third} 70010 tokens but the limit of 2 handoffs is reached`));
    for (const [destination, title] of [[second, "X (2)"], [third, "X (3)"]]) {
      const saved = await until(`session ${destination} never finished its turn`, () => getSession(rt, destination), (s) => s?.time?.idle !== undefined);
      const text = await firstUserText(rt, destination);
      const sections = text.split("\n\nTitlul sesiunii noi: ");
      assert.equal(sections.length, 2);
      const [continuation, titleData] = sections;
      assert.match(continuation, /^Citește .*\/HANDOFF\.md mai întâi/);
      assert.match(continuation, /reia imediat lucrul/);
      assert.equal(saved.title, title);
      assert.equal(JSON.parse(titleData), saved.title);
    }
    assert.equal((await getSession(rt, id)).title, "X");
    assert.equal((await getSession(rt, third)).metadata.apana.next, undefined);
    assert.equal((await allSessions(rt)).filter((s) => s.metadata?.apana?.auto).length, 3);
  });

  it("leaves the title line out for an empty source title and lets OpenCode name the destination from its first message", async () => {
    const rt = await start({ usage: { prompt: 70_000, completion: 10 } });
    const id = await rt.session("", { metadata: { apana: { auto: MARK } } });
    assert.equal((await getSession(rt, id)).title, "");
    await rt.prompt(id, "do the task");
    const destination = await nextSession(rt, id);
    const text = await firstUserText(rt, destination);
    assert.match(text, /^Citește .*\/HANDOFF\.md mai întâi/);
    assert.match(text, /reia imediat lucrul/);
    assert.doesNotMatch(text, /Titlul sesiunii noi:/);
    const titleInput = `Here is the first message of the conversation:\n\n<message>\n${text}\n</message>\n\nReply with only the title.`;
    await until("OpenCode never requested a title from the first message", async () => rt.requests(), (requests) =>
      requests.some((r) => !r.body.tools?.length && textOfRole(r, "user") === titleInput));
    const title = "Scope: stub. Method: stub. Result: stub reply, nothing was run.";
    await until("OpenCode never saved the generated title", () => getSession(rt, destination), (s) => s?.title === title);
    assert.equal((await getSession(rt, id)).title, "");
  });

  it("hands a session off once when the server has two locations for one folder: the folder named directly and through a link", async () => {
    const rt = await start({ usage: { prompt: 70_000, completion: 10 } });
    const link = join(tempDir("apana-auto-link-"), "ws");
    symlinkSync(rt.ws, link);
    await rt.api("GET", "/api/command", undefined, link); // a request from that spelling makes the server load the plugin a second time
    await until("the plugin was not loaded for the second location", async () => (rt.log().match(/loading plugin" id=\S*plugins\/apana-auto /g) ?? []).length, (n) => n >= 2, 30000);
    await wait(700);
    const id = await rt.session("twice", { metadata: { apana: { auto: MARK } } });
    await rt.prompt(id, "do the task");
    await until("the old session never got `next`", () => getSession(rt, id), (s) => typeof s?.metadata?.apana?.next === "string");
    await wait(3000);
    assert.equal(notes(rt).length, 1, "one note folder");
    assert.equal((autoLog(rt).match(/handoff \(step\)/g) ?? []).length, 1, autoLog(rt));
    assert.equal((await allSessions(rt)).filter((s) => s.metadata?.apana?.auto).length, 2, "the old session and one new one");
  });

  it("keeps the threshold under OpenCode's compaction ceiling, from the window the server reports for the model: with the default threshold of 200000 it hands off at 80000 and not at 60000", async () => {
    const rt = await start({ usage: { prompt: 60_000, completion: 10 } });
    const id = await rt.session("window", { metadata: { apana: { auto: { cooldown: 0, max: 1 } } } });
    const quiet = await quietTurn(rt, id);
    assert.equal(quiet.session.metadata?.apana?.next, undefined, "60000 is under the limit of 69000 that the stand-in's window of 100000 gives");
    rt.setUsage({ prompt: 80_000, completion: 10 });
    await rt.prompt(id, "go on");
    await until("the old session never got `next`", () => getSession(rt, id), (s) => typeof s?.metadata?.apana?.next === "string");
    assert.match(autoLog(rt), /handoff \(step\)/);
  });

  it("refuses a tool call, and hands off, once the context is over the tool limit but under the step limit: the first call runs (no usage yet), the second does not run", async () => {
    // Usage 50000 is over the tool limit (60000 - 15000 = 45000) and under the step limit (60000): only the call-before path can act.
    const marker = (name) => join(tempDir("apana-auto-marker-"), name);
    const [first, second] = [marker("first"), marker("second")];
    const rt = await start({ usage: { prompt: 50_000, completion: 10 }, script: [{ name: "shell", args: { command: `touch ${first}`, description: "first" } }, { name: "shell", args: { command: `touch ${second}`, description: "second" } }] });
    const id = await rt.session("tool", { metadata: { apana: { auto: { ...MARK, tokens: 60_000 } } } });
    await rt.prompt(id, "run two commands");
    const old = await until("the old session never got `next`", () => getSession(rt, id), (s) => typeof s?.metadata?.apana?.next === "string");
    assert.ok(existsSync(first), "the first call ran: there was no usage to go by yet");
    await wait(2000);
    assert.ok(!existsSync(second), "the second call was refused: it did not run");
    const log = autoLog(rt);
    assert.equal((log.match(/handoff \(tool\)/g) ?? []).length, 1, log);
    assert.equal((log.match(/handoff \(step\)/g) ?? []).length, 0, "the step limit was not reached");
    assert.ok(old.metadata.apana.next.startsWith("ses_"));
  });

  it("refuses a tool call that a later prompt makes in the old session, after its handoff, with a text that names the new session and how to open it", async () => {
    // As in a window that did not follow the handoff (2026-11-21): the user goes on in the old session, and its model reads the refusal.
    const marker = (name) => join(tempDir("apana-auto-marker-"), name);
    const [first, second, third] = [marker("first"), marker("second"), marker("third")];
    const call = (path, description) => ({ name: "shell", args: { command: `touch ${path}`, description } });
    const script = [call(first, "first"), call(second, "second")]; // the stand-in reads this array at each request, so a call added later is the next one
    const rt = await start({ usage: { prompt: 50_000, completion: 10 }, script });
    const id = await rt.session("later", { metadata: { apana: { auto: MARK } } });
    await rt.prompt(id, "run two commands");
    const next = (await until("the old session never got `next`", () => getSession(rt, id), (s) => typeof s?.metadata?.apana?.next === "string")).metadata.apana.next;
    await until("the new session never finished its turn", () => getSession(rt, next), (s) => s?.time?.idle !== undefined); // it took no scripted call
    script.push(call(third, "third"));
    await rt.prompt(id, "go on");
    const refusals = await until(
      "the old session has no refused call that names the new session",
      async () => (await rt.messages(id)).flatMap((m) => m.content ?? []).filter((p) => p.type === "tool" && p.state?.status === "error").map((p) => p.state.error?.message ?? ""),
      (texts) => texts.some((text) => text.includes(next)),
    );
    const text = refusals.find((t) => t.includes(next));
    assert.match(text, /handed off to a new session/);
    assert.ok(text.includes(`opencode-auto -s ${next}`), text);
    assert.ok(!existsSync(third), "the refused call did not run");
  });

  /** Runs a turn and gives the plugin time it would need for a handoff (the ones above finish in about 3 s), then says what it did. */
  async function quietTurn(rt, id) {
    await rt.prompt(id, "do the task");
    await until("the stand-in provider never got the request", async () => rt.mainRequests(), (rs) => rs.length > 0);
    await wait(5000);
    return { session: await getSession(rt, id), log: autoLog(rt), notes: notes(rt), marked: (await allSessions(rt)).filter((s) => s.metadata?.apana?.auto).length };
  }

  it("does nothing for a session that is not marked, however large its context (also one that has other apana metadata)", async () => {
    const rt = await start({ usage: { prompt: 250_000, completion: 10 } });
    const id = await rt.session("plain", { metadata: { keep: 1, apana: { other: true } } });
    const seen = await quietTurn(rt, id);
    assert.equal(seen.session.metadata?.apana?.next, undefined);
    assert.deepEqual(seen.notes, []);
    assert.doesNotMatch(seen.log, /handoff/);
    assert.equal(seen.marked, 0);
  });

  it("does nothing for a marked session under its threshold", async () => {
    const rt = await start({ usage: { prompt: 30_000, completion: 10 } });
    const id = await rt.session("under", { metadata: { apana: { auto: MARK } } });
    const seen = await quietTurn(rt, id);
    assert.equal(seen.session.metadata?.apana?.next, undefined);
    assert.deepEqual(seen.notes, []);
    assert.doesNotMatch(seen.log, /handoff/);
  });

  it("stops at once when the `enabled` file is removed, in a server that is already running", async () => {
    const rt = await start({ usage: { prompt: 70_000, completion: 10 } });
    rmSync(join(rt.dir, "state", "opencode", "apana", "auto", "enabled"));
    const id = await rt.session("off", { metadata: { apana: { auto: MARK } } });
    const seen = await quietTurn(rt, id);
    assert.equal(seen.session.metadata?.apana?.next, undefined);
    assert.deepEqual(seen.notes, []);
    assert.doesNotMatch(seen.log, /handoff/);
  });
});
