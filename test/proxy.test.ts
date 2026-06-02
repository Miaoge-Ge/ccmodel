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
import { mergeModelsResponse } from "../src/pipeline/models.js";
import { parseModelId, withOneMSuffix, ensure1mBetaHeader, headerRequests1m, CONTEXT_1M_BETA } from "../src/pipeline/model1m.js";
import { transformMessagesBody, type EnvelopeSettings } from "../src/pipeline/envelope.js";
import { anthropicToOpenai } from "../src/pipeline/translate.js";
import { resolveProvider, registeredTypes } from "../src/providers/registry.js";
import { validateConfig } from "../src/config/validate.js";
import type { Config } from "../src/config/types.js";

const SETTINGS: EnvelopeSettings = { forceEffort: "xhigh", forceThinking: true, maxTokensFloor: 64000, injectReminder: true, force1m: false };

/** Build a /v1/messages body for the envelope transform tests. */
function msg(model: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...extra }));
}

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
  const { slotMap, discoveryModels } = normalizeModels(cfg.models);
  return { upstream, settings, slotMap, modelMap: {}, discoveryModels };
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
      // Standard passthrough (still honors an explicit [1m] suffix on the wire).
      { model: "claude-opus-4-8", api: "anthropic" },
      // 1M openai-compatible: the [1m] suffix → claude-minimax-m3[1m], force1m.
      { model: "MiniMax-M3[1m]", api: "openai", url: mockBase + "/v1", key: "${MOCK_KEY}", max_output_tokens: 64000, body: { reasoning_split: true } },
      // Standard openai-compatible with a per-route cap, header and body param.
      { model: "mock-model", api: "openai", url: mockBase + "/v1", key: "${MOCK_KEY}", max_output_tokens: 1234, headers: { "X-Test-UA": "ccmodel/test" }, body: { reasoning_split: true } },
      // Empty-turn retry fixture.
      { model: "retry-model", api: "openai", url: mockBase + "/v1", key: "${MOCK_KEY}" },
      // Keyless local backend.
      { model: "nokey-model", api: "openai", url: mockBase + "/v1" },
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

// ── unit: [1m] suffix machinery ───────────────────────────────────────────────

test("parseModelId splits the [1m] suffix", () => {
  assert.deepEqual(parseModelId("claude-opus-4-8[1m]"), { baseId: "claude-opus-4-8", want1m: true });
  assert.deepEqual(parseModelId("claude-opus-4-8"), { baseId: "claude-opus-4-8", want1m: false });
  assert.deepEqual(parseModelId("claude-x [1M]"), { baseId: "claude-x", want1m: true });
  assert.deepEqual(parseModelId(""), { baseId: "", want1m: false });
});

test("withOneMSuffix appends [1m] idempotently", () => {
  assert.equal(withOneMSuffix("claude-x"), "claude-x[1m]");
  assert.equal(withOneMSuffix("claude-x[1m]"), "claude-x[1m]");
});

// ── unit: config normalization ────────────────────────────────────────────────

test("normalizeModels: model-only entries infer id, type and auth", () => {
  const { slotMap, discoveryModels } = normalizeModels([
    { model: "deepseek-v4-pro", url: "https://api.deepseek.com/anthropic", key: "sk-x" },
    { model: "MiniMax-M3", url: "https://api.minimax.io/v1", key: "sk-y" },
    { model: "claude-opus-4-8" },
    { model: "gpt-5.5", api: "codex" },
  ]);
  // auto ids (no doubled "claude-" when the model already starts with it)
  assert.ok(slotMap["claude-deepseek-v4-pro"], "deepseek id");
  assert.ok(slotMap["claude-minimax-m3"], "minimax id");
  assert.ok(slotMap["claude-opus-4-8"], "opus id without doubled prefix");
  assert.ok(slotMap["claude-gpt-5-5"], "gpt id");
  // type inference: /anthropic = passthrough (no type), /v1 = openai_compat, none = anthropic
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.type, undefined);
  assert.equal(slotMap["claude-minimax-m3"]!.type, "openai_compat");
  assert.equal(slotMap["claude-opus-4-8"]!.type, undefined);
  assert.equal(slotMap["claude-gpt-5-5"]!.type, "codex_oauth");
  // the backend model id is preserved verbatim (case intact)
  assert.equal(slotMap["claude-minimax-m3"]!.model, "MiniMax-M3");
  assert.equal(slotMap["claude-gpt-5-5"]!.model, "gpt-5.5");
  // auth wrapping
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.auth, "Bearer sk-x");
  assert.equal(slotMap["claude-opus-4-8"]!.auth, undefined, "no key => passthrough credential");
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.upstream, "https://api.deepseek.com/anthropic");
  // one entry → exactly one advertised model
  assert.equal(discoveryModels.length, 4);
});

test("[1m] suffix on model → 1M discovery id, force1m slot, clean backend id", () => {
  const { slotMap, discoveryModels } = normalizeModels([
    { model: "MiniMax-M3[1m]", url: "https://x/v1", key: "k" },
    { model: "deepseek-v4-pro", url: "https://api.deepseek.com/anthropic", key: "k" },
  ]);
  // slot keyed by the base id; force1m set; backend model is suffix-free
  assert.ok(slotMap["claude-minimax-m3"], "slot keyed by base id (sans [1m])");
  assert.equal(slotMap["claude-minimax-m3"]!.force1m, true);
  assert.equal(slotMap["claude-minimax-m3"]!.model, "MiniMax-M3", "suffix stripped off the backend id");
  assert.equal(slotMap["claude-deepseek-v4-pro"]!.force1m, undefined);
  // discovery: only the [1m] id is advertised, at 1M; the standard model at 200K
  const m1 = discoveryModels.find((m) => m.id === "claude-minimax-m3[1m]");
  assert.ok(m1, "[1m] id advertised");
  assert.equal(m1!.context_window, 1_000_000);
  assert.ok(!discoveryModels.some((m) => m.id === "claude-minimax-m3"), "bare id NOT advertised for a [1m] entry");
  assert.equal(discoveryModels.find((m) => m.id === "claude-deepseek-v4-pro")!.context_window, 200_000);
});

test("normalizeModels: display name defaults to model, override via name", () => {
  const { discoveryModels } = normalizeModels([{ model: "MiniMax-M3[1m]" }, { model: "x", name: "Pretty Name" }]);
  assert.equal(discoveryModels.find((m) => m.id === "claude-minimax-m3[1m]")!.display_name, "MiniMax-M3[1m]");
  assert.equal(discoveryModels.find((m) => m.id === "claude-x")!.display_name, "Pretty Name");
});

test("normalizeModels dedups colliding ids and skips entries with no model", () => {
  const { discoveryModels } = normalizeModels([
    { model: "x", url: "https://a/v1", key: "k" },
    { model: "x", url: "https://b/v1", key: "k" },
    { url: "https://c/v1" } as any,
    { model: "   " },
  ]);
  assert.deepEqual(discoveryModels.map((m) => m.id), ["claude-x", "claude-x-2"]);
});

test("config helpers (slug/inferType/wrapAuth)", () => {
  assert.equal(slug("DeepSeek V4 Pro"), "deepseek-v4-pro");
  assert.equal(slug("GPT-5.5"), "gpt-5-5");
  assert.equal(inferType("https://x/anthropic", undefined), "anthropic");
  assert.equal(inferType("https://x/v1", undefined), "openai_compat");
  assert.equal(inferType(undefined, undefined), "anthropic");
  assert.equal(inferType("https://x/v1", "anthropic"), "anthropic"); // explicit api wins
  assert.equal(inferType(undefined, "codex"), "codex_oauth");
  assert.equal(wrapAuth("sk-x"), "Bearer sk-x");
  assert.equal(wrapAuth("x-api-key: sk-x"), "x-api-key: sk-x");
  assert.equal(wrapAuth(undefined), undefined);
});

test("REPO_ROOT resolves to the repo root, not dist/", () => {
  assert.ok(existsSync(join(REPO_ROOT, "package.json")), "package.json should exist at REPO_ROOT");
  assert.ok(!/[\\/]dist$/.test(REPO_ROOT), "REPO_ROOT must not be the dist/ folder");
});

// ── unit: 1M header machinery ─────────────────────────────────────────────────

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
  assert.equal(headerRequests1m({}), false);
});

// ── unit: JSONC + discovery merge ─────────────────────────────────────────────

test("stripJsonc removes comments and trailing commas but not string contents", () => {
  const obj = JSON.parse(stripJsonc(`{
    // line comment
    "url": "http://x/y", /* block */
    "note": "a // b /* c */ d,}",
    "arr": [1, 2,],
    "nested": {
      "ok": true, // comment between comma and object close
    },
  }`));
  assert.equal(obj.url, "http://x/y");
  assert.equal(obj.note, "a // b /* c */ d,}");
  assert.deepEqual(obj.arr, [1, 2]);
  assert.deepEqual(obj.nested, { ok: true });
});

test("mergeModelsResponse appends custom models, never duplicating ids", () => {
  const { discoveryModels } = normalizeModels([{ model: "claude-opus-4-8" }, { model: "MiniMax-M3[1m]", url: "https://x/v1", key: "k" }]);
  const merged = mergeModelsResponse({ data: [{ id: "claude-opus-4-8", type: "model" }] }, discoveryModels);
  const ids = (merged.data as Array<{ id: string }>).map((m) => m.id);
  assert.deepEqual(ids, ["claude-opus-4-8", "claude-minimax-m3[1m]"], "existing id kept once, custom appended");
  // tolerates a non-object upstream by starting from a skeleton
  const fresh = mergeModelsResponse(null, discoveryModels);
  assert.equal((fresh.data as unknown[]).length, 2);
});

// ── unit: the envelope + [1m] transform ───────────────────────────────────────

test("transformMessagesBody strips [1m], sets the envelope, flags want1m via suffix", () => {
  const { slotMap } = normalizeModels([{ model: "backend-x", api: "anthropic", url: "https://up" }]);
  const { body, route } = transformMessagesBody(msg("claude-backend-x[1m]"), {}, slotMap, {}, SETTINGS);
  const out = JSON.parse(body.toString());
  assert.equal(out.model, "backend-x", "suffix-free backend id sent upstream");
  assert.equal(out.output_config.effort, "xhigh");
  assert.equal(out.thinking.type, "adaptive");
  assert.ok(out.max_tokens >= 64000);
  assert.equal(route.want1m, true);
});

test("a [1m] entry forces 1M even when the suffix was stripped on the wire", () => {
  const { slotMap } = normalizeModels([{ model: "backend[1m]", api: "anthropic", url: "https://up" }]);
  // request arrives WITHOUT the suffix (the documented Claude Code drop-the-suffix bug)
  const r = transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS);
  assert.equal(r.route.want1m, true, "force1m slot guarantees 1M regardless of the suffix");
});

test("a standard model stays 200K but still honors an explicit [1m] suffix", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up" }]);
  assert.equal(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS).route.want1m, false, "base id is NOT forced to 1M");
  assert.equal(transformMessagesBody(msg("claude-backend[1m]"), {}, slotMap, {}, SETTINGS).route.want1m, true, "an explicit [1m] pick is 1M");
});

test("global force_1m and an incoming 1M beta header each flag want1m", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up" }]);
  assert.equal(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, { ...SETTINGS, force1m: true }).route.want1m, true);
  assert.equal(transformMessagesBody(msg("claude-backend"), { "anthropic-beta": CONTEXT_1M_BETA }, slotMap, {}, SETTINGS).route.want1m, true);
});

test("per-model effort:false stops forcing effort (floor still applied)", () => {
  const { slotMap } = normalizeModels([{ model: "backend", api: "anthropic", url: "https://up", effort: false }]);
  const out = JSON.parse(transformMessagesBody(msg("claude-backend"), {}, slotMap, {}, SETTINGS).body.toString());
  assert.equal(out.output_config, undefined, "effort suppressed");
  assert.ok(out.max_tokens >= 64000, "max_tokens floor still applied");
});

test("transformMessagesBody passes a malformed body through untouched", () => {
  const raw = Buffer.from("not json");
  const { body, route } = transformMessagesBody(raw, {}, {}, {}, SETTINGS);
  assert.equal(body.toString(), "not json");
  assert.deepEqual(route, {});
});

// ── unit: Anthropic⇄OpenAI translation ────────────────────────────────────────

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

// ── unit: config validation ───────────────────────────────────────────────────

test("validateConfig requires model, flags unknown api / missing openai url / force_1m", () => {
  const r = validateConfig({ force_1m: true, models: [{} as any, { model: "a", api: "openai" }, { model: "b", api: "bogus" } as any] } as Config);
  assert.ok(r.errors.some((e) => e.includes("missing a string 'model'")), "entry without model errors");
  assert.ok(r.errors.some((e) => e.includes("'a'") && e.includes("url")), "openai without url errors");
  assert.ok(r.errors.some((e) => e.includes("unknown api")), "bad api errors");
  assert.ok(r.warnings.some((w) => w.includes("force_1m")), "force_1m warned");
});

test("validateConfig accepts codex/cursor without url (login-based)", () => {
  const r = validateConfig({ models: [{ model: "gpt-5.5", api: "codex" }, { model: "composer-2.5", api: "cursor" }] } as Config);
  assert.equal(r.errors.length, 0, "no url required for codex/cursor");
});

test("validateConfig warns on placeholder keys and duplicate models", () => {
  const r = validateConfig({ models: [{ model: "x", url: "https://a/v1", key: "YOUR_KEY" }, { model: "x", url: "https://a/v1", key: "k" }] } as Config);
  assert.ok(r.warnings.some((w) => w.includes("placeholder")), "placeholder key warned");
  assert.ok(r.warnings.some((w) => w.includes("duplicate")), "duplicate model warned");
});

// ── integration ───────────────────────────────────────────────────────────────

test("healthz reports ok + codex helper", async () => {
  const h = (await (await fetch(`${proxyBase}/healthz`)).json()) as any;
  assert.equal(h.ok, true);
  assert.equal(h.codex_helper, true);
});

test("/v1/models merges upstream + custom; [1m] is suffix-driven", async () => {
  const data = ((await (await fetch(`${proxyBase}/v1/models`)).json()) as any).data as Array<{ id: string }>;
  const ids = data.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-4-8"), "upstream + standard model present");
  assert.ok(ids.includes("claude-minimax-m3[1m]"), "[1m] entry advertised as a 1M pick");
  assert.ok(!ids.includes("claude-minimax-m3"), "a [1m] entry does NOT also advertise the bare id");
  assert.ok(!ids.includes("claude-opus-4-8[1m]"), "a standard entry does NOT invent a [1m] variant");
  assert.ok(!ids.includes("claude-mock-model[1m]") && !ids.includes("claude-retry-model[1m]"), "no spurious [1m] variants");
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
      model: "claude-mock-model",
      max_tokens: 50,
      stream: true,
      tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "weather in paris?" }],
    })
  ).text();
  assert.equal(seenOai.model, "mock-model", "backend id (not the claude-* alias) sent upstream");
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
  const out = await (await postMessages({ model: "claude-retry-model", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(retryHits, 2);
  assert.ok(out.includes("recovered"));
});

test("openai_compat with no key sends no Authorization (no fake Bearer)", async () => {
  await postMessages({ model: "claude-nokey-model", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
  assert.equal(seenOai.model, "nokey-model");
  assert.equal(seenOaiHeaders["authorization"], undefined, "no Authorization header when no key is configured");
});
