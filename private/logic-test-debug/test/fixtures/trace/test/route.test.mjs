import assert from "node:assert/strict";
import { test } from "node:test";
import { route } from "../src/route.js";

test("a domestic parcel without a customs form is allowed", () => {
  assert.deepEqual(route({ weightKg: 1, country: "RO", fragile: false, express: false, customs: false }), { allowed: true, method: "standard", fee: 500 });
});

test("a parcel to the world zone without a customs form is refused", () => {
  assert.deepEqual(route({ weightKg: 1, country: "US", fragile: false, express: false, customs: false }), { allowed: false, method: "none", fee: 0 });
});

test("a 5 kg express parcel to Germany costs the middle fee plus the express supplement", () => {
  assert.deepEqual(route({ weightKg: 5, country: "DE", fragile: false, express: true, customs: true }), { allowed: true, method: "express", fee: 1260 });
});
