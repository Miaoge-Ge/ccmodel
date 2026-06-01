/**
 * Offline end-to-end + unit tests for the ccmodel proxy. Runs entirely against
 * an in-process mock backend — no real API keys, no network.
 *
 * Build + run:  npm test   (tsc && node --test dist/test/)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createMock, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createServer, type ProxyContext } from "../src/server.js";
import { routesToSlots, modelsFromConfig, parseConfigText, stripJsonc } from "../src/config.js";
import { expandModels } from "../src/models.js";
import { parseModelId, ensure1mBetaHeader, headerRequests1m, CONTEXT_1M_BETA } from "../src/model1m.js";
import { transformMessagesBody, type EnvelopeSettings } from "../src/envelope.js";
import { anthropicToOpenai } from "../src/translate.js";
import { resolveProvider, registeredTypes } from "../src/providers/registry.js";
import { validateConfig } from "../src/validate.js";
import type { Config } from "../src/types.js";

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
    const body = JSON.stringify({ data: [{ type: "model", id: "claude-opus-4-8", display_name: "Opus" }] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
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
        // Exercise the plain-JSON parse branch (used by the [1m] minimax test).
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "ok-1m" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
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
      res.end(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
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
  const proxyCfg = cfg.proxy || {};
  const settings: EnvelopeSettings = {
    forceEffort: "xhigh",
    forceThinking: true,
    maxTokensFloor: Number(proxyCfg.max_tokens_floor) || 64000,
    injectReminder: true,
    force1m: proxyCfg.force_1m === true,
  };
  const models = modelsFromConfig(cfg.models);
  return {
    upstream,
    settings,
    slotMap: routesToSlots(cfg.routes),
    modelMap: {},
    discoveryModels: expandModels(models, proxyCfg.advertise_1m_variants === true || settings.force1m),
    customModels: models,
  };
}

before(async () => {
  process.env.MOCK_KEY = "secret123";
  mockServer = createMock(mockHandler);
  const mockPort = await listen(mockServer);
  mockBase = `http://127.0.0.1:${mockPort}`;

  const cfg: Config = {
    proxy: { anthropic_upstream: mockBase, max_tokens_floor: 64000, advertise_1m_variants: true },
    models: [
      { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      { id: "claude-minimax-m3", display_name: "MiniMax-M3", context_1m: "force" },
      { id: "claude-mock", display_name: "Mock", context_1m: false },
      { id: "claude-retry", display_name: "Retry" },
    ],
    routes: {
      "claude-opus-4-8": { model: "claude-opus-4-8", auth: "passthrough" },
      "claude-minimax-m3": {
        type: "openai_compat",
        model: "MiniMax-M3",
        upstream: mockBase + "/v1",
        auth: "Bearer ${MOCK_KEY}",
        max_output_tokens: 64000,
        context_1m: "force",
        body: { reasoning_split: true },
      },
      "claude-mock": {
        type: "openai_compat",
        model: "mock-model",
        upstream: mockBase + "/v1",
        auth: "Bearer ${MOCK_KEY}",
        max_output_tokens: 1234,
        headers: { "X-Test-UA": "ccmodel/test" },
        body: { reasoning_split: true },
      },
      "claude-retry": { type: "openai_compat", model: "retry-model", upstream: mockBase + "/v1", auth: "Bearer ${MOCK_KEY}" },
    },
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
  assert.deepEqual(parseModelId(""), { baseId: "", want1m: false });
});

test("ensure1mBetaHeader adds the beta and preserves existing betas", () => {
  const h1 = ensure1mBetaHeader({});
  assert.equal(h1["anthropic-beta"], CONTEXT_1M_BETA);

  const h2 = ensure1mBetaHeader({ "Anthropic-Beta": "prompt-caching-2024-07-31" });
  assert.ok(h2["anthropic-beta"]!.includes("prompt-caching-2024-07-31"));
  assert.ok(h2["anthropic-beta"]!.includes(CONTEXT_1M_BETA));
  assert.equal(h2["Anthropic-Beta"], undefined, "old-cased header removed to avoid dupes");

  const h3 = ensure1mBetaHeader({ "anthropic-beta": CONTEXT_1M_BETA });
  assert.equal(h3["anthropic-beta"], CONTEXT_1M_BETA, "no duplicate when already present");
});

test("headerRequests1m detects the beta under any casing", () => {
  assert.equal(headerRequests1m({ "anthropic-beta": `foo,${CONTEXT_1M_BETA}` }), true);
  assert.equal(headerRequests1m({ "Anthropic-Beta": CONTEXT_1M_BETA }), true);
  assert.equal(headerRequests1m({ "anthropic-beta": "prompt-caching-2024-07-31" }), false);
  assert.equal(headerRequests1m({}), false);
});

test("stripJsonc removes comments and trailing commas but not string contents", () => {
  const src = `{
    // line comment
    "url": "http://x/y", /* block */
    "note": "a // b /* c */ d",
    "arr": [1, 2,],
  }`;
  const obj = JSON.parse(stripJsonc(src));
  assert.equal(obj.url, "http://x/y");
  assert.equal(obj.note, "a // b /* c */ d");
  assert.deepEqual(obj.arr, [1, 2]);
});

test("expandModels generates [1m] variants per policy", () => {
  const models = modelsFromConfig([
    { id: "claude-a", display_name: "A" },
    { id: "claude-b", display_name: "B", context_1m: "force" },
    { id: "claude-c", display_name: "C", context_1m: false },
  ]);
  const ids = expandModels(models, true).map((m) => m.id);
  assert.ok(ids.includes("claude-a"));
  assert.ok(ids.includes("claude-a[1m]"), "advertiseAll adds a variant");
  assert.ok(ids.includes("claude-b[1m]"), "force advertises only the [1m] variant");
  assert.ok(!ids.includes("claude-b"), "force suppresses the bare id");
  assert.ok(ids.includes("claude-c"));
  assert.ok(!ids.includes("claude-c[1m]"), "context_1m:false opts out of the variant");
  // The variant must carry the 1M context-window hint.
  const variant = expandModels(models, true).find((m) => m.id === "claude-a[1m]")!;
  assert.equal(variant.context_window, 1_000_000);
});

test("transformMessagesBody strips [1m], sets the envelope, flags want1m", () => {
  const settings: EnvelopeSettings = { forceEffort: "xhigh", forceThinking: true, maxTokensFloor: 64000, injectReminder: true, force1m: false };
  const slotMap = routesToSlots({ "claude-x": { model: "backend-x", upstream: "https://up", auth: "passthrough" } });
  const raw = Buffer.from(JSON.stringify({ model: "claude-x[1m]", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  const { body, route } = transformMessagesBody(raw, {}, slotMap, {}, settings);
  const out = JSON.parse(body.toString());
  assert.equal(out.model, "backend-x", "suffix stripped + routed to backend id");
  assert.equal(out.output_config.effort, "xhigh");
  assert.equal(out.thinking.type, "adaptive");
  assert.ok(out.max_tokens >= 64000);
  assert.equal(route.want1m, true);
});

test("anthropicToOpenai keeps rejected/partial tool calls valid (issue #3)", () => {
  const assistantCalls = (...ids: string[]) => ({
    role: "assistant",
    content: [{ type: "text", text: "ok" }, ...ids.map((i) => ({ type: "tool_use", id: i, name: "t", input: {} }))],
  });
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

  // (a) rejected with a comment + a tool_result present → comment AFTER the tool reply
  let m = anthropicToOpenai({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      assistantCalls("call_1"),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "rejected" }, { type: "text", text: "no, do it differently" }] },
    ],
  }).messages;
  adjacency(m);
  assert.deepEqual(m[m.length - 1], { role: "user", content: "no, do it differently" });

  // (b) rejected with NO tool_result → stub synthesized
  m = anthropicToOpenai({
    model: "m",
    messages: [{ role: "user", content: "go" }, assistantCalls("call_1"), { role: "user", content: [{ type: "text", text: "nah" }] }],
  }).messages;
  adjacency(m);
  assert.ok(m.some((x: any) => x.role === "tool" && x.tool_call_id === "call_1"));

  // (c) parallel calls, only one answered → the other gets a stub
  m = anthropicToOpenai({
    model: "m",
    messages: [{ role: "user", content: "go" }, assistantCalls("call_1", "call_2"), { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] }],
  }).messages;
  adjacency(m);
  assert.deepEqual(m.filter((x: any) => x.role === "tool").map((x: any) => x.tool_call_id), ["call_1", "call_2"]);
});

test("provider registry resolves by type and defaults to anthropic", () => {
  assert.equal(resolveProvider("openai_compat").type, "openai_compat");
  assert.equal(resolveProvider("codex_oauth").type, "codex_oauth");
  assert.equal(resolveProvider("cursor_agent").type, "cursor_agent");
  assert.equal(resolveProvider(undefined).type, "anthropic");
  assert.deepEqual(registeredTypes().sort(), ["anthropic", "codex_oauth", "cursor_agent", "openai_compat"]);
});

test("per-route envelope override opts out of effort/thinking/reminder", () => {
  const slotMap = routesToSlots({
    "claude-strict": { model: "backend", upstream: "https://up", auth: "passthrough", envelope: { effort: false, thinking: false, reminder: false } },
  });
  const raw = Buffer.from(JSON.stringify({ model: "claude-strict", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  const out = JSON.parse(transformMessagesBody(raw, {}, slotMap, {}, SETTINGS).body.toString());
  assert.equal(out.output_config, undefined, "effort suppressed");
  assert.equal(out.thinking, undefined, "thinking suppressed");
  const sys = out.system;
  const hasReminder = sys && (typeof sys === "string" ? sys.includes("Ultracode is on:") : sys.some((b: any) => (b.text || "").includes("Ultracode is on:")));
  assert.ok(!hasReminder, "reminder suppressed");
  assert.ok(out.max_tokens >= 64000, "max_tokens floor still applied");
});

test("validateConfig flags bad ids, missing routes, openai_compat upstream, force_1m", () => {
  const r = validateConfig({
    proxy: { force_1m: true },
    models: [{ id: "gpt-4o" }, { id: "claude-x" }],
    routes: { "claude-y": { type: "openai_compat" } },
  } as Config);
  assert.ok(r.errors.some((e) => e.includes("gpt-4o")), "non-claude id flagged");
  assert.ok(r.errors.some((e) => e.includes("claude-x") && e.includes("no matching route")), "unrouted model flagged");
  assert.ok(r.errors.some((e) => e.includes("claude-y") && e.includes("upstream")), "openai_compat without upstream flagged");
  assert.ok(r.warnings.some((w) => w.includes("force_1m")), "force_1m warning");
});

// ── integration tests ───────────────────────────────────────────────────────

test("healthz reports ok + codex helper", async () => {
  const h = (await (await fetch(`${proxyBase}/healthz`)).json()) as any;
  assert.equal(h.ok, true);
  assert.equal(h.codex_helper, true);
});

test("/v1/models merges upstream + custom + [1m] variants", async () => {
  const data = ((await (await fetch(`${proxyBase}/v1/models`)).json()) as any).data as Array<{ id: string }>;
  const ids = data.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-4-8"), "upstream model present");
  assert.ok(ids.includes("claude-opus-4-8[1m]"), "advertiseAll variant present");
  assert.ok(ids.includes("claude-minimax-m3[1m]"), "force variant present");
  assert.ok(!ids.includes("claude-minimax-m3"), "force suppresses the bare id");
  assert.ok(!ids.includes("claude-mock[1m]"), "context_1m:false opts out");
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
  await postMessages(
    { model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    { "anthropic-beta": `${CONTEXT_1M_BETA},prompt-caching-2024-07-31` },
  );
  const beta = seenAnthHeaders["anthropic-beta"] || "";
  assert.ok(beta.includes(CONTEXT_1M_BETA));
  assert.ok(beta.includes("prompt-caching-2024-07-31"), "existing betas preserved");
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
  assert.equal(seenOaiHeaders["authorization"], "Bearer secret123", "${ENV} auth reached backend");
  assert.ok(out.includes('"type":"tool_use"') && out.includes('"name":"get_weather"'));
  assert.ok(out.includes("input_json_delta") && out.includes("Paris"));
  assert.ok(out.includes('"stop_reason":"tool_use"'));
  assert.ok(out.includes("Hello ") && out.includes("world"));
});

test("[1m] on an openai_compat backend → clean backend id, native 1M (no beta needed)", async () => {
  const out = await (await postMessages({ model: "claude-minimax-m3[1m]", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(seenOai.model, "MiniMax-M3", "suffix stripped to the backend id");
  assert.equal(seenOai.max_tokens, 64000, "max_output_tokens honored");
  assert.ok(out.includes("ok-1m"), "plain-JSON response relayed");
});

test("empty turn is auto-retried → recovered", async () => {
  retryHits = 0;
  const out = await (await postMessages({ model: "claude-retry", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(retryHits, 2, "1 empty turn + 1 retry");
  assert.ok(out.includes("recovered"));
});
