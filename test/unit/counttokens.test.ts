/** Unit tests for the local count_tokens estimator. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateInputTokens } from "../../src/server.js";

test("estimateInputTokens handles empty / null inputs", () => {
  assert.equal(estimateInputTokens(null), 0);
  assert.equal(estimateInputTokens({}), 1, "floor of 1 token");
});

test("estimateInputTokens approximates chars/4 over system + messages + tools", () => {
  const n = estimateInputTokens({
    system: "abcd", // 4
    messages: [{ role: "user", content: "efghefgh" }], // 8
    tools: [{ name: "x" }], // JSON.stringify length
  });
  // ~ (4 + 8 + len('[{"name":"x"}]')) / 4 — just assert it scales sensibly
  assert.ok(n >= 4, "non-trivial content yields several tokens");
  assert.ok(estimateInputTokens({ system: "a".repeat(400) }) >= 100, "400 chars ~ 100 tokens");
});
