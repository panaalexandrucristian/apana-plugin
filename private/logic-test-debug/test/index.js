// Entry point for `node --test private/logic-test-debug/test/`. Node 22 resolves a
// directory argument as a module (this index.js, ESM via the root package.json), so it
// loads every *.test.mjs file in this directory (same loader as private/explica-clar/test).
import { readdirSync } from "node:fs";

const dir = new URL("./", import.meta.url);
for (const file of readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort()) {
  await import(new URL(file, dir).href);
}
