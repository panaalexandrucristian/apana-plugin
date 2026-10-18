// Entry point for `node --test private/explica-clar/test/`. Node 22 resolves a
// directory argument as a module (this index.js, ESM via the root
// package.json), so it loads every *.test.mjs file in this directory.
import { readdirSync } from "node:fs";

const dir = new URL("./", import.meta.url);
for (const file of readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort()) {
  await import(new URL(file, dir).href);
}
