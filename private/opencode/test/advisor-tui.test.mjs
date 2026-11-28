import assert from "node:assert/strict";
import { it } from "node:test";
import { setupAdvisorTui } from "../advisor-tui.mjs";

const MODELS = [
  { providerID: "remote", id: "r", name: "Reasoning", variants: ["low", "high"] },
  { providerID: "local", id: "r", name: "Local", variants: [] },
];

function terminal(model, effort) {
  const dialogs = [];
  const calls = [];
  const toasts = [];
  let commands;
  const route = { type: "session", sessionID: "source" };
  setupAdvisorTui({
    keymap: { layer: (create) => { commands = create().commands; } },
    ui: {
      router: { current: () => route },
      dialog: { select: async (dialog) => { dialogs.push(dialog); return dialogs.length === 1 ? model : effort; } },
      toast: { show: (toast) => toasts.push(toast) },
    },
    client: { rpc: () => ({
      options: async () => ({ models: MODELS }),
      consult: async (input) => { calls.push(input); return { ok: true }; },
      cancel: async (input) => { calls.push(input); return { cancelled: true }; },
    }) },
  });
  return { consult: commands[0], cancel: commands[1], route, dialogs, calls, toasts };
}

it("chooses a configured model and sends only its selected variant and question", async () => {
  const { consult, dialogs, calls } = terminal("remote/r", 2);
  assert.equal(consult.slash.name, "apana:advisor");
  await consult.run("Ce lipsește?");
  assert.equal(dialogs[0].current, "remote/r");
  assert.equal(dialogs[1].current, 2);
  assert.deepEqual(dialogs[1].options.map(({ title }) => title), ["Default", "low", "high"]);
  assert.deepEqual(calls, [{ sessionID: "source", providerID: "remote", modelID: "r", variant: "high", question: "Ce lipsește?" }]);
});

it("uses the model default when there are no variants and passes an explicit cancellation to the source", async () => {
  const { consult, cancel, dialogs, calls } = terminal("local/r", 0);
  await consult.run();
  assert.equal(dialogs[1].current, 0);
  assert.deepEqual(dialogs[1].options.map(({ title }) => title), ["Default"]);
  assert.deepEqual(calls, [{ sessionID: "source", providerID: "local", modelID: "r", question: "" }]);
  await cancel.run();
  assert.deepEqual(calls[1], { sessionID: "source" });
});

it("dismissing either selector leaves the source alone", async () => {
  for (const model of [undefined, "remote/r"]) {
    const { consult, calls, toasts } = terminal(model, undefined);
    await consult.run();
    assert.deepEqual(calls, []);
    assert.deepEqual(toasts, []);
  }
});
