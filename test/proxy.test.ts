/**
 * Offline end-to-end + unit tests for the ccmodel proxy. Runs entirely against
 * an in-process mock backend — no real API keys, no network.
 *
 * Build + run:  npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createMock, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createServer, type ProxyContext } from "../src/server.js";
import { normalizeModels, stripJsonc, slug, inferType, wrapAuth, REPO_ROOT } from "../src/config/config.js";
import { expandModels } from "../src/pipeline/models.js";
import { parseModelId, ensure1mBetaHeader, headerRequests1m, CONTEXT_1M_BETA } from "../src/pipeline/model1m.js";
import { transformMessagesBody, type EnvelopeSettings } from "../src/pipeline/envelope.js";
import { anthropicToOpenai } from "../src/pipeline/translate.js";
import { resolveProvider, registeredTypes } from "../src/providers/registry.js";
import { validateConfig } from "../src/config/validate.js";
import type { Config } from "../src/config/types.js";

const SETTINGS: EnvelopeSettings = { forceEffort: "xhigh", forceThinking: true, maxTokensFloor: 64000, injectReminder: true, force1m: false };

// ── mock backend state ──────────────────────────────────────────────────────
let seenOai: any = null;
let seenOaiHeaders: Record<string, string> = {};
let seenAnth: any = null;
let seenAnthHeaders: Record<string, string> = {};
let retryHits = 0;

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf-8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function mockHandler(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url || "").split("?")[0] || "";
  if (req.method === "GET" && path.endsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ type: "model", id: "claude-opus-4-8", display_name: "Opus" }] }));
    return;
  }
  void readJson(req).then((body) => {
    if (path.endsWith("/v1/chat/completions")) {
      seenOai = body;
      seenOaiHeaders = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);

      if (body.model === "retry-model") {
        retryHits += 1;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (retryHits === 1) {
          sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 0 } });
        } else {
          sse({ choices: [{ delta: { content: "recovered" } }] });
          sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (body.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok-1m" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse({ choices: [{ delta: { content: "Hello " } }] });
      sse({ choices: [{ delta: { content: "world" } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] });
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (path.endsWith("/v1/messages")) {
      seenAnth = body;
      seenAnthHeaders = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_x", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ e: "nope" }));
  });
}

let mockServer: Server;
let proxyServer: Server;
let mockBase = "";
let proxyBase = "";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function buildCtx(cfg: Config, upstream: string): ProxyContext {
  const settings: EnvelopeSettings = { forceEffort: "xhigh", forceThinking: true, maxTokensFloor: Number(cfg.max_tokens) || 64000, injectReminder: true, force1m: cfg.force_1m === true };
  const { slotMap, models } = normalizeModels(cfg.models);
  return { upstream, settings, slotMap, modelMap: {}, discoveryModels: expandModels(models) };
}

before(async () => {
  process.env.MOCK_KEY = "secret123";
  mockServer = createMock(mockHandler);
  const mockPort = await listen(mockServer);
  mockBase = `http://127.0.0.1:${mockPort}`;

  const cfg: Config = {
    upstream: mockBase,
    max_tokens: 64000,
    models: [
      { name: "Opus", id: "claude-opus-4-8", api: "anthropic", model: "claude-opus-4-8", "1m": true },
      { name: "MiniMax", id: "claude-minimax-m3", api: "openai", url: mockBase + "/v1", model: "MiniMax-M3", key: "${MOCK_KEY}", max_output_tokens: 64000, "1m": "force", body: { reasoning_split: true } },
      { name: "Mock", id: "claude-mock", api: "openai", url: mockBase + "/v1", model: "mock-model", key: "${MOCK_KEY}", max_output_tokens: 1234, headers: { "X-Test-UA": "ccmodel/test" }, body: { reasoning_split: true }, "1m": false },
      { name: "Retry", id: "claude-retry", api: "openai", url: mockBase + "/v1", model: "retry-model", key: "${MOCK_KEY}" },
      { name: "NoKey", id: "claude-nokey", api: "openai", url: mockBase + "/v1", model: "nokey-model" },
    ],
  };
  proxyServer = createServer(buildCtx(cfg, mockBase));
  const proxyPort = await listen(proxyServer);
  proxyBase = `http://127.0.0.1:${proxyPort}`;
});

after(() => {
  mockServer?.close();
  proxyServer?.close();
});

function postMessages(body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${proxyBase}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-ant-dummy", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

// ── unit tests ──────────────────────────────────────────────────────────────

test("parseModelId splits the [1m] suffix", () => {
  assert.deepEqual(parseModelId("claude-opus-4-8[1m]"), { baseId: "claude-opus-4-8", want1m: true });
  assert.deepEqual(parseModelId("claude-opus-4-8"), { baseId: "claude-opus-4-8", want1m: false });
  assert.deepEqual(parseModelId("claude-x [1M]"), { baseId: "claude-x", want1m: true });
});

test("normalizeModels infers id, type and auth from minimal entries", () => {
  const { slotMap } = normalizeModels([
    { name: "DeepSeek V4 Pro", url: "https://api.deepseek.com/anthropic", key: "sk-x", model: "deepseek-v4-pro" },
    { name: "MiniMax M3", url: "https://api.minimax.io/v1", key: "sk-y", model: "MiniMax-M3" },
    { name: "Claude Opus 4.8", model: "claude-opus-4-8" },
    { name: "GPT-5.5", api: "codex", model: "gpt-5.5" },
  ]);
  // auto ids (no double "claude-" when the name already starts with it)
  assert.ok(slotMap["claude-deepseek-v4-pro"], "deepseek id");
  assert.ok(slotMap["claude-minimax-m3"], "minimax id");
  assert.ok(slotMap["claude-opus-4-8"], "opus id without doubled prefix");
  assert.ok(slotMap["claude-gpt-5-5"], "gpt id");
  // type inference: /anthropic = passthrough (no type), /v1 = openai_compat, none = anthropic
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.type, undefined);
  assert.equal(slotMap["claude-minimax-m3"]!.type, "openai_compat");
  assert.equal(slotMap["claude-opus-4-8"]!.type, undefined);
  assert.equal(slotMap["claude-gpt-5-5"]!.type, "codex_oauth");
  // auth wrapping
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.auth, "Bearer sk-x");
  assert.equal(slotMap["claude-opus-4-8"]!.auth, undefined, "no key => passthrough credential");
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.upstream, "https://api.deepseek.com/anthropic");
});

test("REPO_ROOT resolves to the repo root, not dist/", () => {
  // Guards against a regression if config.ts moves: defaultConfigPath() and the
  // doctor both rely on REPO_ROOT pointing at the actual repo root.
  assert.ok(existsSync(join(REPO_ROOT, "package.json")), "package.json should exist at REPO_ROOT");
  assert.ok(!/[\\/]dist$/.test(REPO_ROOT), "REPO_ROOT must not be the dist/ folder");
});

test("config helpers (slug/inferType/wrapAuth)", () => {
  assert.equal(slug("DeepSeek V4 Pro"), "deepseek-v4-pro");
  assert.equal(slug("GPT-5.5"), "gpt-5-5");
  assert.equal(inferType("https://x/anthropic", undefined), "anthropic");
  assert.equal(inferType("https://x/v1", undefined), "openai_compat");
  assert.equal(inferType(undefined, undefined), "anthropic");
  assert.equal(inferType("https://x/v1", "anthropic"), "anthropic"); // explicit api wins
  assert.equal(wrapAuth("sk-x"), "Bearer sk-x");
  assert.equal(wrapAuth("x-api-key: sk-x"), "x-api-key: sk-x");
  assert.equal(wrapAuth(undefined), undefined);
});

test("ensure1mBetaHeader adds the beta and preserves existing betas", () => {
  assert.equal(ensure1mBetaHeader({})["anthropic-beta"], CONTEXT_1M_BETA);
  const h2 = ensure1mBetaHeader({ "Anthropic-Beta": "prompt-caching-2024-07-31" });
  assert.ok(h2["anthropic-beta"]!.includes("prompt-caching-2024-07-31"));
  assert.ok(h2["anthropic-beta"]!.includes(CONTEXT_1M_BETA));
  assert.equal(h2["Anthropic-Beta"], undefined);
});

test("headerRequests1m detects the beta under any casing", () => {
  assert.equal(headerRequests1m({ "anthropic-beta": `foo,${CONTEXT_1M_BETA}` }), true);
  assert.equal(headerRequests1m({ "Anthropic-Beta": CONTEXT_1M_BETA }), true);
  assert.equal(headerRequests1m({ "anthropic-beta": "prompt-caching-2024-07-31" }), false);
});

test("stripJsonc removes comments and trailing commas but not string contents", () => {
  const obj = JSON.parse(stripJsonc(`{
    // line comment
    "url": "http://x/y", /* block */
    "note": "a // b /* c */ d",
    "arr": [1, 2,],
  }`));
  assert.equal(obj.url, "http://x/y");
  assert.equal(obj.note, "a // b /* c */ d");
  assert.deepEqual(obj.arr, [1, 2]);
});

test("expandModels: 1M is opt-in (true → base+[1m], force → [1m] only, else base only)", () => {
  const { models } = normalizeModels([{ name: "A" }, { name: "B", "1m": "force" }, { name: "C", "1m": false }, { name: "D", "1m": true }]);
  const all = expandModels(models);
  const ids = all.map((m) => m.id);
  assert.ok(ids.includes("claude-a") && !ids.includes("claude-a[1m]"), "no 1m flag → base only (no variant)");
  assert.ok(ids.includes("claude-b[1m]") && !ids.includes("claude-b"), "force → [1m] only");
  assert.ok(ids.includes("claude-c") && !ids.includes("claude-c[1m]"), "false → base only");
  assert.ok(ids.includes("claude-d") && ids.includes("claude-d[1m]"), "true → base + [1m]");
  assert.equal(all.find((m) => m.id === "claude-d[1m]")!.context_window, 1_000_000, "[1m] variant reports 1M");
  assert.equal(all.find((m) => m.id === "claude-d")!.context_window, 200_000, "base reports the standard window");
});

test("transformMessagesBody strips [1m], sets the envelope, flags want1m", () => {
  const { slotMap } = normalizeModels([{ name: "X", id: "claude-x", api: "anthropic", model: "backend-x", url: "https://up" }]);
  const raw = Buffer.from(JSON.stringify({ model: "claude-x[1m]", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  const { body, route } = transformMessagesBody(raw, {}, slotMap, {}, SETTINGS);
  const out = JSON.parse(body.toString());
  assert.equal(out.model, "backend-x");
  assert.equal(out.output_config.effort, "xhigh");
  assert.equal(out.thinking.type, "adaptive");
  assert.ok(out.max_tokens >= 64000);
  assert.equal(route.want1m, true);
});

test('"1m": true advertises a variant but does NOT force 1M on the base id', () => {
  const { slotMap } = normalizeModels([{ name: "V", id: "claude-v", api: "anthropic", model: "backend", url: "https://up", "1m": true }]);
  const base = transformMessagesBody(Buffer.from(JSON.stringify({ model: "claude-v", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })), {}, slotMap, {}, SETTINGS);
  assert.equal(base.route.want1m, false, "base id is NOT forced to 1M");
  const variant = transformMessagesBody(Buffer.from(JSON.stringify({ model: "claude-v[1m]", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })), {}, slotMap, {}, SETTINGS);
  assert.equal(variant.route.want1m, true, "the [1m] pick is 1M");
});

test('"1m": "force" forces 1M even on the base id', () => {
  const { slotMap } = normalizeModels([{ name: "F", id: "claude-f", api: "anthropic", model: "backend", url: "https://up", "1m": "force" }]);
  const r = transformMessagesBody(Buffer.from(JSON.stringify({ model: "claude-f", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })), {}, slotMap, {}, SETTINGS);
  assert.equal(r.route.want1m, true);
});

test("per-model effort override stops forcing effort", () => {
  const { slotMap } = normalizeModels([{ name: "Strict", id: "claude-strict", api: "anthropic", model: "backend", url: "https://up", effort: false }]);
  const raw = Buffer.from(JSON.stringify({ model: "claude-strict", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  const out = JSON.parse(transformMessagesBody(raw, {}, slotMap, {}, SETTINGS).body.toString());
  assert.equal(out.output_config, undefined, "effort suppressed");
  assert.ok(out.max_tokens >= 64000, "max_tokens floor still applied");
});

test("anthropicToOpenai keeps rejected/partial tool calls valid", () => {
  const assistantCalls = (...ids: string[]) => ({ role: "assistant", content: [{ type: "text", text: "ok" }, ...ids.map((i) => ({ type: "tool_use", id: i, name: "t", input: {} }))] });
  const adjacency = (msgs: any[]) => {
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].tool_calls) {
        const need = msgs[i].tool_calls.map((t: any) => t.id);
        const got: string[] = [];
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "tool") got.push(msgs[j++].tool_call_id);
        assert.deepEqual(got, need);
      }
    }
  };
  let m = anthropicToOpenai({ model: "m", messages: [{ role: "user", content: "go" }, assistantCalls("call_1"), { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "rejected" }, { type: "text", text: "no" }] }] }).messages;
  adjacency(m);
  assert.deepEqual(m[m.length - 1], { role: "user", content: "no" });
  m = anthropicToOpenai({ model: "m", messages: [{ role: "user", content: "go" }, assistantCalls("call_1", "call_2"), { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] }] }).messages;
  adjacency(m);
  assert.deepEqual(m.filter((x: any) => x.role === "tool").map((x: any) => x.tool_call_id), ["call_1", "call_2"]);
});

test("provider registry resolves by type and defaults to anthropic", () => {
  assert.equal(resolveProvider("openai_compat").type, "openai_compat");
  assert.equal(resolveProvider(undefined).type, "anthropic");
  assert.deepEqual(registeredTypes().sort(), ["anthropic", "codex_oauth", "cursor_agent", "openai_compat"]);
});

test("validateConfig flags missing url, placeholder id, force_1m", () => {
  const r = validateConfig({ force_1m: true, models: [{ name: "A", api: "openai" }, { name: "B", id: "gpt-4o" }] } as Config);
  assert.ok(r.errors.some((e) => e.includes("'A'") && e.includes("url")), "openai without url");
  assert.ok(r.warnings.some((w) => w.includes("gpt-4o")), "non-claude id warned");
  assert.ok(r.warnings.some((w) => w.includes("force_1m")), "force_1m warning");
});

// ── integration tests ───────────────────────────────────────────────────────

test("healthz reports ok + codex helper", async () => {
  const h = (await (await fetch(`${proxyBase}/healthz`)).json()) as any;
  assert.equal(h.ok, true);
  assert.equal(h.codex_helper, true);
});

test("/v1/models merges upstream + custom; [1m] is opt-in", async () => {
  const data = ((await (await fetch(`${proxyBase}/v1/models`)).json()) as any).data as Array<{ id: string }>;
  const ids = data.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-4-8"), "upstream model present");
  assert.ok(ids.includes("claude-opus-4-8[1m]"), "opt-in (1m:true) variant present");
  assert.ok(ids.includes("claude-minimax-m3[1m]"), "force variant present");
  assert.ok(!ids.includes("claude-minimax-m3"), "force suppresses the bare id");
  assert.ok(!ids.includes("claude-mock[1m]"), "1m:false opts out");
  assert.ok(!ids.includes("claude-retry[1m]"), "no 1m flag → no variant (opt-in default)");
});

test("UltraCode envelope is forced on passthrough", async () => {
  await postMessages({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  assert.equal(seenAnth.output_config.effort, "xhigh");
  assert.equal(seenAnth.thinking.type, "adaptive");
  assert.ok(seenAnth.max_tokens >= 64000);
  const sys = seenAnth.system;
  const hasReminder = typeof sys === "string" ? sys.includes("Ultracode is on:") : sys.some((b: any) => (b.text || "").includes("Ultracode is on:"));
  assert.ok(hasReminder);
  assert.ok(!(seenAnthHeaders["anthropic-beta"] || "").includes(CONTEXT_1M_BETA), "no 1M beta without [1m]");
});

test("[1m] suffix → strips suffix AND guarantees the 1M beta header on passthrough", async () => {
  await postMessages({ model: "claude-opus-4-8[1m]", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  assert.equal(seenAnth.model, "claude-opus-4-8", "suffix stripped before upstream");
  assert.ok((seenAnthHeaders["anthropic-beta"] || "").includes(CONTEXT_1M_BETA), "1M beta injected");
});

test("incoming 1M beta is honored + preserved alongside other betas", async () => {
  await postMessages({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, { "anthropic-beta": `${CONTEXT_1M_BETA},prompt-caching-2024-07-31` });
  const beta = seenAnthHeaders["anthropic-beta"] || "";
  assert.ok(beta.includes(CONTEXT_1M_BETA) && beta.includes("prompt-caching-2024-07-31"));
});

test("openai_compat streaming tool-call → Anthropic tool_use (+ caps/headers/body/${ENV})", async () => {
  const out = await (
    await postMessages({
      model: "claude-mock",
      max_tokens: 50,
      stream: true,
      tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "weather in paris?" }],
    })
  ).text();
  assert.equal(seenOai.tools[0].function.name, "get_weather");
  assert.equal(seenOai.tool_choice, "auto");
  assert.equal(seenOai.max_tokens, 1234, "slot max_output_tokens cap honored");
  assert.equal(seenOai.reasoning_split, true, "route body param merged");
  assert.equal(seenOaiHeaders["x-test-ua"], "ccmodel/test", "custom header forwarded");
  assert.equal(seenOaiHeaders["authorization"], "Bearer secret123", "${ENV} key wrapped + reached backend");
  assert.ok(out.includes('"type":"tool_use"') && out.includes('"name":"get_weather"'));
  assert.ok(out.includes("input_json_delta") && out.includes("Paris"));
  assert.ok(out.includes('"stop_reason":"tool_use"') && out.includes("Hello ") && out.includes("world"));
});

test("[1m] on an openai_compat backend → clean backend id, native 1M", async () => {
  const out = await (await postMessages({ model: "claude-minimax-m3[1m]", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(seenOai.model, "MiniMax-M3", "suffix stripped to the backend id");
  assert.equal(seenOai.max_tokens, 64000);
  assert.ok(out.includes("ok-1m"));
});

test("empty turn is auto-retried → recovered", async () => {
  retryHits = 0;
  const out = await (await postMessages({ model: "claude-retry", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(retryHits, 2);
  assert.ok(out.includes("recovered"));
});

test("validateConfig requires a model for codex/cursor backends", () => {
  const r = validateConfig({ models: [{ name: "C", api: "codex" }, { name: "D", api: "cursor" }, { name: "E", api: "codex", model: "gpt-5.5" }] } as Config);
  assert.ok(r.errors.some((e) => e.includes("'C'") && e.includes("model")), "codex without model errors");
  assert.ok(r.errors.some((e) => e.includes("'D'") && e.includes("model")), "cursor without model errors");
  assert.ok(!r.errors.some((e) => e.includes("'E'")), "codex with a model is fine");
});

test("openai_compat with no key sends no Authorization (no fake Bearer)", async () => {
  await postMessages({ model: "claude-nokey", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
  assert.equal(seenOai.model, "nokey-model");
  assert.equal(seenOaiHeaders["authorization"], undefined, "no Authorization header when no key is configured");
});
