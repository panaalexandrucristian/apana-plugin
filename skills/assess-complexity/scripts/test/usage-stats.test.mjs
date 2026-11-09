// Cost and counts of usage_stats.py on small transcript folders: each request priced at its own model and tier, advisor iterations at the advisor's model, bad lines skipped and counted. Node stdlib and python3.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "usage_stats.py");
const M = 1_000_000;
const usage = (fields) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...fields });
const request = (id, model, fields) => JSON.stringify({ type: "assistant", message: { id, model, usage: usage(fields) } });

// Writes one main session per entry of `sessions` ({ name: [lines] }), runs the script, returns stdout.
function run(sessions) {
  const dir = mkdtempSync(join(tmpdir(), "usage-stats-"));
  try {
    for (const [name, lines] of Object.entries(sessions)) writeFileSync(join(dir, `${name}.jsonl`), `${lines.join("\n")}\n`);
    const result = spawnSync("python3", ["-I", SCRIPT, dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const main = (out) => out.split("\n## ").find((block) => block.startsWith("main sessions")) ?? "";
const priced = (out) => Number(/with known price: (\d+)/.exec(main(out))?.[1]);
const cost = (out) => /cost \$ \(API rate\):.* max=([\d.]+)/.exec(main(out))?.[1];

describe("usage_stats.py cost", () => {
  it("prices each request at its own model, and a session with several models is 'mixed'", () => {
    const out = run({ s: [request("m1", "claude-sonnet-5-5", { input_tokens: M }), request("m2", "claude-sonnet-5-5", { input_tokens: M }), request("m3", "claude-opus-5-5", { input_tokens: M })] });
    assert.equal(cost(out), "8.00");
    assert.match(out, /^models: \[\('mixed', 1\)\]$/m);
  });

  it("prices a Haiku 5.5 request whose prompt, cache reads included, is over 100,000 tokens at the higher rates", () => {
    const out = run({ s: [request("m1", "claude-haiku-5-5", { input_tokens: M }), request("m2", "claude-haiku-5-5", { input_tokens: 60_000, cache_read_input_tokens: 60_000 })] });
    assert.equal(cost(out), "0.53");
  });

  it("prices a Sonnet 5.5 cache read at $0.10 per million", () => {
    assert.equal(cost(run({ s: [request("m1", "claude-sonnet-5-5", { cache_read_input_tokens: M })] })), "0.10");
  });

  it("leaves a session without $ when any request with tokens has no known price", () => {
    const out = run({ s: [request("m1", "claude-sonnet-5-5", { input_tokens: M }), request("m2", "other-model", { input_tokens: M })] });
    assert.equal(priced(out), 0);
    assert.equal(cost(out), undefined);
  });

  it("skips a zero-usage <synthetic> record, so the session keeps its model and its $", () => {
    const out = run({ s: [request("m0", "<synthetic>", {}), request("m1", "claude-sonnet-5-5", { input_tokens: M })] });
    assert.equal(cost(out), "2.00");
    assert.match(out, /^models: \[\('claude-sonnet-5-5', 1\)\]$/m);
    assert.match(out, /zero-usage records=1\b/);
  });

  it("prices advisor iterations at the advisor's model and every executor cache write, though the top-level breakdown shows only the first iteration's", () => {
    const iterations = [
      { type: "message", ...usage({ cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M } }) },
      { type: "advisor_message", model: "claude-fable-5-1", ...usage({ input_tokens: M }) },
      { type: "message", ...usage({ cache_creation_input_tokens: M, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 } }) },
    ];
    const top = usage({ cache_creation_input_tokens: 2 * M, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M }, iterations });
    const out = run({ s: [JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: top } })] });
    assert.equal(cost(out), "23.00", "Opus 1h write $8 + Fable input $10 + Opus 5m write $5");
    assert.match(out, /^models: \[\('claude-opus-5-5', 1\)\]$/m, "the advisor's model does not make the session mixed");
  });
});

describe("usage_stats.py counts", () => {
  it("counts cache writes in the context even when their 5m/1h breakdown is empty", () => {
    const out = run({ s: [request("m1", "claude-sonnet-5-5", { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })] });
    assert.match(main(out), /avg context\/turn: p10=1,000\.00 p50=1,000\.00/);
  });

  it("skips and counts lines that are not JSON objects and records without a message id, and keeps the rest of the file", () => {
    const out = run({ s: [request("m1", "claude-sonnet-5-5", { input_tokens: M }), "{not json", "[1, 2]", request(undefined, "claude-sonnet-5-5", { input_tokens: M }), request("m2", "claude-sonnet-5-5", { input_tokens: M })] });
    assert.equal(cost(out), "4.00");
    assert.match(out, /lines not a JSON object=2\b/);
    assert.match(out, /records without a message id=1\b/);
  });

  it("prints how many message ids occur in more than one file", () => {
    const out = run({ a: [request("m1", "claude-sonnet-5-5", { input_tokens: M })], b: [request("m1", "claude-sonnet-5-5", { input_tokens: M })] });
    assert.match(out, /^message ids in more than one file: 1$/m);
  });
});
