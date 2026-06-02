/** Unit tests for ${VAR} expansion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandEnv } from "../../src/core/env.js";

test("expandEnv substitutes known vars and blanks unknown ones", () => {
  process.env.E_A = "alpha";
  process.env.E_B = "beta";
  assert.equal(expandEnv("${E_A}"), "alpha");
  assert.equal(expandEnv("x-${E_A}-${E_B}-y"), "x-alpha-beta-y");
  assert.equal(expandEnv("${E_MISSING}"), "", "unknown var → empty");
  assert.equal(expandEnv("plain"), "plain", "no token → unchanged");
});

test("expandEnv leaves non-strings untouched and tolerates a lone ${", () => {
  assert.equal(expandEnv(42 as any), 42 as any);
  assert.equal(expandEnv(undefined as any), undefined as any);
  assert.equal(expandEnv("a ${ unterminated"), "a ${ unterminated");
});
