/**
 * Shared test harness: builders + an in-process mock backend + a live proxy.
 * Imported by the unit and integration suites so the mock isn't duplicated.
 *
 * Nothing here is a test itself (the filename has no `.test.` segment, so the
 * `dist/test/**​/*.test.js` runner never executes it directly).
 */
import { createServer as createMock, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createServer, type ProxyContext } from "../../src/server.js";
import { normalizeModels } from "../../src/config/config.js";
import type { EnvelopeSettings } from "../../src/pipeline/envelope.js";
import type { Config } from "../../src/config/types.js";

/** The default UltraCode envelope settings used across the suites. */
export const SETTINGS: EnvelopeSettings = {
  forceEffort: "xhigh",
  forceThinking: true,
  maxTokensFloor: 64000,
  injectReminder: true,
  force1m: false,
};

/** Build a minimal /v1/messages body for the envelope transform tests. */
export function msg(model: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...extra }));
}

/** Listen on an ephemeral port and resolve it. */
export function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** Build a ProxyContext from a Config, for direct createServer() use. */
export function buildCtx(cfg: Config, upstream: string): ProxyContext {
  const settings: EnvelopeSettings = {
    forceEffort: "xhigh",
    forceThinking: true,
    maxTokensFloor: Number(cfg.max_tokens) || 64000,
    injectReminder: true,
    force1m: cfg.force_1m === true,
  };
  const { slotMap, discoveryModels } = normalizeModels(cfg.models);
  return { upstream, settings, slotMap, modelMap: {}, discoveryModels };
}

/** Captured state from the mock backend, inspected by the integration tests. */
export interface MockState {
  seenOai: any;
  seenOaiHeaders: Record<string, string>;
  seenAnth: any;
  seenAnthHeaders: Record<string, string>;
  retryHits: number;
  /** The model id the backend saw on a forwarded count_tokens request (null if none). */
  seenCountModel: string | null;
}

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

/**
 * A mock that speaks both the OpenAI Chat Completions and Anthropic Messages
 * wire formats, recording what it received so tests can assert on it.
 */
export function createMockBackend(state: MockState): Server {
  const lower = (req: IncomingMessage) => Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));

  return createMock((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url || "").split("?")[0] || "";
    if (req.method === "GET" && path.endsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ type: "model", id: "claude-opus-4-8", display_name: "Opus" }] }));
      return;
    }
    void readJson(req).then((body) => {
      if (path.endsWith("/v1/chat/completions")) {
        state.seenOai = body;
        state.seenOaiHeaders = lower(req);
        const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (body.model === "retry-model") {
          state.retryHits += 1;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (state.retryHits === 1) {
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
        sse({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":' } }] } }],
        });
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] });
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (path.endsWith("/v1/messages/count_tokens")) {
        state.seenCountModel = typeof body.model === "string" ? body.model : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 99 }));
        return;
      }
      if (path.endsWith("/v1/messages")) {
        state.seenAnth = body;
        state.seenAnthHeaders = lower(req);
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
  });
}

export interface Harness {
  proxyBase: string;
  mockBase: string;
  state: MockState;
  post(body: unknown, extraHeaders?: Record<string, string>): Promise<Response>;
  get(path: string): Promise<Response>;
  close(): void;
}

/** The model list shared by the integration suite. */
export function integrationConfig(mockBase: string): Config {
  return {
    upstream: mockBase,
    max_tokens: 64000,
    models: [
      { model: "claude-opus-4-8", api: "anthropic" },
      {
        model: "MiniMax-M3[1m]",
        api: "openai",
        url: mockBase + "/v1",
        key: "${MOCK_KEY}",
        max_output_tokens: 64000,
        body: { reasoning_split: true },
      },
      {
        model: "mock-model",
        api: "openai",
        url: mockBase + "/v1",
        key: "${MOCK_KEY}",
        max_output_tokens: 1234,
        headers: { "X-Test-UA": "ccmodel/test" },
        body: { reasoning_split: true },
      },
      { model: "retry-model", api: "openai", url: mockBase + "/v1", key: "${MOCK_KEY}" },
      { model: "nokey-model", api: "openai", url: mockBase + "/v1" },
    ],
  };
}

/** Boot a mock backend + a proxy in front of it; returns helpers + a close(). */
export async function startHarness(cfg?: Config): Promise<Harness> {
  process.env.MOCK_KEY = "secret123";
  const state: MockState = { seenOai: null, seenOaiHeaders: {}, seenAnth: null, seenAnthHeaders: {}, retryHits: 0, seenCountModel: null };
  const mockServer = createMockBackend(state);
  const mockPort = await listen(mockServer);
  const mockBase = `http://127.0.0.1:${mockPort}`;

  const proxyServer = createServer(buildCtx(cfg ?? integrationConfig(mockBase), mockBase));
  const proxyPort = await listen(proxyServer);
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  return {
    proxyBase,
    mockBase,
    state,
    post: (body, extraHeaders = {}) =>
      fetch(`${proxyBase}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-ant-dummy", ...extraHeaders },
        body: JSON.stringify(body),
      }),
    get: (path) => fetch(`${proxyBase}${path}`),
    close: () => {
      mockServer.close();
      proxyServer.close();
    },
  };
}
