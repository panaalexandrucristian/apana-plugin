#!/usr/bin/env node
// img-shrink: a smaller copy of a screenshot, to Read instead of the original.
//   node img-shrink.mjs <image.png> [--max-width 540] [--quality 70] [--crop x,y,w,h] [--out <file.jpg>]
// Uses macOS `sips`. Prints the output path, the pixel sizes and the byte sizes. Exit 3: sips is not available. Exit 2: bad input.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sips = (...args) => execFileSync("sips", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const size = (file) => { const t = sips("-g", "pixelWidth", "-g", "pixelHeight", file); return [Number(/pixelWidth: (\d+)/.exec(t)[1]), Number(/pixelHeight: (\d+)/.exec(t)[1])]; };

export function shrink(input, { maxWidth = 540, quality = 70, crop = null, out = null } = {}) {
  const target = out ?? join(dirname(input), `${basename(input).replace(/\.[^.]+$/, "")}-s${maxWidth}.jpg`);
  const before = { px: size(input), bytes: statSync(input).size };
  let source = input;
  if (crop) {
    const [x, y, w, h] = crop;
    const tmp = `${target}.crop.png`;
    sips("-c", String(h), String(w), "--cropOffset", String(y), String(x), input, "--out", tmp);
    source = tmp;
  }
  sips("-s", "format", "jpeg", "-s", "formatOptions", String(quality), "--resampleWidth", String(maxWidth), source, "--out", target);
  return { path: target, before, after: { px: size(target), bytes: statSync(target).size } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { "max-width": { type: "string" }, quality: { type: "string" }, crop: { type: "string" }, out: { type: "string" } } });
  if (positionals.length !== 1 || !existsSync(positionals[0])) { console.error("usage: img-shrink.mjs <image> [--max-width 540] [--quality 70] [--crop x,y,w,h] [--out file.jpg]"); process.exit(2); }
  try { execFileSync("sips", ["--version"], { stdio: "ignore" }); } catch { console.error("img-shrink needs macOS sips (not found)"); process.exit(3); }
  const r = shrink(positionals[0], { maxWidth: Number(values["max-width"] ?? 540), quality: Number(values.quality ?? 70), crop: values.crop ? values.crop.split(",").map(Number) : null, out: values.out ?? null });
  console.log(`${r.path}  ${r.before.px.join("x")} ${r.before.bytes} B -> ${r.after.px.join("x")} ${r.after.bytes} B`);
}
