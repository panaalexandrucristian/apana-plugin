// Tests of opencode-shell-guard on throw-away config folders (never the real OpenCode config): the rules, the OpenCode plugin
// that applies them, shell-guard.mjs that sets it up, and the skill package. Node stdlib.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RULES, decide, evaluate, match, refusal } from "../rules.mjs";
import { JsoncError, NOTE, ownRules, parseJsonc, pluginSource, run, withNote } from "../shell-guard.mjs";

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(SKILL, "scripts", "shell-guard.mjs");
const PLUGIN = join(SKILL, "plugin");
const BASH = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find((path) => existsSync(path));
/** A Bun on PATH, as OpenCode 2.4.2 runs in: bun, or the opencode binary, which is Bun with BUN_BE_BUN=1. Told apart by Bun's revision (1.4.4+38afee6c8). */
const bunOf = (command, env) => /^\d+\.\d+\.\d+\+[0-9a-f]+$/.test(spawnSync(command, ["--revision"], { encoding: "utf8", env, timeout: 10_000 }).stdout?.trim() ?? "")
  && { name: `Bun through ${command}`, command, env };
const RUNTIMES = [{ name: "Node", command: process.execPath, env: process.env },
  bunOf("bun", process.env) || bunOf("opencode", { ...process.env, BUN_BE_BUN: "1" }) || { name: "Bun", skip: "no Bun on PATH: neither bun nor opencode" }];
const temporaries = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-guard-"));
  temporaries.push(dir);
  return dir;
};
after(() => temporaries.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const write = (dir, text, name = "opencode.jsonc") => (mkdirSync(dir, { recursive: true }), writeFileSync(join(dir, name), text), join(dir, name));
/** The config as plain objects: parseJsonc builds them without a prototype, which deepStrictEqual tells apart. */
const load = (file) => JSON.parse(JSON.stringify(parseJsonc(readFileSync(file, "utf8")).value));
const backups = (dir) => readdirSync(dir).filter((name) => name.includes(".bak-shell-guard-"));
const guard = (dir, ...flags) => run(["--config-dir", dir, "--shell", BASH, ...flags]);
const linkOf = (dir) => join(dir, "plugins", "opencode-shell-guard");
const OWN = { action: "shell", resource: "rm *", effect: "ask" };

describe("the rules", () => {
  it("deny grep in every form tried live in OpenCode and allow the commands that only carry its text", () => {
    const denied = ["grep -n x f", "egrep x f", "fgrep x f", "/usr/bin/grep x f", "command grep x f", "env grep x f", "timeout 5 grep x f",
      "xargs grep -c x", "find . -exec grep -c x {} ;", "bash -c 'echo hi | grep -c hi'", "bash -c 'echo hi|grep hi'", "sh -c \"grep -c x f\"", "bash -c '\ngrep -c x f'",
      "grep"];
    const allowed = ["git grep -c x", "git log --grep x", "git -C /repo grep -c x", "pgrep -x node", "rg 'grep -' AGENTS.md", 'echo "nu folosi grep aici"',
      "cat <<'EOF'\ngrep -c x f\nEOF", "printf 'grep x\\n'", "python3 -c \"print('grep x')\"", "node -e \"console.log('grep x')\"", "sed 's/grep /rg /'",
      "perl -e 'print \"grep x\"'", "gh help 'grep x'", "ls", "npm test"];
    for (const command of denied) assert.equal(decide(RULES, command), "deny", command);
    for (const command of allowed) assert.equal(decide(RULES, command), "allow", command);
  });

  it("put the deny first, so each allow after it can lift it", () => {
    assert.deepEqual(RULES[0], { action: "shell", resource: "*grep *", effect: "deny" });
    assert.ok(RULES.slice(1).every((rule) => rule.action === "shell" && rule.effect === "allow"));
    assert.equal(RULES.length, 13);
  });

  it("match as OpenCode's Wildcard.match: a trailing ` *` also matches nothing, regex characters are literal, `*` crosses lines", () => {
    assert.ok(match("rg", "rg *") && match("rg x", "rg *") && !match("rgx", "rg *"));
    assert.ok(match("a.b", "a.b") && !match("axb", "a.b") && match("a(b", "a(b") && match("ab", "a?"));
    assert.ok(match("cat <<'EOF'\ngrep x\nEOF", "cat *"));
    assert.equal(decide([{ action: "*", resource: "*", effect: "ask" }, null, { action: "shell" }], "x"), "ask", "the last valid matching rule wins");
    assert.equal(decide([], "grep x"), "allow");
  });

  it("ownRules drops the 13 rules earlier versions wrote and keeps the user's own in their order", () => {
    const own = [OWN, { ...RULES[3] }, { action: "edit", resource: "*.env", effect: "deny" }, { ...RULES[0], effect: "ask" }];
    assert.deepEqual(ownRules([...RULES, ...own]), [own[0], own[2], own[3]]);
    assert.deepEqual(ownRules(), []);
  });
});

describe("the plugin", () => {
  const event = (resources, extra = {}) => ({ sessionID: "s", action: "shell", resources, effect: "allow", ...extra });

  it("refuses a shell request with one grep part and says why and to use rg", () => {
    const e = event(["echo hi", "grep hi"]);
    evaluate(e);
    assert.equal(e.effect, "deny");
    assert.equal(e.message, refusal("grep hi"));
    assert.match(e.message, /^opencode-shell-guard refused `grep hi`: grep is not allowed in shell commands here/);
    for (const cue of ["`rg`", "`... | rg pattern`", "`git grep`", "do not retry it or ask the user", "`grep -E 'a|b' f` is `rg 'a|b' f`"]) assert.ok(e.message.includes(cue), cue);
  });

  it("refuses also where the session's own rules allowed it, and shortens a long command in the message", () => {
    const long = `grep ${"x".repeat(300)}`;
    const e = event([long], { effect: "allow" });
    evaluate(e);
    assert.equal(e.effect, "deny");
    assert.ok(e.message.includes(`\`${long.slice(0, 117)}...\``) && !e.message.includes(long));
    const asked = event(["grep x"], { effect: "ask" });
    evaluate(asked);
    assert.equal(asked.effect, "deny");
  });

  it("decides the commands met live in OpenCode 2.4.2 as they reached the plugin; a pgrep inside another command only lifts a refusal", () => {
    const refusedOf = (resources) => {
      const e = event(resources);
      evaluate(e);
      return e.effect === "deny" ? e.message : undefined;
    };
    const sqlite = `sqlite3 -readonly opencode.db "select count(*), sum(json_extract(data,'$.input.command') like '%grep %'), sum(json_extract(data,'$.input.command') like '%rg %') from session_part where session_id='$S' and time_created>$T and type='tool' and json_extract(data,'$.input.command') is not null"`;
    const denied = [[["echo hi", "grep hi"], "grep hi"], [["bash -c 'echo hi | grep -c hi'"]], [[sqlite]],
      [["bash -c 'pgrep -x node | grep -c x'"]], [["ps -p $(pgrep -x node) $(grep -l x f)"]]];
    for (const [resources, part = resources[0]] of denied) assert.equal(refusedOf(resources), refusal(part), part);
    const allowed = [["ps -o pid,lstart,command -p $(pgrep -d, -f 'opencode') 2>/dev/null"], ["echo hi", "rg hi"], ["pgrep -x opencode >/dev/null", 'echo "pgrep ok"'],
      ["git grep -c realpathSync -- skills/opencode-shell-guard/plugin"], ['echo "nu folosi grep aici"'], ["kill $(pgrep -f 'opencode serve')"], ["pgrep -f 'grep -c x'"]];
    for (const resources of allowed) assert.equal(refusedOf(resources), undefined, resources.join(" | "));
  });

  it("refuses direct and delegated find invocations and gives an fd example", () => {
    const commands = [
      ["find"], ["/usr/bin/find ."], ["LABEL='x y' '/usr/bin/find' ."], ['2>"error log" find .'],
      ["printf x", "find ."], ["command find ."], ["command -- find ."], ["env find ."], ["env LABEL=x find ."],
      ["timeout 5 find ."], ["printf '.\\n'", "xargs find"], ["bash -c 'find .'"], ["bash -c 'printf x | find .'"],
      [`sh -c 'find . -type f -name "*.kt"'`], ["env -u LABEL timeout -k 1s 5s /usr/bin/find ."],
      ["xargs -0 -I{} /usr/bin/find {}"], [`bash -lc 'printf "%s\\n" x && command find .'`],
    ];
    for (const resources of commands) {
      const e = event(resources);
      evaluate(e);
      assert.equal(e.effect, "deny", resources.join(" | "));
      assert.ok(e.message.startsWith(`opencode-shell-guard refused \`${resources.at(-1)}\`: find is not allowed`), e.message);
      assert.ok(e.message.includes("`fd -HI -s -t f -g '*.kt' .`"), e.message);
    }
  });

  it("allows find as an argument, an option operand, a redirect target or literal script text", () => {
    const allowed = [
      "fd -HI -s -t f -g '*.kt' .", 'echo "find ."', `bash -c 'echo "find ."'`, "sh -c 'printf %s find'",
      "cat ./find", ">find printf ok", "command -v find", "env LABEL=find printf ok", "env -u find printf ok",
      "timeout 5 echo find", "xargs echo find", "xargs -I find printf ok",
      'bash -c \'echo "; find ."; printf "%s" find\'', "bash -c '# find .\n echo ok'", "cat <<'EOF'\nfind .\nEOF",
      'printf x "2>file" find', 'bash -c \'echo "$1"\' -- find',
    ];
    for (const command of allowed) {
      const e = event([command]);
      evaluate(e);
      assert.equal(e.effect, "allow", command);
      assert.equal(e.message, undefined, command);
    }
  });

  it("explains both rules for a mixed resource, chooses the first denied resource, and preserves existing denials", () => {
    const mixed = event(["find . -exec grep -c x {} \\;"]);
    evaluate(mixed);
    assert.equal(mixed.effect, "deny");
    assert.match(mixed.message, /find is not allowed.*`fd`.*grep is not allowed.*`rg`/s);
    assert.doesNotMatch(mixed.message, /fd[^`]*-exec/);

    for (const resources of [["find .", "grep x f"], ["grep x f", "find ."]]) {
      const e = event(resources);
      evaluate(e);
      assert.equal(e.effect, "deny");
      assert.ok(e.message.startsWith(`opencode-shell-guard refused \`${resources[0]}\``), e.message);
      assert.ok(e.message.includes(`${resources[0].split(" ")[0]} is not allowed`), e.message);
    }
    const refused = event(["find ."], { effect: "deny", message: "theirs" });
    const before = structuredClone(refused);
    evaluate(refused);
    assert.deepEqual(refused, before);
  });

  it("leaves alone other commands, other permissions, a request already refused and a malformed event", () => {
    for (const e of [event(["rg x", "git grep y", "echo 'grep z'"]), event(["grep x"], { action: "edit" }), event(["grep x"], { effect: "deny", message: "theirs" }), event("grep x"), event([42])]) {
      const before = JSON.stringify(e);
      evaluate(e);
      assert.equal(JSON.stringify(e), before);
    }
    evaluate(undefined);
  });

  it("registers the hook through ctx.permission.hook, disposes it, and fails quietly without the capability", async () => {
    const { default: plugin } = await import(pathToFileURL(join(PLUGIN, "server.js")).href);
    assert.equal(plugin.id, "opencode-shell-guard");
    const calls = [];
    const ctx = { permission: { hook: async (name, callback) => (calls.push([name, callback]), { dispose: async () => calls.push(["dispose"]) }) } };
    const dispose = await plugin.setup(ctx);
    assert.equal(calls[0][0], "evaluate");
    const e = event(["grep x"]);
    await calls[0][1](e);
    assert.equal(e.effect, "deny");
    await dispose();
    assert.deepEqual(calls.at(-1), ["dispose"]);
    const warn = console.warn;
    const warned = [];
    console.warn = (message) => warned.push(message);
    try {
      assert.equal(await plugin.setup({}), undefined);
    } finally {
      console.warn = warn;
    }
    assert.match(warned[0], /^\[opencode-shell-guard\] .*grep and find are not refused/);
  });

  it("registers the hook when loaded through the link with the link's path in import.meta.url, as OpenCode 2.4.2 loads it", () => {
    const link = linkOf(temp());
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(PLUGIN, link);
    // --preserve-symlinks keeps the link's path in import.meta.url, as OpenCode's loader did; plain node resolves it to the real path.
    const probe = `const { default: plugin } = await import(${JSON.stringify(pathToFileURL(join(link, "server.js")).href)});
      const names = []; console.warn = (message) => names.push("warn: " + message);
      await plugin.setup({ permission: { hook: async (name) => (names.push(name), { dispose() {} }) } });
      console.log(JSON.stringify(names));`;
    const ran = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", probe], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), ["evaluate"]);
  });

  // OpenCode 2.4.2 runs in Bun, whose module cache is not Node's: a `?v=` query in the URL brought back the old module in Bun and a new
  // one in Node. So the reload runs under Bun too when one is on PATH.
  for (const runtime of RUNTIMES) {
    it(`takes changed rules at the next setup, as OpenCode reloads the plugin without dropping the modules it imported (${runtime.name})`, { skip: runtime.skip }, () => {
      const copy = join(temp(), "opencode-shell-guard");
      cpSync(PLUGIN, join(copy, "plugin"), { recursive: true });
      cpSync(join(SKILL, "scripts", "rules.mjs"), join(copy, "scripts", "rules.mjs"));
      const rules = JSON.stringify(join(copy, "scripts", "rules.mjs"));
      const probe = join(copy, "probe.mjs");
      writeFileSync(probe, `import { readFileSync, writeFileSync } from "node:fs";
        const { default: plugin } = await import(${JSON.stringify(pathToFileURL(join(copy, "plugin", "server.js")).href)});
        const messageAfterSetup = async () => {
          let hook;
          await plugin.setup({ permission: { hook: async (name, callback) => ((hook = callback), { dispose() {} }) } });
          const e = ${JSON.stringify(event(["grep x"]))};
          hook(e);
          return e.message;
        };
        const first = await messageAfterSetup();
        writeFileSync(${rules}, readFileSync(${rules}, "utf8").replace("opencode-shell-guard refused ", "opencode-shell-guard v2 refused "));
        console.log(JSON.stringify([first, await messageAfterSetup()]));`);
      const ran = spawnSync(runtime.command, [probe], { encoding: "utf8", env: runtime.env });
      assert.equal(ran.status, 0, ran.stderr);
      const [first, second] = JSON.parse(ran.stdout);
      assert.match(first, /^opencode-shell-guard refused /);
      assert.match(second, /^opencode-shell-guard v2 refused /);
    });
  }
});

describe("the AGENTS.md note", () => {
  it("names rg, every command an allow rule starts with, and how the refusal starts", () => {
    assert.ok(NOTE.startsWith("<!-- opencode-shell-guard -->\n") && NOTE.endsWith("\n<!-- /opencode-shell-guard -->"));
    for (const rule of RULES.slice(1)) assert.ok(NOTE.includes(`\`${rule.resource.split(" ")[0]}\``), rule.resource);
    assert.ok(refusal("grep x").startsWith("opencode-shell-guard refused") && NOTE.includes("`opencode-shell-guard refused`"));
    // `rg -E 'a|b'` fails with "unknown encoding: a|b", so a grep -E carried over as it is would be refused a second way.
    assert.ok(NOTE.includes("`-E` is the encoding, not extended regex: `grep -E 'a|b' f` is `rg 'a|b' f`"));
  });

  it("is added after a blank line, replaced in place, and left alone when current", () => {
    assert.equal(withNote(""), `${NOTE}\n`);
    assert.equal(withNote("- a"), `- a\n\n${NOTE}\n`);
    assert.equal(withNote("- a\n"), `- a\n\n${NOTE}\n`);
    assert.equal(withNote("- a\n\n"), `- a\n\n${NOTE}\n`);
    const old = "<!-- opencode-shell-guard -->\nold text\n<!-- /opencode-shell-guard -->";
    assert.equal(withNote(`# Top\n${old}\n- b\n`), `# Top\n${NOTE}\n- b\n`);
    assert.equal(withNote(`- a\n\n${NOTE}\n`), `- a\n\n${NOTE}\n`);
  });

  it("refuses a lone, reversed or doubled marker", () => {
    for (const text of ["<!-- opencode-shell-guard -->\nx", "x\n<!-- /opencode-shell-guard -->", "<!-- /opencode-shell-guard -->\n<!-- opencode-shell-guard -->", `${NOTE}\n${NOTE}`]) {
      assert.throws(() => withNote(text), /are not one pair in this order/, text);
    }
  });
});

describe("parseJsonc", () => {
  it("reads comments, trailing commas and a // inside a string, as OpenCode does", () => {
    const { value } = parseJsonc('// top\n{\n  /* block */ "a": "http://x", // after\n  "b": [1, 2,],\n}\n');
    assert.deepEqual(JSON.parse(JSON.stringify(value)), { a: "http://x", b: [1, 2] });
  });

  it("refuses broken text with its position and a doubled shell or permissions key", () => {
    assert.throws(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}'), (error) => error instanceof JsoncError && /line 3, column 3/.test(error.message));
    assert.throws(() => parseJsonc('{ "shell": "/bin/bash", "shell": "/bin/zsh" }'), /"shell" appears more than once/);
    assert.throws(() => parseJsonc("[]"), /not an object/);
  });
});

describe("pluginSource", () => {
  const home = () => temp();
  const silent = () => {};

  it("is the skill's own plugin folder in a checkout", () => {
    assert.equal(pluginSource(PLUGIN, home(), silent), PLUGIN);
  });

  it("is the marketplace clone's folder for a copy in the plugin cache, which every update replaces, and warns without a clone", () => {
    const h = home();
    const cached = join(h, ".claude", "plugins", "cache", "apana-private", "apana", "0.22.0", "skills", "opencode-shell-guard", "plugin");
    const warnings = [];
    assert.equal(pluginSource(cached, h, (level, message) => warnings.push([level, message])), cached);
    assert.match(warnings[0][1], /the link will break when the plugin is updated/);
    const clone = join(h, ".claude", "plugins", "marketplaces", "apana-private", "skills", "opencode-shell-guard", "plugin");
    write(clone, "export default {};\n", "server.js");
    assert.equal(pluginSource(cached, h, silent), clone);
  });
});

describe("shell-guard.mjs", { skip: !BASH && "no bash on this machine" }, () => {
  it("creates the config folder, the config with mode 0600, AGENTS.md and the plugin link, and changes nothing on a second run", () => {
    const dir = join(temp(), "opencode");
    const first = guard(dir);
    assert.equal(first.code, 0, first.output);
    const file = join(dir, "opencode.jsonc");
    const config = load(file);
    assert.deepEqual(config, { $schema: "https://opencode.ai/config.json", shell: BASH });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), `${NOTE}\n`);
    assert.equal(readlinkSync(linkOf(dir)), PLUGIN);
    assert.deepEqual(backups(dir), [], "no backup of a file that did not exist");
    const again = guard(dir);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /^ok nothing to change/m);
    assert.deepEqual(backups(dir), []);
  });

  it("removes the 13 rules, keeps the user's own, the comments and the other keys, and backs up the original", () => {
    const dir = temp();
    const original = [
      "// my config",
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "shell": "/bin/zsh", // was zsh',
      '  "skills": ["~/x"],',
      `  "permissions": ${JSON.stringify([...RULES, OWN])},`,
      '  "model": "a/b",',
      "}",
      "",
    ].join("\n");
    const file = write(dir, original);
    const result = guard(dir);
    assert.equal(result.code, 0, result.output);
    const text = readFileSync(file, "utf8");
    assert.ok(text.startsWith("// my config\n{\n"), text);
    assert.ok(text.includes(`"shell": ${JSON.stringify(BASH)}, // was zsh`), text);
    const config = load(file);
    assert.deepEqual(Object.keys(config), ["$schema", "shell", "skills", "permissions", "model"]);
    assert.deepEqual(config.permissions, [OWN]);
    assert.deepEqual(config.skills, ["~/x"]);
    const [backup] = backups(dir).filter((name) => name.startsWith("opencode.jsonc"));
    assert.equal(readFileSync(join(dir, backup), "utf8"), original);
    assert.match(result.output, /"shell": "\/bin\/zsh" -> /);
    assert.match(result.output, /the 13 grep rule\(s\) are removed, the plugin applies them now; your 1 rule\(s\) stay/);
  });

  it("removes \"permissions\" with its lines when it held only the 13 rules, in the middle, last, alone, and after a comment", () => {
    const rules = `[\n${RULES.map((rule) => `    ${JSON.stringify(rule)}`).join(",\n")}\n  ]`;
    const cases = [
      [`{\n  "$schema": "s",\n  "shell": "${BASH}",\n  "permissions": ${rules},\n  "skills": ["a"]\n}\n`, `{\n  "$schema": "s",\n  "shell": "${BASH}",\n  "skills": ["a"]\n}\n`],
      [`{\n  "shell": "${BASH}",\n  "permissions": ${rules}\n}\n`, `{\n  "shell": "${BASH}"\n}\n`],
      [`{\n  "shell": "${BASH}", // mine\n  "permissions": ${rules}\n}\n`, `{\n  "shell": "${BASH}" // mine\n}\n`],
      [`{\n  "shell": "${BASH}",\n  "permissions": ${rules},\n}\n`, `{\n  "shell": "${BASH}",\n}\n`],
      [`{ "shell": "${BASH}", "permissions": ${JSON.stringify(RULES)} }\n`, `{ "shell": "${BASH}" }\n`],
      [`{ "permissions": ${JSON.stringify(RULES)}, "shell": "${BASH}" }\n`, `{ "shell": "${BASH}" }\n`],
    ];
    for (const [original, expected] of cases) {
      const dir = temp();
      const file = write(dir, original);
      const result = guard(dir);
      assert.equal(result.code, 0, result.output);
      assert.equal(readFileSync(file, "utf8"), expected);
      assert.match(result.output, /"permissions" is removed: it held only the 13 grep rule\(s\)/);
    }
    const alone = temp();
    write(alone, `{\n  "permissions": ${rules}\n}\n`);
    assert.equal(guard(alone).code, 0);
    assert.deepEqual(load(join(alone, "opencode.jsonc")), { shell: BASH });
  });

  it("adds shell after $schema to a file without it and adds no permissions", () => {
    const dir = temp();
    const file = write(dir, '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "a/b"\n}\n');
    assert.equal(guard(dir).code, 0);
    assert.deepEqual(Object.keys(load(file)), ["$schema", "shell", "model"]);
  });

  it("--dry-run reports and writes nothing, the link neither", () => {
    const dir = temp();
    const original = `{ "permissions": ${JSON.stringify(RULES)} }\n`;
    const file = write(dir, original);
    const result = guard(dir, "--dry-run");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /^info --dry-run: nothing was written$/m);
    assert.match(result.output, /^info \| <!-- opencode-shell-guard -->$/m, "shows the note");
    assert.match(result.output, /opencode-shell-guard -> .*: a new link/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.ok(!existsSync(join(dir, "AGENTS.md")) && !existsSync(join(dir, "plugins")));
    assert.deepEqual(backups(dir), []);
  });

  it("adds the note to an existing AGENTS.md without touching the rest, backs it up, and does nothing the second time", () => {
    const dir = temp();
    write(dir, JSON.stringify({ shell: BASH }));
    const original = "- my own rule\n- another one";
    const agents = write(dir, original, "AGENTS.md");
    const result = guard(dir);
    assert.equal(result.code, 0, result.output);
    assert.equal(readFileSync(agents, "utf8"), `${original}\n\n${NOTE}\n`);
    assert.match(result.output, /the note is added at the end/);
    assert.deepEqual(backups(dir).map((name) => name.split(".bak-")[0]), ["AGENTS.md"], "the config did not change, so only AGENTS.md is backed up");
    assert.equal(readFileSync(join(dir, backups(dir)[0]), "utf8"), original);
    const again = guard(dir);
    assert.match(again.output, /^ok nothing to change/m);
    assert.equal(backups(dir).length, 1);
    assert.equal(run(["--config-dir", dir, "--check"]).code, 0);
  });

  it("replaces an older note in place and keeps the text around it", () => {
    const dir = temp();
    assert.equal(guard(dir).code, 0);
    const config = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    const link = readlinkSync(linkOf(dir));
    const oldNote = "# Rules\n<!-- opencode-shell-guard -->\nuse rg\n<!-- /opencode-shell-guard -->\n- after\n";
    const agents = write(dir, oldNote, "AGENTS.md");
    const stale = guard(dir, "--check");
    assert.equal(stale.code, 1, stale.output);
    assert.match(stale.output, /^warn the note in .* is not the current one$/m);
    const preview = guard(dir, "--dry-run");
    assert.equal(preview.code, 0, preview.output);
    assert.match(preview.output, /^info \| .*\buse `fd`/m);
    assert.equal(readFileSync(agents, "utf8"), oldNote);
    assert.deepEqual(backups(dir), []);
    const result = guard(dir);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /the note is replaced by the current one/);
    assert.equal(readFileSync(agents, "utf8"), `# Rules\n${NOTE}\n- after\n`);
    assert.equal(readFileSync(join(dir, "opencode.jsonc"), "utf8"), config);
    assert.equal(readlinkSync(linkOf(dir)), link);
    assert.equal(guard(dir, "--check").code, 0);
  });

  it("writes through a symlinked AGENTS.md and keeps the link", () => {
    const dir = temp();
    const real = write(join(dir, "dotfiles"), "- mine\n", "AGENTS.md");
    const config = join(dir, "opencode");
    mkdirSync(config);
    symlinkSync(real, join(config, "AGENTS.md"));
    assert.equal(guard(config).code, 0);
    assert.ok(lstatSync(join(config, "AGENTS.md")).isSymbolicLink());
    assert.equal(readFileSync(real, "utf8"), `- mine\n\n${NOTE}\n`);
  });

  it("writes nothing, the config and the link neither, when the markers in AGENTS.md are broken", () => {
    const dir = temp();
    const config = write(dir, '{ "model": "a/b" }\n');
    const original = "- mine\n<!-- opencode-shell-guard -->\n- no end marker\n";
    const agents = write(dir, original, "AGENTS.md");
    const result = guard(dir);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /^fail .*AGENTS\.md: the markers .* are not one pair in this order; nothing was changed$/m);
    assert.equal(readFileSync(agents, "utf8"), original);
    assert.equal(readFileSync(config, "utf8"), '{ "model": "a/b" }\n');
    assert.ok(!existsSync(join(dir, "plugins")));
    assert.deepEqual(backups(dir), []);
    assert.match(run(["--config-dir", dir, "--check"]).output, /^fail .*AGENTS\.md: the markers/m);
  });

  it("--check exits 1 on the setup of earlier versions and 0 once it is written, and writes nothing itself", () => {
    const dir = temp();
    const original = JSON.stringify({ shell: "/bin/zsh", permissions: RULES });
    const file = write(dir, original);
    const before = run(["--config-dir", dir, "--check"]);
    assert.equal(before.code, 1, before.output);
    assert.match(before.output, /^warn "shell" is \/bin\/zsh, not bash$/m);
    assert.match(before.output, /^warn .*opencode-shell-guard is missing, so OpenCode does not refuse grep or find in shell commands$/m);
    assert.match(before.output, /^warn "permissions" still holds 13 of the 13 grep rules/m);
    assert.match(before.output, /^warn "permissions" refuses "grep -n x file", .* itself, before the plugin runs, so the refusal says only `Permission denied: shell`$/m);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.ok(!existsSync(join(dir, "plugins")));
    assert.equal(guard(dir).code, 0);
    const done = run(["--config-dir", dir, "--check"]);
    assert.equal(done.code, 0, done.output);
    assert.ok(done.output.split("\n").filter(Boolean).every((line) => line.startsWith("ok ")), done.output);
  });

  it("keeps a grep rule of the user's own and warns that it refuses before the plugin", () => {
    const dir = temp();
    const mine = { action: "shell", resource: "grep *", effect: "deny" };
    const file = write(dir, JSON.stringify({ shell: BASH, permissions: [mine] }));
    const result = guard(dir);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(load(file).permissions, [mine]);
    assert.match(result.output, /^warn "permissions" refuses "grep -n x file" itself, before the plugin runs/m);
  });

  it("keeps a find rule of the user's own and warns that it refuses before the plugin", () => {
    const dir = temp();
    const mine = { action: "shell", resource: "find *", effect: "deny" };
    const file = write(dir, JSON.stringify({ shell: BASH, permissions: [mine] }));
    const result = guard(dir);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(load(file).permissions, [mine]);
    const check = guard(dir, "--check");
    assert.equal(check.code, 1, check.output);
    assert.match(check.output, /^warn "permissions" refuses "find \. -type f -name '\*\.kt'" itself, before the plugin runs/m);
  });

  it("points a link to another folder at the plugin, and --check warns about it and about a dangling one", () => {
    const dir = temp();
    write(dir, JSON.stringify({ shell: BASH }));
    const elsewhere = join(temp(), "old-plugin");
    write(elsewhere, "export default {};\n", "server.js");
    mkdirSync(join(dir, "plugins"));
    symlinkSync(elsewhere, linkOf(dir));
    assert.match(run(["--config-dir", dir, "--check"]).output, /^warn .*opencode-shell-guard points to .*old-plugin, not to /m);
    const result = guard(dir);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /replaces the link to .*old-plugin/);
    assert.equal(readlinkSync(linkOf(dir)), PLUGIN);
    rmSync(linkOf(dir));
    symlinkSync(join(dir, "gone"), linkOf(dir));
    assert.match(run(["--config-dir", dir, "--check"]).output, /^warn .*opencode-shell-guard points to .*gone, which has no server\.js/m);
  });

  it("writes nothing when something that is not a link is at the link's place", () => {
    const dir = temp();
    const original = JSON.stringify({ permissions: RULES });
    const file = write(dir, original);
    mkdirSync(linkOf(dir), { recursive: true });
    const result = guard(dir);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /^fail .*opencode-shell-guard exists and is not a link; nothing was changed$/m);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.ok(!existsSync(join(dir, "AGENTS.md")));
  });

  it("makes the link before it touches the config, so the old rules stay when the link cannot be made", () => {
    const dir = temp();
    const original = JSON.stringify({ shell: BASH, permissions: RULES });
    const file = write(dir, original);
    writeFileSync(join(dir, "plugins"), "not a folder");
    const result = guard(dir);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /^fail writing stopped: /m);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.ok(!existsSync(join(dir, "AGENTS.md")));
  });

  it("links the marketplace clone's plugin when it runs from a copy in the plugin cache", () => {
    const home = temp();
    const clone = join(home, ".claude", "plugins", "marketplaces", "apana-private", "skills", "opencode-shell-guard", "plugin");
    write(clone, "export default {};\n", "server.js");
    const cached = join(home, ".claude", "plugins", "cache", "apana-private", "apana", "0.22.0", "skills", "opencode-shell-guard", "plugin");
    const dir = temp();
    assert.equal(run(["--config-dir", dir, "--shell", BASH], { home, ownPlugin: cached }).code, 0);
    assert.equal(readlinkSync(linkOf(dir)), clone);
  });

  it("writes nothing to a file that is not JSONC or whose permissions are not an array", () => {
    for (const original of ['{ "shell": "/bin/zsh" "x": 1 }', '{ "permissions": { "shell": "deny" } }']) {
      const dir = temp();
      const file = write(dir, original);
      const result = guard(dir);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /^fail .*nothing was changed$/m);
      assert.equal(readFileSync(file, "utf8"), original);
      assert.ok(!existsSync(join(dir, "AGENTS.md")) && !existsSync(join(dir, "plugins")));
      assert.deepEqual(backups(dir), []);
    }
  });

  it("writes through a symlinked config and keeps the link", () => {
    const dir = temp();
    const real = write(join(dir, "dotfiles"), '{ "model": "a/b" }\n');
    const config = join(dir, "opencode");
    mkdirSync(config);
    symlinkSync(real, join(config, "opencode.jsonc"));
    assert.equal(guard(config).code, 0);
    assert.ok(lstatSync(join(config, "opencode.jsonc")).isSymbolicLink());
    assert.equal(load(real).shell, BASH);
  });

  it("edits opencode.json when it is the only config file", () => {
    const dir = temp();
    const file = write(dir, '{ "model": "a/b" }\n', "opencode.json");
    assert.equal(guard(dir).code, 0);
    assert.equal(load(file).shell, BASH);
    assert.ok(!existsSync(join(dir, "opencode.jsonc")));
  });

  it("keeps a shell that is already a bash and chooses a bash when none is set", () => {
    const dir = temp();
    const file = write(dir, JSON.stringify({ shell: BASH }));
    assert.equal(run(["--config-dir", dir]).code, 0);
    assert.equal(load(file).shell, BASH);
    const empty = temp();
    assert.equal(run(["--config-dir", empty]).code, 0);
    assert.equal(basename(load(join(empty, "opencode.jsonc")).shell), "bash");
  });

  it("refuses a --shell that is not an executable bash, a wrong argument and Windows", () => {
    for (const shell of [process.execPath, join(temp(), "no-such-bash")]) {
      const dir = temp();
      const result = run(["--config-dir", dir, "--shell", shell]);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /is not an executable bash/);
      assert.ok(!existsSync(join(dir, "opencode.jsonc")) && !existsSync(join(dir, "AGENTS.md")) && !existsSync(join(dir, "plugins")));
    }
    assert.equal(run(["--nope"]).code, 2);
    assert.equal(run(["--config-dir"]).code, 2);
    assert.equal(run(["--check", "--dry-run"]).code, 2);
    assert.equal(run(["--check"], { platform: "win32" }).code, 1);
  });

  it("runs as a command: prints the report and sets the exit code", () => {
    const dir = temp();
    const ran = spawnSync(process.execPath, [SCRIPT, "--config-dir", dir, "--check"], { encoding: "utf8" });
    assert.equal(ran.status, 1);
    assert.match(ran.stdout, /^warn .*opencode\.jsonc does not exist$/m);
  });
});

describe("the skill package", () => {
  const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const [, frontmatter] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? [];

  it("has the folder's name and a quoted description under 1024 characters that says when to use it", () => {
    assert.match(frontmatter, new RegExp(`^name: ${basename(SKILL)}$`, "m"));
    const description = JSON.parse(/^description: (".*")$/m.exec(frontmatter)[1]);
    assert.ok(description.length < 1024, `description is ${description.length} characters`);
    for (const cue of ["Use when", "bash", "grep", "rg", "plugin", "Romanian:"]) assert.ok(description.includes(cue), cue);
  });

  it("runs the script it ships with node, its plugin imports the shared rules, and no file carries a local user path", () => {
    assert.ok(text.includes('node "${CLAUDE_SKILL_DIR}/scripts/shell-guard.mjs" --check'));
    const server = readFileSync(join(PLUGIN, "server.js"), "utf8");
    assert.ok(server.includes('new URL("../scripts/rules.mjs", here)') && existsSync(join(SKILL, "scripts", "rules.mjs")));
    assert.deepEqual(readdirSync(PLUGIN), ["server.js"], "OpenCode loads the plugin folder; nothing else belongs in it");
    for (const file of [join(SKILL, "SKILL.md"), SCRIPT, join(SKILL, "scripts", "rules.mjs"), join(PLUGIN, "server.js")]) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /\/Users\//, file);
    }
  });
});
