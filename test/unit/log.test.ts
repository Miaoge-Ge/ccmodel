/** Unit tests for log secret-redaction. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../../src/core/log.js";

test("redactSecrets masks Bearer tokens", () => {
  assert.equal(redactSecrets("Authorization: Bearer sk-abcdef123456"), "Authorization: Bearer [redacted]");
  assert.equal(redactSecrets("sent bearer ABCDEF123456 upstream"), "sent bearer [redacted] upstream");
});

test("redactSecrets masks api-key header values", () => {
  assert.ok(redactSecrets("x-api-key: sk-livekey9999").includes("[redacted]"));
  assert.ok(!redactSecrets('{"authorization":"Bearer toptoptoptop"}').includes("toptoptoptop"));
});

test("redactSecrets masks bare provider key shapes", () => {
  assert.equal(redactSecrets("key=sk-ant-abcdefgh12345 done"), "key=sk-ant-[redacted] done");
  assert.equal(redactSecrets("sk-proj-ZZZZZZZZ9999"), "sk-proj-[redacted]");
});

test("redactSecrets leaves ordinary text and ${ENV} refs alone", () => {
  assert.equal(redactSecrets("rewrote model=claude-x -> backend max_tokens=64000"), "rewrote model=claude-x -> backend max_tokens=64000");
  assert.equal(redactSecrets("using ${DEEPSEEK_API_KEY}"), "using ${DEEPSEEK_API_KEY}");
});
