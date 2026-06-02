/** Unit tests for the [1m] suffix + 1M beta-header machinery. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelId,
  withOneMSuffix,
  ensure1mBetaHeader,
  headerRequests1m,
  CONTEXT_1M_BETA,
  ONE_MILLION,
  STANDARD_CONTEXT,
} from "../../src/pipeline/model1m.js";

test("parseModelId splits the [1m] suffix (tolerant of case + whitespace)", () => {
  assert.deepEqual(parseModelId("claude-opus-4-8[1m]"), { baseId: "claude-opus-4-8", want1m: true });
  assert.deepEqual(parseModelId("claude-opus-4-8"), { baseId: "claude-opus-4-8", want1m: false });
  assert.deepEqual(parseModelId("claude-x [1M]"), { baseId: "claude-x", want1m: true });
  assert.deepEqual(parseModelId("claude-x[ 1m ]"), { baseId: "claude-x", want1m: true });
  assert.deepEqual(parseModelId(""), { baseId: "", want1m: false });
  assert.deepEqual(parseModelId(null), { baseId: "", want1m: false });
  assert.deepEqual(parseModelId(undefined), { baseId: "", want1m: false });
});

test("withOneMSuffix appends [1m] idempotently", () => {
  assert.equal(withOneMSuffix("claude-x"), "claude-x[1m]");
  assert.equal(withOneMSuffix("claude-x[1m]"), "claude-x[1m]");
});

test("context-window constants", () => {
  assert.equal(ONE_MILLION, 1_000_000);
  assert.equal(STANDARD_CONTEXT, 200_000);
});

test("ensure1mBetaHeader adds the beta and preserves existing betas", () => {
  assert.equal(ensure1mBetaHeader({})["anthropic-beta"], CONTEXT_1M_BETA);
  const h2 = ensure1mBetaHeader({ "Anthropic-Beta": "prompt-caching-2024-07-31" });
  assert.ok(h2["anthropic-beta"]!.includes("prompt-caching-2024-07-31"));
  assert.ok(h2["anthropic-beta"]!.includes(CONTEXT_1M_BETA));
  assert.equal(h2["Anthropic-Beta"], undefined, "old-cased key removed to avoid duplicates");
});

test("ensure1mBetaHeader is idempotent (no duplicate beta)", () => {
  const h = ensure1mBetaHeader({ "anthropic-beta": CONTEXT_1M_BETA });
  assert.equal(h["anthropic-beta"], CONTEXT_1M_BETA);
  const again = ensure1mBetaHeader(h);
  assert.equal((again["anthropic-beta"]!.match(new RegExp(CONTEXT_1M_BETA, "g")) || []).length, 1);
});

test("headerRequests1m detects the beta under any casing", () => {
  assert.equal(headerRequests1m({ "anthropic-beta": `foo,${CONTEXT_1M_BETA}` }), true);
  assert.equal(headerRequests1m({ "Anthropic-Beta": CONTEXT_1M_BETA }), true);
  assert.equal(headerRequests1m({ "anthropic-beta": ["a", CONTEXT_1M_BETA] }), true);
  assert.equal(headerRequests1m({ "anthropic-beta": "prompt-caching-2024-07-31" }), false);
  assert.equal(headerRequests1m({}), false);
});
