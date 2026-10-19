// End to end on a small invented transcript: nothing real is read, nothing leaves the machine. Needs python3 and the copy of handoff-verify's modules (scripts/handoff_verify/), both in this repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "compact-handoff-test-"));
const home = join(root, "home");
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { isSidechain: false, userType: "external", cwd: root, sessionId: "11111111-1111-4111-8111-111111111111", version: "2.1.0" };
const longListing = "total 8\n" + "-rw-r--r-- 1 u g 10 Jan 1 12:00 file.txt\n".repeat(60);
const longCommand = "ls -la " + "/some/very/long/directory/name/".repeat(6);
const longEdit = "x".repeat(1500);

function transcript(sessionId, firstCalls = [], extra = []) {
  let n = 0, parent = null;
  const rec = (type, message) => { n += 1; const r = { ...base, sessionId, type, uuid: uid(n), parentUuid: parent, timestamp: `2026-01-01T10:00:${String(n).padStart(2, "0")}.000Z`, message }; parent = r.uuid; return r; };
  const out = [rec("user", { role: "user", content: "hello, please list the files" })];
  let tool = 0;
  const call = (name, input, result) => {
    tool += 1; const id = `toolu_${sessionId.slice(0, 4)}${tool}`;
    out.push(rec("assistant", { role: "assistant", content: [{ type: "tool_use", id, name, input }] }));
    out.push(rec("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] }));
  };
  for (const [name, input, result] of firstCalls) call(name, input, result);
  call("Bash", { command: longCommand }, longListing);
  call("Edit", { file_path: join(root, "notes.txt"), old_string: longEdit, new_string: "short" }, "The file has been updated successfully.");
  out.push(rec("assistant", { role: "assistant", content: [{ type: "text", text: "Done: there are three files. Next I will write the report." }] }));
  for (const [name, input, result] of extra) call(name, input, result);
  out.push(rec("user", { role: "user", content: "ok go on" }));
  return out;
}
const write = (path, records) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n"); return path; };
const xdg = join(home, ".local", "share");   // the OpenCode database of the tests lives here; XDG_DATA_HOME is set, so the real one is never opened
const py = (args, env = {}) => spawnSync("python3", ["-B", join(SCRIPTS, "make_context.py"), ...args], { encoding: "utf8", timeout: 180_000, env: { ...process.env, XDG_DATA_HOME: xdg, ...env, PYTHONDONTWRITEBYTECODE: "1" } });
const ocSid = "ses_0123456789abcdefAAAAAA";
// a database of OpenCode's shape with one synthetic session (every message type and content kind), made by the program's own test helper
const ocDb = (path, sessions) => { mkdirSync(dirname(path), { recursive: true }); const r = spawnSync("python3", ["-B", "-c", "import json,sys; sys.path.insert(0, sys.argv[1]); import opencode_source as oc; oc.make_db(sys.argv[2], {k: (oc.synthetic_rows() if v is None else [tuple(x) for x in v]) for k, v in json.loads(sys.argv[3]).items()}, legacy=None)", SCRIPTS, path, JSON.stringify(sessions)], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return path; };
const intro = (text) => text.slice(0, text.indexOf("\n---\n"));

before(() => mkdirSync(home, { recursive: true }));
after(() => rmSync(root, { recursive: true, force: true }));

describe("make_context.py on an invented transcript", () => {
  const folder = join(root, "handoff-0123abcd-20260101-test");
  let text;

  it("writes HANDOFF.md and blobs/ with the messages whole, the long records in blobs, and a passed check", () => {
    const session = write(join(root, "s1.jsonl"), transcript("11111111-1111-4111-8111-111111111111"));
    const r = py([session, folder]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    assert.match(r.stdout, /start the new session with:\n {2}claude "Citește .*HANDOFF\.md și urmează instrucțiunile din el\."/);
    text = readFileSync(join(folder, "HANDOFF.md"), "utf8");
    for (const message of ["hello, please list the files", "Done: there are three files. Next I will write the report.", "ok go on"]) assert.ok(text.includes(message), `whole message: ${message}`);
    const blobs = readdirSync(join(folder, "blobs")).map((f) => readFileSync(join(folder, "blobs", f), "utf8"));
    assert.ok(blobs.some((b) => b.includes("file.txt") && b.length > 1500), "the long listing is in a blob");
    assert.ok(blobs.some((b) => b.includes(longEdit)), "the long Edit call is in a blob");
    assert.equal(text.includes(longEdit), false, "and not in HANDOFF.md");
  });

  it("starts every inline record with a short id that the file declares, one per uuid, and keeps the whole uuid in the blobs", () => {
    const declared = /the first (\d+) characters of the record's uuid/.exec(text);
    assert.ok(declared, "the header says how long the ids are");
    const n = Number(declared[1]);
    assert.ok(n >= 8 && n <= 36);
    const heads = text.split("\n").filter((l) => /^\[[0-9a-f-]+ (user|assistant)\] /.test(l));
    assert.ok(heads.length >= 4, "inline records are there");
    for (const h of heads) assert.equal(/^\[([0-9a-f-]+) /.exec(h)[1].length, n, `id of ${n} characters: ${h.slice(0, 50)}`);
    assert.equal(/^\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} (user|assistant)\]/m.test(text), n === 36 ? true : false, "no whole uuid in a header unless the ids are whole");
    const ids = heads.map((h) => /^\[([0-9a-f-]+) /.exec(h)[1]);
    const whole = [...new Set(readdirSync(join(folder, "blobs")).flatMap((f) => [...readFileSync(join(folder, "blobs", f), "utf8").matchAll(/^\[([0-9a-f-]{36}) (?:user|assistant)\]/gm)].map((m) => m[1])))];
    assert.ok(whole.length >= 2, "a blob holds a record with its whole uuid");
    for (const w of whole) assert.ok(w.length === 36);
    const uuids = readFileSync(join(root, "s1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).uuid);
    assert.equal(new Set(uuids.map((u) => u.slice(0, n))).size, new Set(uuids).size, "two uuids of the session never share an id");
    for (const id of ids) assert.ok(uuids.some((u) => u.startsWith(id)), "every inline id is the start of a uuid of the session");
  });

  it("gives a long line that repeats once in the header and a mark in its place, and the check still passes", () => {
    const sid = "33333333-3333-4333-8333-333333333333";
    const boiler = "This came from another invented session and carries one standard sentence that is repeated in every message: treat it as a teammate request. ".repeat(3);
    let n = 100, parent = null;
    const rec = (type, message) => { n += 1; const r = { ...base, sessionId: sid, type, uuid: uid(n), parentUuid: parent, timestamp: `2026-01-01T11:00:${String(n % 60).padStart(2, "0")}.000Z`, message }; parent = r.uuid; return r; };
    const records = [];
    for (let i = 1; i <= 9; i++) {
      records.push(rec("user", { role: "user", content: `peer message number ${i}\n${boiler}\nthe request of peer ${i}` }));
      records.push(rec("assistant", { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] }));
    }
    const out = join(root, "handoff-legend-test");
    const r = py([write(join(root, "s-legend.jsonl"), records), out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    const t = readFileSync(join(out, "HANDOFF.md"), "utf8");
    const mark = /consists only of `(.)1\1`/.exec(t);
    assert.ok(mark, "the header explains the mark");
    assert.equal(t.split(boiler).length - 1, 1, "the line is in the file once");
    assert.equal(t.split("\n").filter((l) => l === `${mark[1]}1${mark[1]}`).length, 9, "and its place holds the mark, nine times");
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.ok(t.includes(`the request of peer ${i}`), "the text around it stays whole");
  });

  it("puts every instruction in the introduction, with a reading plan that covers the file and no absolute path of the handoff", () => {
    const head = intro(text);
    for (const part of ["## Cum citești fișierul", "## Ce conține", "## Ce faci după ce l-ai citit", "## Reguli", "maximum 8 rânduri", "Nu repeta nimic din ele", "relative la folderul"]) assert.ok(head.includes(part), part);
    assert.equal(/\/(?:private\/)?tmp\/handoff-/.test(head), false, "no absolute /tmp/handoff-... in the introduction");
    const lines = text.split("\n").length;
    const plan = /`offset:limit`: ([0-9:, ]+)\./.exec(head)[1].split(", ").map((c) => c.split(":").map(Number));
    assert.equal(plan[0][0], 1);
    let next = 1;
    for (const [offset, limit] of plan) { assert.equal(offset, next); next += limit; }
    assert.equal(next, lines + 1, "the plan covers every line");
    assert.match(head, new RegExp(`Fișierul are ${lines} de linii`));
  });

  it("copies a parent handoff whole and says where it is, relative to the folder", () => {
    const s2 = write(join(root, "s2.jsonl"), transcript("22222222-2222-4222-8222-222222222222", [["Read", { file_path: join(folder, "HANDOFF.md") }, "1\t# Handoff: continuarea unei sesiuni\n2\tparent text\n"]]));
    const out2 = join(root, "handoff-4567cdef-20260102-child");
    const r = py([s2, out2]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /parent handoff: .*HANDOFF\.md -> .*parents\/handoff-0123abcd-20260101-test\/HANDOFF\.md/);
    assert.equal(readFileSync(join(out2, "parents", "handoff-0123abcd-20260101-test", "HANDOFF.md"), "utf8"), text, "the parent is copied byte for byte");
    assert.ok(existsSync(join(out2, "parents", "handoff-0123abcd-20260101-test", "blobs")));
    const head = intro(readFileSync(join(out2, "HANDOFF.md"), "utf8"));
    assert.ok(head.includes("## Handoff părinte") && head.includes("`parents/handoff-0123abcd-20260101-test/HANDOFF.md`"));
  });

  it("moves the text of a skill that the system injected (isMeta) to a blob and says so; a typed message with the same words and a session without a skill stay as they were", () => {
    const sid = "55555555-5555-4555-8555-555555555555", prefix = "Base directory for this skill: ";
    const skillText = `${prefix}/x/skills/demo\n\n# demo\n${"instruction line\n".repeat(150)}\nARGUMENTS: do X`;
    const typed = `${prefix}/x/skills/typed, but I typed this myself ${"t".repeat(300)}`;
    const records = transcript(sid, [["Skill", { skill: "demo", args: "do X" }, "Launching skill: demo"]]);
    const last = records[records.length - 1];
    const meta = { ...base, sessionId: sid, type: "user", uuid: uid(900), parentUuid: last.uuid, timestamp: "2026-01-01T11:00:00.000Z", isMeta: true, message: { role: "user", content: [{ type: "text", text: skillText }] } };
    const typedRec = { ...meta, uuid: uid(901), parentUuid: uid(900), isMeta: undefined, message: { role: "user", content: typed } };
    const out = join(root, "handoff-5555eeee-20260104-skill");
    const r = py([write(join(root, "s5.jsonl"), [...records, meta, typedRec]), out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    const t = readFileSync(join(out, "HANDOFF.md"), "utf8"), blobs = readdirSync(join(out, "blobs")).map((f) => readFileSync(join(out, "blobs", f), "utf8"));
    assert.equal(blobs.filter((b) => b.includes("instruction line")).length, 1, "the skill text is in exactly one blob");
    assert.ok(blobs.some((b) => b.endsWith("ARGUMENTS: do X\n") || b.includes("ARGUMENTS: do X")));
    assert.equal(t.includes("instruction line"), false, "and not inline");
    assert.ok(t.includes("[user] skill: /x/skills/demo"), "the marker names the skill");
    assert.ok(t.includes(typed), "the typed message stays inline, whole");
    assert.ok(t.includes('"skill": "demo", "args": "do X"'), "the Skill call is still inline with its arguments");
    assert.ok(intro(t).includes("abilități (skill) încărcate de sistem"), "the introduction has the clause");
    const plain = readFileSync(join(folder, "HANDOFF.md"), "utf8");
    assert.equal(intro(plain).includes("abilități (skill)"), false, "a session without a skill record has the old introduction");
    const cutOut = join(root, "cut", "skill.md");
    assert.equal(py([join(root, "s5.jsonl"), cutOut, "--cut"]).status, 0);
    const cutText = readFileSync(cutOut, "utf8");
    assert.ok(cutText.includes("instruction line") && cutText.includes("ARGUMENTS: do X"), "--cut keeps the skill text whole");
    assert.equal(intro(cutText).includes("abilități (skill)"), false);
  });

  it("moves the notification of a background task (origin task-notification) to a blob, shows its summary in the marker and says so; typed text, a peer message, a compaction summary, a short notification and --cut stay as they were", () => {
    const sid = "66666666-6666-4666-8666-666666666666", tag = "<task-notification>";
    const longNote = `${tag}\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "Read the paper" finished</summary>\n<result>${"finding line\n".repeat(60)}</result>\n</task-notification>`;
    const shortNote = `${tag}\n<task-id>b2</task-id>\n<summary>Background command "wait" completed (exit code 0)</summary>\n</task-notification>`;
    const peer = `Another Claude session sent a message:\n<cross-session-message from="x">${"peer line\n".repeat(60)}</cross-session-message>`;
    const compacted = `This session is being continued from a previous conversation that ran out of context. ${"summary line\n".repeat(60)}`;
    assert.ok(longNote.length > 300 && shortNote.length <= 300);
    const records = transcript(sid);
    let parent = records[records.length - 1].uuid;
    const more = (n, content, extra) => { const r = { ...base, sessionId: sid, type: "user", uuid: uid(n), parentUuid: parent, timestamp: "2026-01-01T11:00:00.000Z", message: { role: "user", content }, ...extra }; parent = r.uuid; return r; };
    const note = { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification" };
    const all = [...records, more(910, longNote, note), more(911, shortNote, note), more(912, longNote), more(913, peer, { isMeta: true, origin: { kind: "peer" }, promptSource: "system", turnOrigin: "peer" }), more(914, compacted, { isCompactSummary: true })];
    const sessionFile = write(join(root, "s6.jsonl"), all);
    const out = join(root, "handoff-6666eeee-20260105-note");
    const r = py([sessionFile, out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    const t = readFileSync(join(out, "HANDOFF.md"), "utf8"), blobs = readdirSync(join(out, "blobs")).map((f) => readFileSync(join(out, "blobs", f), "utf8"));
    assert.equal(blobs.filter((b) => b.includes("finding line")).length, 1, "the notification is in exactly one blob (the typed copy of the same words stays inline)");
    assert.equal(t.split("finding line").length - 1, 60, "and the typed copy is inline: 60 lines, no more");
    assert.ok(t.includes('[user] task: Agent "Read the paper" finished'), "the marker shows the summary");
    assert.ok(t.includes(shortNote), "a notification of 300 characters or fewer stays inline");
    assert.ok(t.includes("peer line") && t.includes("summary line"), "a peer message and a compaction summary stay inline");
    assert.equal(blobs.some((b) => b.includes("peer line") || b.includes("summary line")), false);
    assert.ok(intro(t).includes("notificare a unei sarcini de fundal"), "the introduction has the clause");
    const cutOut = join(root, "cut", "note.md");
    assert.equal(py([sessionFile, cutOut, "--cut"]).status, 0);
    const cutText = readFileSync(cutOut, "utf8");
    assert.equal(cutText.split("finding line").length - 1, 120, "--cut keeps both notification texts whole");
    assert.equal(intro(cutText).includes("sarcini de fundal"), false);
    const only = write(join(root, "s7.jsonl"), [...records, more(920, shortNote, note)]);
    const out2 = join(root, "handoff-7777eeee-20260105-short");
    assert.equal(py([only, out2]).status, 0);
    const t2 = readFileSync(join(out2, "HANDOFF.md"), "utf8");
    assert.ok(t2.includes(shortNote) && !t2.includes("[user] task:"), "a session whose only notification is short has no marker");
    assert.equal(intro(t2).includes("sarcini de fundal"), false, "and no clause");
  });

  it("moves the middle prompts of the SDK (promptSource sdk, neither the first nor the last) to blobs with a '[user] sdk:' marker and says so; the first and the last, typed text, short prompts, 2 prompts and --cut stay as they were", () => {
    const sid = "88888888-8888-4888-8888-888888888888";
    const prompt = (tag) => `${tag} relayed instruction line\n${"relayed line\n".repeat(40)}Answer of the user: ${tag}-ANSWER`;
    assert.ok(prompt("P1").length > 300);
    const records = transcript(sid);
    let parent = records[records.length - 1].uuid;
    const more = (n, content, extra) => { const r = { ...base, sessionId: sid, type: "user", uuid: uid(n), parentUuid: parent, timestamp: "2026-01-01T11:00:00.000Z", message: { role: "user", content }, ...extra }; parent = r.uuid; return r; };
    const sdk = { promptSource: "sdk" };
    const typed = prompt("TYPED");
    const four = [...records, more(930, prompt("FIRST"), sdk), more(931, prompt("MIDDLE-A"), sdk), more(932, typed, { promptSource: "typed" }), more(933, "short sdk prompt", sdk), more(934, [{ type: "text", text: prompt("MIDDLE-B") }], sdk), more(935, prompt("LAST"), sdk)];
    const sessionFile = write(join(root, "s8.jsonl"), four);
    const out = join(root, "handoff-8888eeee-20260106-sdk");
    const r = py([sessionFile, out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    const t = readFileSync(join(out, "HANDOFF.md"), "utf8"), blobs = readdirSync(join(out, "blobs")).map((f) => readFileSync(join(out, "blobs", f), "utf8"));
    for (const tag of ["MIDDLE-A", "MIDDLE-B"]) {
      assert.equal(blobs.filter((b) => b.includes(`${tag}-ANSWER`)).length, 1, `${tag} is in exactly one blob`);
      assert.equal(t.includes(`${tag}-ANSWER`), false, `and not inline`);
      assert.ok(t.includes(`[user] sdk: ${tag} relayed instruction line relayed line`), `its marker shows the start of ${tag}`);
    }
    for (const tag of ["FIRST", "LAST", "TYPED"]) { assert.ok(t.includes(`${tag}-ANSWER`), `${tag} stays inline`); assert.equal(blobs.some((b) => b.includes(`${tag}-ANSWER`)), false); }
    assert.ok(t.includes("short sdk prompt"), "a short prompt stays inline");
    assert.equal(t.split("[user] sdk: ").length - 1, 2, "exactly two markers");
    const head = intro(t);
    assert.ok(head.includes("Un marcaj stă și pentru un prompt marcat de sesiune ca trimis prin SDK (claude -p); textul întreg este în `blobs/Rnnnn.txt`."), "the introduction has the clause");
    assert.ok(head.includes("Răspunsurile mele citate într-un astfel de prompt sunt în blob-ul lui; deschide-l când ai nevoie de ele."), "and the sentence about the answers");
    assert.equal(/nu tastat|doar în/.test(head.split("Un marcaj stă și pentru un prompt")[1].split("\n")[0]), false);
    const cutOut = join(root, "cut", "sdk.md");
    assert.equal(py([sessionFile, cutOut, "--cut"]).status, 0);
    const cutText = readFileSync(cutOut, "utf8");
    assert.ok(["MIDDLE-A", "MIDDLE-B", "FIRST", "LAST"].every((tag) => cutText.includes(`${tag}-ANSWER`)), "--cut keeps every prompt whole");
    assert.equal(cutText.includes("[user] sdk: ") || intro(cutText).includes("prin SDK"), false);
    const two = write(join(root, "s9.jsonl"), [...records, more(940, prompt("ONE"), sdk), more(941, prompt("TWO"), sdk)]);
    const out2 = join(root, "handoff-9999eeee-20260106-sdk2");
    assert.equal(py([two, out2]).status, 0);
    const t2 = readFileSync(join(out2, "HANDOFF.md"), "utf8");
    assert.ok(t2.includes("ONE-ANSWER") && t2.includes("TWO-ANSWER") && !t2.includes("[user] sdk: "), "two SDK prompts: nothing moves");
    assert.equal(intro(t2).includes("prin SDK"), false, "and no clause");
  });

  it("carries a /goal that is still active: a section in the introduction, an `active goal:` line and a last line that starts the new session with the same goal; a goal that was achieved, cleared or switched off with --no-goal changes nothing", () => {
    const sid = "66666666-6666-4666-8666-666666666666";
    const goalRec = (n, attachment) => ({ ...base, sessionId: sid, type: "attachment", uuid: uid(800 + n), timestamp: `2026-01-01T09:00:${String(n).padStart(2, "0")}.000Z`, attachment });
    const hostile = "fix it's \"all\" $HOME `id` {x}; then --- done /tmp/handoff-0123abcd-20260101-old/HANDOFF.md";
    const set = goalRec(1, { type: "goal_status", met: false, sentinel: true, condition: hostile });
    const check = goalRec(2, { type: "goal_status", met: false, condition: hostile, reason: "two findings are still open" });
    const achieved = goalRec(3, { type: "goal_status", met: true, condition: hostile, reason: "all fixed", iterations: 2 });
    const cleared = goalRec(3, { type: "goal_status", met: true, sentinel: true, condition: hostile });
    const insert = (extra) => { const rs = transcript(sid); rs.splice(2, 0, ...extra); return rs; };
    const out = join(root, "handoff-6666abcd-20260101-goal");
    const r = py([write(join(root, "g1.jsonl"), insert([set, check])), out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    assert.match(r.stdout, /active goal: fix it's .*\| unmet checks: 1 \| set 2026-01-01 09:00 UTC/);
    assert.match(r.stdout, /start the new session without the goal:\n {2}claude "Citește .*HANDOFF\.md și urmează instrucțiunile din el\."\nstart the new session WITH the goal \(the last line printed\):\n {2}claude '\/goal fix it/);
    const last = r.stdout.trimEnd().split("\n").at(-1).trim();
    const shell = spawnSync("sh", ["-c", `claude() { printf '%s' "$1"; }\n${last}`], { encoding: "utf8" });   // the shell gives the prompt back whole, whatever quotes the condition holds
    assert.equal(shell.stdout, `/goal ${hostile} (Continuare dintr-un handoff: citește mai întâi ${join(out, "HANDOFF.md")} și urmează instrucțiunile din el; goal-ul de mai sus rămâne neschimbat.)`);
    const head = intro(readFileSync(join(out, "HANDOFF.md"), "utf8"));
    const at = (heading) => head.indexOf(heading);
    assert.ok(at("## Ce faci după ce l-ai citit") < at("## Goal activ (/goal)") && at("## Goal activ (/goal)") < at("## Reguli"), "the section sits between the answer and the rules");
    for (const part of ["> fix it's \"all\" $HOME `id` {x}; then --- done <cale de handoff>", "> two findings are still open", "verificări care au găsit condiția neîndeplinită: 1", "al cincilea punct"]) assert.ok(head.includes(part), part);
    assert.equal(/\/(?:private\/)?tmp\/handoff-/.test(head), false, "no absolute /tmp/handoff-... in the introduction, not even the one in the condition");
    for (const [name, extra, flags] of [["achieved", [set, check, achieved], []], ["cleared", [set, cleared], []], ["off", [set, check], ["--no-goal"]]]) {
      const o = join(root, `handoff-6666abcd-20260101-${name}`);
      const rr = py([write(join(root, `g-${name}.jsonl`), insert(extra)), o, ...flags]);
      assert.equal(rr.status, 0, rr.stderr + rr.stdout);
      assert.equal(/active goal:|WITH the goal|## Goal activ/.test(rr.stdout + readFileSync(join(o, "HANDOFF.md"), "utf8")), false, name);
      assert.match(rr.stdout, /start the new session with:\n {2}claude "Citește .*HANDOFF\.md și urmează instrucțiunile din el\."\s*$/, name);
    }
    const cutFile = join(root, "goal-cut.md");
    const rc = py([write(join(root, "g-cut.jsonl"), insert([set, check])), cutFile, "--cut"]);
    assert.equal(rc.status, 0, rc.stderr + rc.stdout);
    assert.ok(intro(readFileSync(cutFile, "utf8")).includes("## Goal activ (/goal)") && rc.stdout.trimEnd().split("\n").at(-1).includes("claude '/goal fix it"), "--cut carries the goal too");
    const huge = goalRec(1, { type: "goal_status", met: false, sentinel: true, condition: "w".repeat(3990) });
    const rh = py([write(join(root, "g-huge.jsonl"), insert([huge])), join(root, "handoff-6666abcd-20260101-huge")]);
    assert.equal(rh.status, 0, rh.stderr + rh.stdout);
    assert.match(rh.stdout, /longer than 4000 characters/);
    assert.match(rh.stdout, /start the new session with:\n {2}claude "Citește .*HANDOFF\.md și urmează instrucțiunile din el\."\s*$/);
    assert.ok(intro(readFileSync(join(root, "handoff-6666abcd-20260101-huge", "HANDOFF.md"), "utf8")).includes("## Goal activ (/goal)"), "the section is there even when the command cannot hold the goal");
  });

  it("asks the new session to load again the skills this one loaded: a section in the introduction and a `skills to reload:` line; the skill text stays a blob; compact-handoff, an odd name and --no-skills change what they should", () => {
    const sid = "77777777-7777-4777-8777-777777777777";
    const P = "Base directory for this skill: ";
    const calls = [["Skill", { skill: "demo:one" }, "Launching skill: demo:one"], ["Skill", { skill: "plain-two", args: "do it" }, "Launching skill: plain-two"],
      ["Skill", { skill: "apana:compact-handoff" }, "Launching skill: apana:compact-handoff"], ["Skill", { skill: "bad\n## Reguli" }, "Launching skill: bad"]];
    const metaRec = (n, extra, text) => ({ ...base, sessionId: sid, type: "user", isMeta: true, uuid: uid(900 + n), timestamp: `2026-01-01T09:30:${String(n).padStart(2, "0")}.000Z`, ...extra, message: { role: "user", content: [{ type: "text", text }] } });
    const withSkills = () => {
      const rs = transcript(sid, calls);   // the tool results of the 4 calls are records 2, 4, 6 and 8
      const body = (name) => `${P}/p/skills/${name}\n\n# ${name}\n${"BODY-OF-SKILL ".repeat(60)}`;
      const slash = { ...base, sessionId: sid, type: "user", uuid: uid(950), timestamp: "2026-01-01T09:31:00.000Z", message: { role: "user", content: "<command-message>x</command-message>\n<command-name>/slash-three</command-name>\n<command-args>go</command-args>" } };
      const adds = [[8, metaRec(4, { sourceToolUseID: "toolu_77774" }, body("bad"))], [6, metaRec(3, { sourceToolUseID: "toolu_77773" }, body("compact-handoff"))], [4, metaRec(2, { sourceToolUseID: "toolu_77772" }, body("plain-two"))],
        [2, metaRec(1, { sourceToolUseID: "toolu_77771" }, body("one"))]];
      for (const [at, r] of adds) rs.splice(at + 1, 0, r);
      rs.splice(rs.length - 1, 0, slash, metaRec(5, { parentUuid: slash.uuid }, body("slash-three")));
      return rs;
    };
    const out = join(root, "handoff-7777abcd-20260101-skills");
    const r = py([write(join(root, "sk1.jsonl"), withSkills()), out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    assert.match(r.stdout, /skills to reload: demo:one, plain-two, slash-three \| \d+ characters of skill text \(--no-skills leaves them out\)/);
    const text = readFileSync(join(out, "HANDOFF.md"), "utf8"), head = intro(text), at = (heading) => head.indexOf(heading);
    assert.ok(at("## Cum citești fișierul") < at("## Skill-uri de încărcat din nou") && at("## Skill-uri de încărcat din nou") < at("## Ce faci după ce l-ai citit"), "the section sits before the answer");
    assert.ok(head.includes("în ordinea încărcării: `demo:one`, `plain-two`, `slash-three`. ") && head.includes("cu unealta `Skill`") && head.includes("fără `args`"));
    assert.equal(head.includes("compact-handoff") || head.includes("bad"), false, "neither the skill that makes the handoff nor an odd name is listed");
    assert.equal(head.split("\n").filter((l) => l.startsWith("## ")).length, 5, "no heading came from a name");
    assert.equal(text.includes("BODY-OF-SKILL BODY-OF-SKILL"), false, "the text of a skill is still a blob, not part of the handoff");
    for (const [name, flags] of [["off", ["--no-skills"]], ["none", []]]) {
      const o = join(root, `handoff-7777abcd-20260101-${name}`);
      const rr = py([write(join(root, `sk-${name}.jsonl`), name === "none" ? transcript(sid) : withSkills()), o, ...flags]);
      assert.equal(rr.status, 0, rr.stderr + rr.stdout);
      assert.equal(/skills to reload:|## Skill-uri de încărcat/.test(rr.stdout + readFileSync(join(o, "HANDOFF.md"), "utf8")), false, name);
    }
    const cutFile = join(root, "skills-cut.md");
    const rc = py([write(join(root, "sk-cut.jsonl"), withSkills()), cutFile, "--cut"]);
    assert.equal(rc.status, 0, rc.stderr + rc.stdout);
    assert.ok(intro(readFileSync(cutFile, "utf8")).includes("`demo:one`, `plain-two`, `slash-three`"), "--cut lists them too");
    const one = py([write(join(root, "sk-one.jsonl"), (() => { const rs = transcript(sid, calls.slice(0, 1)); rs.splice(3, 0, metaRec(1, { sourceToolUseID: "toolu_77771" }, `${P}/p/skills/one\n\n# one`)); return rs; })()), join(root, "handoff-7777abcd-20260101-one")]);
    assert.equal(one.status, 0, one.stderr + one.stdout);
    assert.ok(intro(readFileSync(join(root, "handoff-7777abcd-20260101-one", "HANDOFF.md"), "utf8")).includes("Sesiunea sursă a încărcat skill-ul `demo:one`."), "one skill: the singular wording");
  });

  it("keeps a message that the user typed while the model was working (an `attachment` queued_command, origin human, mode prompt, a text) as a [user] record at its place; the other 15 combinations of those four conditions, a blank text and a missing origin leave it out", () => {
    const sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const records = transcript(sid);
    const ok = (n, bits, extra = {}) => ({ ...base, sessionId: sid, type: "attachment", uuid: uid(800 + n), parentUuid: records[records.length - 2].uuid, timestamp: `2026-01-01T10:30:${String(n).padStart(2, "0")}.000Z`,
      attachment: { type: "queued_command", prompt: `typed while you worked QUEUED-${bits}`, origin: { kind: "human" }, commandMode: "prompt", humanTurn: true, source_uuid: uid(700 + n), delivery_id: uid(600 + n), ...extra } });
    const atts = [];
    for (let n = 0; n < 16; n++) {   // t = 4, exhaustive: the four conditions are independent checks, 16 records are cheap (INFERENCE)
      const [a, b, c, d] = [8, 4, 2, 1].map((m) => (n & m) !== 0), bits = [a, b, c, d].map(Number).join("");
      atts.push(ok(n, bits, { type: a ? "queued_command" : "hook_success", origin: { kind: b ? "human" : "peer" }, commandMode: c ? "prompt" : "task-notification", ...(d ? {} : { prompt: [{ type: "text", text: `typed while you worked QUEUED-${bits}` }] }) }));
    }
    atts.push(ok(16, "blank", { prompt: "   " }), ok(17, "empty", { prompt: "" }), ok(18, "noorigin", { origin: undefined }));
    records.splice(records.length - 1, 0, ...atts);
    const session = write(join(root, "s-queued.jsonl"), records), out = join(root, "handoff-aaaaeeee-20260107-queued");
    const r = py([session, out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    const t = readFileSync(join(out, "HANDOFF.md"), "utf8");
    for (let n = 0; n < 16; n++) {
      const bits = [8, 4, 2, 1].map((m) => Number((n & m) !== 0)).join("");
      assert.equal(t.includes(`QUEUED-${bits}`), bits === "1111", `QUEUED-${bits}`);
    }
    assert.equal(t.includes("QUEUED-noorigin") || t.includes("QUEUED-blank") || t.includes("QUEUED-empty"), false, "a missing origin does not count as human; a blank text is no message");
    assert.match(t, /^\[\S+ user\] typed while you worked QUEUED-1111$/m, "a [user] record, whole");
    assert.equal(/^\[\S+ user\]\s*$/m.test(t), false, "no empty record");
    assert.ok(t.indexOf("Done: there are three files") < t.indexOf("QUEUED-1111") && t.indexOf("QUEUED-1111") < t.indexOf("ok go on"), "at its place in the stream");
    const cutOut = join(root, "cut", "queued.md");
    assert.equal(py([session, cutOut, "--cut"]).status, 0);
    assert.ok(readFileSync(cutOut, "utf8").includes("typed while you worked QUEUED-1111"), "--cut keeps it too");
  });

  it("--cut writes one file whose cuts are true prefixes and keeps the messages", () => {
    const r = py([join(root, "s1.jsonl"), join(root, "cut", "x.md"), "--cut"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /check PASSED/);
    const cut = readFileSync(join(root, "cut", "x.md"), "utf8");
    assert.ok(cut.includes("caractere omise") && cut.includes("ok go on") && !cut.includes(longEdit));
  });

  it("--marker prints a unique marker and --current finds exactly the transcript that contains it", () => {
    const m = py(["--marker"]); assert.equal(m.status, 0);
    const marker = m.stdout.trim(); assert.match(marker, /^handoff-marker-\d+-[0-9a-f]{12}$/);
    const sid = "33333333-3333-4333-8333-333333333333";
    write(join(home, ".claude", "projects", "p", `${sid}.jsonl`), transcript(sid, [["Bash", { command: `python3 make_context.py --current "${marker}"` }, "ok"]]));
    write(join(home, ".claude", "projects", "p", "44444444-4444-4444-8444-444444444444.jsonl"), transcript("44444444-4444-4444-8444-444444444444"));
    const r = py(["--current", marker, join(root, "handoff-89abcdef-20260103-current")], { HOME: home });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`current session: ${sid}`));
    const none = py(["--current", "handoff-marker-0-000000000000", join(root, "x")], { HOME: home });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /0 transcripts contain the marker/);
  });
});

describe("make_context.py on an invented OpenCode session", () => {
  const db = join(root, "oc", "one.sqlite");
  const folder = join(root, "oc", "handoff-01234567-20260101-test");
  let text, blobs;

  it("--opencode DB OUT writes HANDOFF.md and blobs/ with the messages whole, the reasoning left out, the image and the recent text in blobs, and a passed check", () => {
    ocDb(db, { [ocSid]: null });
    const r = py(["--opencode", db, folder]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /roundtrip IDENTICAL/);
    assert.match(r.stdout, /sanitized records: \d+ of \d+/);
    assert.match(r.stdout, /start the new session with:\n {2}opencode --prompt "Citește .*HANDOFF\.md și urmează instrucțiunile din el\."/);
    text = readFileSync(join(folder, "HANDOFF.md"), "utf8");
    blobs = readdirSync(join(folder, "blobs")).map((f) => readFileSync(join(folder, "blobs", f), "utf8"));
    for (const part of ["Fă un plan pentru fișierul „raport” – cu diacritice: ăâîșț, 日本語 și emoji 🙂.", "I will look at the files first.", "Final answer text.", "[opencode compaction summary] COMPACTION SUMMARY", "[tool_result ERROR] tool.execution: patch verification failed: no lines", "(exit 1, truncated)"]) assert.ok(text.includes(part), part);
    assert.equal(text.includes("REASONING SECRET") || blobs.some((b) => b.includes("REASONING SECRET") || b.includes("ENCRYPTEDBLOB")), false, "reasoning and its encrypted content are not included");
    assert.equal(text.includes("iVBORw0KGgo") || text.includes("data:image"), false, "no image data in HANDOFF.md");
    assert.ok(blobs.some((b) => b.includes("uri: data:image/png;base64,iVBORw0KGgoaB3dE5fG7hJ9kL1m") && b.includes("name: shots/one.png")), "the image is whole in a blob, not sanitized");
    assert.ok(blobs.some((b) => b.includes("[opencode compaction recent]") && b.includes("RECENT TEXT")) && !text.includes("RECENT TEXT"), "the recent text is in a blob");
    assert.equal(/abcd1234efgh5678/.test(text + blobs.join("")), false, "a secret in a text output is redacted");
  });

  it("puts every instruction in an introduction that a reader that is not Claude Code can follow, with a reading plan that covers the file", () => {
    const head = intro(text);
    for (const part of ["Sesiunea sursă: sesiune OpenCode `ses_0123456789abcdefAAAAAA`", "`Read` în Claude Code, `read` în OpenCode", "poate fi refuzată sau trunchiată", "Raționamentul modelului (text și conținut criptat) nu este inclus", "textele `recent` ale compactărilor", "imaginile sunt în `blobs/Rnnnn.txt`, ca date base64, nu text, și nu sunt verificate pentru secrete", "maximum 8 rânduri", "Nu repeta nimic din ele"]) assert.ok(head.includes(part), part);
    assert.equal(head.includes("unealta Read") || /\/(?:private\/)?tmp\/handoff-|\/Users\//.test(head), false, "no tool of Claude Code only, no absolute path");
    const lines = text.split("\n").length;
    const plan = /`offset:limit`: ([0-9:, ]+)\./.exec(head)[1].split(", ").map((c) => c.split(":").map(Number));
    let next = 1;
    for (const [offset, limit] of plan) { assert.equal(offset, next); next += limit; }
    assert.equal(next, lines + 1, "the plan covers every line");
  });

  it("refuses several sessions without --session, picks one with it, refuses an unknown id, a legacy-only file, --cut and --with-subagents", () => {
    const two = ocDb(join(root, "oc", "two.sqlite"), { ses_aaaaaaaaaaaaAAAAAAAA: [["user", { text: "first session" }, 5]], ses_bbbbbbbbbbbbBBBBBBBB: [["user", { text: "second session" }, 5]] });
    const refused = py(["--opencode", two, join(root, "oc", "x1")]);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /pick one with --session ID \(newest first\):\nses_bbbbbbbbbbbbBBBBBBBB \| .*\nses_aaaaaaaaaaaaAAAAAAAA \| .*\nshown 2 of 2 sessions\n?$/);   // the newest first, one line each (the later time_created first)
    const out = join(root, "oc", "x2"), picked = py(["--opencode", two, out, "--session", "ses_bbbbbbbbbbbbBBBBBBBB"]);
    assert.equal(picked.status, 0, picked.stderr); assert.ok(readFileSync(join(out, "HANDOFF.md"), "utf8").includes("second session"));
    assert.match(py(["--opencode", two, join(root, "oc", "x3"), "--session", "ses_zzz"]).stderr, /no such session/);
    for (const flag of ["--cut", "--with-subagents"]) assert.match(py(["--opencode", db, join(root, "oc", "x4"), flag]).stderr, /not supported/);
    const legacy = join(root, "oc", "legacy.sqlite");
    const r = spawnSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table session(id text)'); c.execute('create table message(id text)'); c.execute('create table part(id text)'); c.execute(\"insert into session values ('ses_old1')\"); c.commit()", legacy], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(py(["--opencode", legacy, join(root, "oc", "x5")]).stderr, /legacy OpenCode sessions are not supported/);
  });

  it("--current finds the OpenCode session that holds the marker (default database under XDG_DATA_HOME), and refuses for none, for two, and for one OpenCode plus one Claude Code session", () => {
    const marker = py(["--marker"]).stdout.trim();
    const withMarker = (id) => [id, [["user", { text: "please make a handoff" }, 5], ["assistant", { content: [{ type: "tool", name: "shell", state: { status: "completed", input: { command: `python3 make_context.py --current "${marker}"` }, content: [{ type: "text", text: "ok" }] } }] }, 3]]];
    const xdgOne = join(root, "xdg-one"), env = (x) => ({ HOME: join(root, "home-oc"), XDG_DATA_HOME: x });
    mkdirSync(join(root, "home-oc"), { recursive: true });
    ocDb(join(xdgOne, "opencode", "opencode.db"), Object.fromEntries([withMarker("ses_feedfeedfeedAAAAAAAA"), ["ses_quietquietquiet01", [["user", { text: "nothing" }, 3]]]]));
    const found = py(["--current", marker, join(root, "oc", "cur1")], env(xdgOne));
    assert.equal(found.status, 0, found.stderr + found.stdout);
    assert.match(found.stdout, /current session: ses_feedfeedfeedAAAAAAAA/); assert.match(found.stdout, /roundtrip IDENTICAL/); assert.match(found.stdout, /opencode --prompt "Citește/);
    const none = py(["--current", "handoff-marker-0-000000000000", join(root, "oc", "cur2")], env(xdgOne));
    assert.notEqual(none.status, 0); assert.match(none.stderr, /0 transcripts contain the marker/);
    const xdgTwo = join(root, "xdg-two");
    ocDb(join(xdgTwo, "opencode", "opencode.db"), Object.fromEntries([withMarker("ses_twotwotwotwo0000001"), withMarker("ses_twotwotwotwo0000002")]));
    const two = py(["--current", marker, join(root, "oc", "cur3")], env(xdgTwo));
    assert.notEqual(two.status, 0); assert.match(two.stderr, /2 sessions contain the marker.*0 Claude Code transcripts, 2 OpenCode sessions/);
    const sid = "77777777-7777-4777-8777-777777777777";
    write(join(root, "home-oc", ".claude", "projects", "p", `${sid}.jsonl`), transcript(sid, [["Bash", { command: `python3 make_context.py --current "${marker}"` }, "ok"]]));
    const mixed = py(["--current", marker, join(root, "oc", "cur4")], env(xdgOne));
    assert.notEqual(mixed.status, 0); assert.match(mixed.stderr, /2 sessions contain the marker.*1 Claude Code transcripts, 1 OpenCode sessions/);
    const skipped = py(["--current", marker, join(root, "oc", "cur5"), "--no-opencode"], env(xdgOne));   // the Claude Code transcript alone decides
    assert.equal(skipped.status, 0, skipped.stderr + skipped.stdout); assert.match(skipped.stdout, new RegExp(`current session: ${sid}`)); assert.match(skipped.stdout, /claude "Citește/);
  });

  it("an OpenCode database that exists but cannot be read stops --current with an error that names the cause and --no-opencode; a missing database is skipped", () => {
    const marker = py(["--marker"]).stdout.trim();
    const xdgBad = join(root, "xdg-bad"); mkdirSync(join(xdgBad, "opencode"), { recursive: true });
    writeFileSync(join(xdgBad, "opencode", "opencode.db"), "this is not a database\n".repeat(200));
    const env = { HOME: join(root, "home-oc"), XDG_DATA_HOME: xdgBad };
    const bad = py(["--current", marker, join(root, "oc", "cur6")], env);
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /cannot be read/); assert.match(bad.stderr, /--no-opencode/); assert.match(bad.stderr, /Report this to the user/);
    const skipped = py(["--current", "handoff-marker-0-000000000000", join(root, "oc", "cur7"), "--no-opencode"], env);
    assert.notEqual(skipped.status, 0); assert.match(skipped.stderr, /0 transcripts contain the marker/); assert.equal(/cannot be read/.test(skipped.stderr), false);
    const missing = py(["--current", "handoff-marker-0-000000000000", join(root, "oc", "cur8")], { HOME: join(root, "home-oc"), XDG_DATA_HOME: join(root, "xdg-nothing") });
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /0 transcripts contain the marker/);
  });
});
