import assert from "node:assert/strict";
import { test } from "node:test";
import { canAccess } from "../src/access.js";

test("a member with a token and a paid plan gets access", () => {
  assert.equal(canAccess("abc", true, true, false, false), true);
});

test("no token means no access", () => {
  assert.equal(canAccess("", true, true, false, false), false);
});

test("a suspended member gets no access", () => {
  assert.equal(canAccess("abc", true, true, false, true), false);
});

test("a member on trial gets access", () => {
  assert.equal(canAccess("abc", true, false, true, false), true);
});
