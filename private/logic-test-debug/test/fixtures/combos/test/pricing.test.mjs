import assert from "node:assert/strict";
import { test } from "node:test";
import { quote } from "../src/pricing.js";

test("one basic unit in the EU, standard delivery", () => {
  assert.equal(quote({ units: 1, tier: "basic", region: "EU", coupon: false, express: false, gift: false, taxExempt: false }), 1700);
});

test("one plus unit in the US, standard delivery", () => {
  assert.equal(quote({ units: 1, tier: "plus", region: "US", coupon: false, express: false, gift: false, taxExempt: false }), 2120);
});
