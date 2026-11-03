// Tests of the pure part of update-sessions: ps, registry, prompt-box classification, the Reloaded: confirmation. Fixtures are captures of the real screens, ps and registry
// of one laptop (names, paths and session ids replaced by samples); the shapes marked "constructed" below are built from the measured table of the plan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyScreen, confirmReload, gateBeforeScreen, parsePs, readRegistry } from "../sessions.mjs";

const FX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const screen = (name) => readFileSync(join(FX, "screens", name), "utf8");
const B = "─".repeat(40);
const NBSP = " ";
const RELOADED = (p = 5, s = 51) => `  ⎿  Reloaded: ${p} plugins · ${s} skills · 11 agents · 2 hooks · 0 plugin MCP servers · 0 plugin LSP servers`;

describe("parsePs", () => {
  const found = parsePs(readFileSync(join(FX, "ps.txt"), "utf8"));

  it("keeps exactly the claude processes that have a terminal, with the tty as iTerm2 names it", () => {
    assert.deepEqual(found.map((p) => p.pid).sort((a, b) => a - b), [11111, 39482, 42358, 54654, 86055, 87284, 99347]);
    assert.equal(found.find((p) => p.pid === 39482).tty, "/dev/ttys000");
    assert.equal(found.find((p) => p.pid === 11111).tty, "/dev/ttys007", "argv0 without a path (claude --resume …) is matched too");
  });

  it("leaves out the wrapper, the proxy and the desktop helper, which a grep for claude would catch", () => {
    const pids = found.map((p) => p.pid);
    for (const pid of [2640, 32021, 42465, 42469, 50301, 68559]) assert.ok(!pids.includes(pid), `${pid} is not a claude session`);
  });

  it("leaves out a claude without a terminal and a program whose basename only resembles claude", () => {
    const text = "  PID  PPID TTY      COMMAND\n  700     1 ??       /usr/local/bin/claude -p hi\n  701     1 ttys009  /Applications/Claude.app/Contents/MacOS/Claude\n  702     1 ttys010  /usr/bin/claude-auto --x\n  703     1 ttys011  /usr/bin/claude\n";
    assert.deepEqual(parsePs(text).map((p) => p.pid), [703]);
  });
});

describe("readRegistry", () => {
  const registry = readRegistry(join(FX, "registry"));

  it("reads the <pid>.json files and ignores the <pid>.<64 hex>.key files", () => {
    assert.deepEqual([...registry.keys()].sort((a, b) => a - b), [39482, 42358, 54654, 86055, 87284, 99347]);
    assert.equal(registry.get(39482).status, "idle");
    assert.equal(registry.get(54654).status, "busy");
    assert.equal(registry.get(99347).name, "self-session");
    assert.equal(registry.get(99347).sessionId, "00099347-0000-0000-0000-000000000000");
  });

  it("returns an empty map for a folder that does not exist, so that a pid without a file is just unknown", () => {
    assert.equal(readRegistry(join(FX, "nope")).size, 0);
    assert.equal(registry.get(11111), undefined);
  });
});

describe("classifyScreen", () => {
  it("sees an empty prompt in every measured form: indent 0, indent 3, named border, NBSP or nothing after the prompt sign", () => {
    for (const name of ["idle-empty.txt", "waiting-agents-panel.txt", "busy-spinner.txt", "named-border-indent3-after-reload.txt", "echo-above-empty-box.txt"]) assert.equal(classifyScreen(screen(name)).state, "empty", name);
    for (const text of [`${B}\n❯\n${B}\n`, `   ${B}\n   ❯\n   ${B}\n`, `${B}\n❯${NBSP}\n${B}\n`, `${B}\n❯ \n${B}\n`, `\x1b[2m${B}\x1b[0m\n\x1b[1m❯\x1b[0m${NBSP}\n\x1b[2m${B}\x1b[0m\n`]) assert.equal(classifyScreen(text).state, "empty", JSON.stringify(text));
  });

  it("sees text typed after the prompt sign, and text that sits only on the continuation row of a prompt that began with Shift+Enter", () => {
    assert.equal(classifyScreen(screen("idle-text.txt")).state, "text");
    assert.equal(classifyScreen(screen("text-on-continuation.txt")).state, "text");
  });

  it("gives unknown, with the reason to show, for the /plugin menu: its selected row begins with the prompt sign but there is no box", () => {
    const r = classifyScreen(screen("plugin-menu.txt"));
    assert.equal(r.state, "unknown");
    assert.match(r.reason, /no prompt box on screen \(a menu or dialog is open\?\)/);
  });

  it("does not take an echo of a sent message for a live prompt: the box below an echo decides", () => {
    assert.equal(classifyScreen(screen("echo-above-empty-box.txt")).state, "empty");
    assert.equal(classifyScreen("❯ /reload-plugins\n" + RELOADED() + "\n").state, "unknown", "an echo with no box is never a prompt");
  });

  it("looks only at the last 25 lines and ignores the blank rows that iTerm2 pads below the screen", () => {
    const old = `${B}\n❯ old text\n${B}\n`;
    const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(classifyScreen(`${old}${filler}\n${B}\n❯\n${B}\n\n\n\n\n`).state, "empty");
    assert.equal(classifyScreen(`${old}${filler}\n`).state, "unknown");
  });
});

describe("gateBeforeScreen: the cheap checks that decide whether the screen is read at all", () => {
  const idle = { status: "idle", name: "alpha" };

  it("lets an idle session found exactly once in iTerm2 go on to the screen check", () => {
    assert.deepEqual(gateBeforeScreen({ entry: idle, matches: 1, isSelf: false }), { ok: true });
  });

  it("skips a busy session with the command to type later, and a waiting session with where to answer", () => {
    assert.match(gateBeforeScreen({ entry: { status: "busy" }, matches: 1, isSelf: false }).reason, /^busy: type \/reload-plugins when it is idle$/);
    assert.match(gateBeforeScreen({ entry: { status: "waiting" }, matches: 1, isSelf: false }).reason, /^waiting for your answer in the session: answer there, then type \/reload-plugins$/);
    assert.match(gateBeforeScreen({ entry: { status: "starting" }, matches: 1, isSelf: false }).reason, /status "starting"/);
  });

  it("skips a process with no registry file as unknown, and a tty that iTerm2 does not list exactly once", () => {
    assert.match(gateBeforeScreen({ entry: undefined, matches: 1, isSelf: false }).reason, /no registry file/);
    assert.match(gateBeforeScreen({ entry: idle, matches: 0, isSelf: false }).reason, /not an iTerm2 session/);
    assert.match(gateBeforeScreen({ entry: idle, matches: 2, isSelf: false }).reason, /2 iTerm2 sessions/);
  });

  it("does not ask the invoking session to be idle (it is busy by definition), but still wants its tty exactly once", () => {
    assert.deepEqual(gateBeforeScreen({ entry: { status: "busy" }, matches: 1, isSelf: true }), { ok: true });
    assert.equal(gateBeforeScreen({ entry: { status: "busy" }, matches: 0, isSelf: true }).ok, false);
  });
});

describe("confirmReload: the proof that the typed command ran", () => {
  const box = `${B}\n❯\n${B}\n`;
  const before = `${screen("idle-empty.txt")}`;
  const echoed = (reloaded) => `${screen("idle-empty.txt").split("\n").slice(0, 3).join("\n")}\n❯ /reload-plugins\n${reloaded}\n \n${box}`;

  it("confirms when the text above the box changed and ends with the echo followed by the Reloaded: line, and returns the numbers", () => {
    const r = confirmReload(before, echoed(RELOADED(6, 53)));
    assert.equal(r.confirmed, true);
    assert.equal(r.status, "reloaded");
    assert.deepEqual(r.counts, { plugins: 6, skills: 53, agents: 11, hooks: 2 });
    assert.match(r.line, /^Reloaded: 6 plugins · 53 skills · 11 agents · 2 hooks/);
  });

  it("does not confirm on a Reloaded: line that was already there before the typing (the trap of the reload done by hand earlier)", () => {
    const old = screen("named-border-indent3-after-reload.txt");
    assert.equal(confirmReload(old, old).confirmed, false);
    assert.equal(confirmReload(old, old + "\n\n").confirmed, false, "blank rows below the box do not count as a change");
  });

  it("confirms a second identical echo + Reloaded: pair pushed above the box after an old one", () => {
    const old = screen("echo-above-empty-box.txt");
    const again = old.replace(/\n \n─/, `\n❯ /reload-plugins\n${RELOADED(6, 53)}\n \n─`);
    assert.notEqual(old, again);
    assert.equal(confirmReload(old, again).confirmed, true);
  });

  it("does not confirm a change that is not the echo followed by Reloaded: (a spinner, another message, only the echo)", () => {
    assert.equal(confirmReload(before, screen("busy-spinner.txt")).confirmed, false);
    assert.equal(confirmReload(before, echoed("  ⎿  something else happened")).confirmed, false);
    assert.equal(confirmReload(before, `❯ /reload-plugins\n \n${box}`).confirmed, false);
  });

  it("does not confirm when there is no live box to take the text above it from", () => {
    assert.equal(confirmReload(before, screen("plugin-menu.txt")).confirmed, false);
  });

  it("keeps the whole line when its numbers are in a format it does not know (still confirmed: the line is on screen)", () => {
    const r = confirmReload(before, echoed("  ⎿  Reloaded: a new kind of summary"));
    assert.equal(r.confirmed, true);
    assert.equal(r.counts, null);
    assert.equal(r.line, "Reloaded: a new kind of summary");
  });

  it("marks the documented variants: errors during load as a warning, an MCP change held back as held (constructed from the docs, not seen yet)", () => {
    assert.equal(confirmReload(before, echoed(`${RELOADED()}\n  ⎿  2 errors during load. Run /plugin for details.`)).status, "warning");
    assert.equal(confirmReload(before, echoed(`${RELOADED()}\n  ⎿  This reload changes MCP tools. Run /reload-plugins --force to apply.`)).status, "held");
  });
});
