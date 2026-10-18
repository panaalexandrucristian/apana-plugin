#!/usr/bin/env node
// Prints the report of all stored live runs. Usage: node report.mjs [--json]
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAll, summarize, toMarkdown } from "./lib/report.mjs";

const root = process.env.LTD_ROOT ?? join(homedir(), "Dev", "jev-test-runs", "logic-test-debug");
const summary = summarize(loadAll(join(root, "runs")));
console.log(process.argv.includes("--json") ? JSON.stringify(summary, null, 2) : toMarkdown(summary));
