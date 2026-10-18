// The structural checks of the adapter on one OpenCode binary, against the stand-in provider (no model, no credentials, no cost): a code
// prompt gets the directive in every model request and the skill is listed and loadable; a poem prompt and APANA_LOGIC_TEST_DEBUG=off get
// no directive. Usage: LTD_OPENCODE=<binary> node versions.mjs <label> <run dir> <plugin dir>
import { join } from "node:path";
import { runSession } from "./run.mjs";

export async function checkVersion({ label, dir, pluginDir }) {
  const cases = [
    ["code", "Fix the bug in utils.js: the function sum returns the wrong value.", {}, "load-skill"],
    ["poem", "Write a short poem about the sea.", {}, "text"],
    ["off", "Fix the bug in utils.js: the function sum returns the wrong value.", { APANA_LOGIC_TEST_DEBUG: "off" }, "text"],
  ];
  const results = {};
  for (const [name, prompt, env, mode] of cases) {
    const r = await runSession({ dir: join(dir, `ver-${label}-${name}`), pluginDir, prompt, mode, env, timeoutMs: 150000 });
    results[name] = { exit: r.exit, directive: r.summary.directiveInSystem, skillListed: r.summary.skillListed, skillBodyReturned: r.summary.skillBodyReturned };
  }
  const pass = results.code.directive.length > 0 && results.code.directive.every(Boolean) && results.code.skillListed.every(Boolean) && results.code.skillBodyReturned && results.poem.directive.every((x) => !x) && results.off.directive.every((x) => !x) && results.off.skillListed.every((x) => !x);
  return { label, pass, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [label, dir, pluginDir] = process.argv.slice(2);
  console.log(JSON.stringify(await checkVersion({ label, dir, pluginDir }), null, 2));
}
