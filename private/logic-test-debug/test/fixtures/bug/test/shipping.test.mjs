import assert from "node:assert/strict";
import { test } from "node:test";
import { isApproved, schedule } from "../src/shipping.js";

// Flags are written as expedited, signed, insured.
test("000: nothing set is not approved", () => {
  assert.equal(isApproved({ expedited: false, signed: false, insured: false }), false);
});

test("011: signed and insured is approved", () => {
  assert.equal(isApproved({ expedited: false, signed: true, insured: true }), true);
});

test("101: expedited and insured but unsigned is not approved", () => {
  assert.equal(isApproved({ expedited: true, signed: false, insured: true }), false);
});

test("110: expedited and signed but uninsured is not approved", () => {
  assert.equal(isApproved({ expedited: true, signed: true, insured: false }), false);
});

test("an expedited shipment is scheduled next-day", () => {
  assert.equal(schedule({ expedited: true }), "next-day");
});
