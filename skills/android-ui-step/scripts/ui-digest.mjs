#!/usr/bin/env node
// ui-digest: the output of `android layout` (JSON) as one line per useful app element; system windows (clock, notifications) are dropped.
//   android layout | node ui-digest.mjs        or        node ui-digest.mjs <layout.json> [--include-system]
// A line: Class | label | center x,y | actions. An element is listed when it has a text, a description or an id name, or when it can be clicked.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHORT = { CLICKABLE: "click", EDITABLE: "edit", PASSWORD: "password", CHECKABLE: "check", SCROLLABLE: "scroll", LONG_CLICKABLE: "longclick" };
export function digest(data, { includeSystem = false } = {}) {
  const lines = [];
  let total = 0;
  for (const w of data) {
    if (w.type === "SYSTEM" && !includeSystem) continue;
    for (const e of w.content ?? []) {
      total += 1;
      const actions = (e.interactions ?? []).map((a) => SHORT[a]).filter(Boolean);
      const label = e.text || e["content-desc"] || (e["resource-id"] ?? "").split("/").pop().replace(/^.*:id\//, "");
      if (!label && !actions.includes("click")) continue;
      lines.push(`${(e.class ?? "").split(".").pop()} | ${label || "-"} | ${(e.center ?? "").replace(/[[\]]/g, "")}${actions.length ? ` | ${actions.join(",")}` : ""}`);
    }
  }
  return { lines, total };
}
export const render = (data, options) => {
  const { lines, total } = digest(data, options);
  if (total === 0) return "ui-digest: 0 app elements: the screen exposes no layout (loading, a WebView or a secure window). Wait a few seconds and ask again once; if it stays empty, use a screenshot.";
  return `ui-digest: ${lines.length} of ${total} elements${options?.includeSystem ? "" : " (system windows left out)"}\n${lines.join("\n")}`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  let text;
  try { text = readFileSync(file ?? 0, "utf8"); } catch (error) { console.error(`cannot read the layout: ${error.code ?? error.message}`); process.exit(2); }
  let data;
  try { data = JSON.parse(text.replace(/\nShell cwd was reset.*$/s, "").trim()); } catch { console.error("the input is not the JSON printed by `android layout`"); process.exit(2); }
  console.log(render(data, { includeSystem: args.includes("--include-system") }));
}
