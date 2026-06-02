/**
 * End-to-end integration tests: a real proxy in front of an in-process mock
 * backend (no network, no keys). Shared setup lives in test/helpers/harness.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { CONTEXT_1M_BETA } from "../src/pipeline/model1m.js";
import { startHarness, buildCtx, listen, type Harness } from "./helpers/harness.js";

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => h?.close());

test("healthz reports ok + codex helper + slots", async () => {
  const j = (await (await h.get("/healthz")).json()) as any;
  assert.equal(j.ok, true);
  assert.equal(j.codex_helper, true);
  assert.ok(j.slots["claude-minimax-m3"], "a configured slot is reported");
});

test("/v1/models merges upstream + custom; [1m] is suffix-driven", async () => {
  const data = ((await (await h.get("/v1/models")).json()) as any).data as Array<{ id: string }>;
  const ids = data.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-4-8"), "upstream + standard model present");
  assert.ok(ids.includes("claude-minimax-m3[1m]"), "[1m] entry advertised as a 1M pick");
  assert.ok(!ids.includes("claude-minimax-m3"), "a [1m] entry does NOT also advertise the bare id");
  assert.ok(!ids.includes("claude-opus-4-8[1m]"), "a standard entry does NOT invent a [1m] variant");
  assert.ok(!ids.includes("claude-mock-model[1m]") && !ids.includes("claude-retry-model[1m]"), "no spurious [1m] variants");
});

test("UltraCode envelope is forced on passthrough", async () => {
  await h.post({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  const a = h.state.seenAnth;
  assert.equal(a.output_config.effort, "xhigh");
  assert.equal(a.thinking.type, "adaptive");
  assert.ok(a.max_tokens >= 64000);
  const sys = a.system;
  const hasReminder =
    typeof sys === "string" ? sys.includes("Ultracode is on:") : sys.some((b: any) => (b.text || "").includes("Ultracode is on:"));
  assert.ok(hasReminder);
  assert.ok(!(h.state.seenAnthHeaders["anthropic-beta"] || "").includes(CONTEXT_1M_BETA), "no 1M beta without [1m]");
});

test("[1m] suffix → strips suffix AND guarantees the 1M beta header on passthrough", async () => {
  await h.post({ model: "claude-opus-4-8[1m]", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  assert.equal(h.state.seenAnth.model, "claude-opus-4-8", "suffix stripped before upstream");
  assert.ok((h.state.seenAnthHeaders["anthropic-beta"] || "").includes(CONTEXT_1M_BETA), "1M beta injected");
});

test("incoming 1M beta is honored + preserved alongside other betas", async () => {
  await h.post(
    { model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    { "anthropic-beta": `${CONTEXT_1M_BETA},prompt-caching-2024-07-31` },
  );
  const beta = h.state.seenAnthHeaders["anthropic-beta"] || "";
  assert.ok(beta.includes(CONTEXT_1M_BETA) && beta.includes("prompt-caching-2024-07-31"));
});

test("openai_compat streaming tool-call → Anthropic tool_use (+ caps/headers/body/${ENV})", async () => {
  const out = await (
    await h.post({
      model: "claude-mock-model",
      max_tokens: 50,
      stream: true,
      tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "weather in paris?" }],
    })
  ).text();
  const o = h.state.seenOai;
  assert.equal(o.model, "mock-model", "backend id (not the claude-* alias) sent upstream");
  assert.equal(o.tools[0].function.name, "get_weather");
  assert.equal(o.tool_choice, "auto");
  assert.equal(o.max_tokens, 1234, "slot max_output_tokens cap honored");
  assert.equal(o.reasoning_split, true, "route body param merged");
  assert.equal(h.state.seenOaiHeaders["x-test-ua"], "ccmodel/test", "custom header forwarded");
  assert.equal(h.state.seenOaiHeaders["authorization"], "Bearer secret123", "${ENV} key wrapped + reached backend");
  assert.ok(out.includes('"type":"tool_use"') && out.includes('"name":"get_weather"'));
  assert.ok(out.includes("input_json_delta") && out.includes("Paris"));
  assert.ok(out.includes('"stop_reason":"tool_use"') && out.includes("Hello ") && out.includes("world"));
});

test("[1m] on an openai_compat backend → clean backend id, native 1M", async () => {
  const out = await (await h.post({ model: "claude-minimax-m3[1m]", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(h.state.seenOai.model, "MiniMax-M3", "suffix stripped to the backend id");
  assert.equal(h.state.seenOai.max_tokens, 64000);
  assert.ok(out.includes("ok-1m"));
});

test("empty turn is auto-retried → recovered", async () => {
  h.state.retryHits = 0;
  const out = await (await h.post({ model: "claude-retry-model", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(h.state.retryHits, 2);
  assert.ok(out.includes("recovered"));
});

test("openai_compat with no key sends no Authorization (no fake Bearer)", async () => {
  await h.post({ model: "claude-nokey-model", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
  assert.equal(h.state.seenOai.model, "nokey-model");
  assert.equal(h.state.seenOaiHeaders["authorization"], undefined, "no Authorization header when no key is configured");
});

test("an oversized request body is rejected with 413", async () => {
  const ctx = { ...buildCtx({ models: [] }, "http://127.0.0.1:1"), maxBodyBytes: 50 };
  const server = createServer(ctx);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "y".repeat(500) }] }),
    });
    assert.equal(r.status, 413);
    assert.equal(((await r.json()) as any).error.type, "request_too_large");
  } finally {
    server.close();
  }
});
