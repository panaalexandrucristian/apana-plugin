#!/usr/bin/env node
// find-def: at which lines is the implementation of a function in a Kotlin file?
//
//   node private/find-usages/find-def.mjs <File.kt> [name] [--json]
//
// Without a name every function of the file is listed. Exit codes: 0 found,
// 1 no such function, 2 bad arguments or an unreadable file.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { findDefinitions } from "./definitions.mjs";

const USAGE = `usage: find-def.mjs <File.kt> [name] [--json]
  Lines where the implementation of a function starts and ends; every function of the file when no name is given.
  --json   print the result as JSON`;

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length < 1 || positionals.length > 2) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const [file, name] = positionals;
  if (extname(file) !== ".kt") {
    console.error(`only .kt files are supported (got ${file})`);
    return 2;
  }
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`cannot read ${file}: ${error.code ?? error.message}`);
    return 2;
  }
  const definitions = findDefinitions(source, name ?? null);
  if (definitions.length === 0) {
    console.error(name === undefined ? `no functions in ${file}` : `no function named "${name}" in ${file}`);
    return 1;
  }
  if (values.json) {
    console.log(JSON.stringify(definitions, null, 2));
    return 0;
  }
  for (const def of definitions) {
    const notes = [];
    if (def.local) notes.push(`local in ${def.parent}`);
    if (def.receiver) notes.push(`extension of ${def.receiver}`);
    if (def.unclosed) notes.push("brace never closes");
    const label = def.owner ? `${def.owner}.${def.name}` : def.name;
    console.log(`${label}  ${file}:${def.start}-${def.end}  ${def.body}${notes.length ? `  (${notes.join(", ")})` : ""}`);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
