/** Unit tests for the provider registry + the cursor-agent stream parser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, registeredTypes } from "../../src/providers/registry.js";
import { parseStream } from "../../src/providers/cursorClient.js";

test("provider registry resolves by type and defaults to anthropic", () => {
  assert.equal(resolveProvider("openai_compat").type, "openai_compat");
  assert.equal(resolveProvider("codex_oauth").type, "codex_oauth");
  assert.equal(resolveProvider("cursor_agent").type, "cursor_agent");
  assert.equal(resolveProvider(undefined).type, "anthropic", "unknown/undefined → anthropic");
  assert.deepEqual(registeredTypes().sort(), ["anthropic", "codex_oauth", "cursor_agent", "openai_compat"]);
});

test("cursor parseStream: assistant text blocks are concatenated", () => {
  const out = parseStream([
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "world" }] } }),
    JSON.stringify({ type: "result", result: "ignored-when-assistant-text-present" }),
  ]);
  assert.deepEqual(out, [["text", "Hello world"]]);
});

test("cursor parseStream: falls back to the result string when no assistant text", () => {
  const out = parseStream([JSON.stringify({ type: "result", result: "final answer" })]);
  assert.deepEqual(out, [["text", "final answer"]]);
});

test("cursor parseStream: an error result short-circuits", () => {
  const out = parseStream([JSON.stringify({ type: "result", is_error: true, result: "boom" })]);
  assert.deepEqual(out, [["error", "boom"]]);
});

test("cursor parseStream: malformed lines are skipped", () => {
  const out = parseStream(["not json", "", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })]);
  assert.deepEqual(out, [["text", "ok"]]);
});
