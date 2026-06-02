/** The HTTP proxy: health, /v1/models discovery, and provider dispatch. */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Route } from "./config/types.js";
import type { ProxyContext, RequestContext } from "./core/runtime.js";
import { transformMessagesBody } from "./pipeline/envelope.js";
import { mergeModelsResponse } from "./pipeline/models.js";
import { requestUpstream } from "./net/http.js";
import { forwardRequestHeaders, readBody, sendJson, BodyTooLargeError } from "./net/httpUtil.js";
import { resolveProvider, registeredTypes } from "./providers/registry.js";
import { codexAuthAvailable } from "./providers/codexClient.js";
import { randomHex } from "./core/ids.js";
import { log, vlog } from "./core/log.js";
import { recordRequest, recordWant1m, requestKind, snapshot, prometheus } from "./core/metrics.js";

export type { ProxyContext } from "./core/runtime.js";

type Json = Record<string, unknown>;

export function createServer(ctx: ProxyContext): Server {
  return createHttpServer((req, res) => {
    const startedAt = Date.now();
    const path = (req.url || "").split("?")[0] || "";
    // Record once the response is fully sent — captures the real status + latency
    // for every path (health, models, messages, streaming) without threading state.
    res.on("finish", () => recordRequest(requestKind(path), res.statusCode || 0, Date.now() - startedAt));
    handle(req, res, ctx).catch((e) => {
      log(`unhandled handler error: ${String(e)}`);
      if (!res.headersSent) sendJson(res, 502, { type: "error", error: { type: "proxy_error", message: String(e) } });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, rt: ProxyContext): Promise<void> {
  const method = req.method || "GET";
  const path = (req.url || "").split("?")[0] || "";

  // Abort any upstream call (messages OR /v1/models) if the client disconnects.
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });

  // ---- metrics (Prometheus text) ----
  if (path === "/metrics") {
    const body = Buffer.from(prometheus(), "utf-8");
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Content-Length": String(body.length) });
    res.end(body);
    return;
  }

  // ---- health ----
  if (path === "/healthz" || path === "/health") {
    sendJson(res, 200, {
      ok: true,
      version: rt.version ?? "dev",
      upstream: rt.upstream,
      effort: rt.settings.forceEffort,
      max_tokens_floor: rt.settings.maxTokensFloor,
      inject_reminder: rt.settings.injectReminder,
      force_1m: rt.settings.force1m,
      providers: registeredTypes(),
      codex_helper: true,
      codex_login: codexAuthAvailable(),
      custom_models: rt.discoveryModels.map((m) => ({ id: m.id, display_name: m.display_name })),
      slots: Object.fromEntries(
        Object.entries(rt.slotMap).map(([k, v]) => [
          k,
          { type: v.type || "anthropic", model: v.model, upstream: v.upstream || "(default)" },
        ]),
      ),
      metrics: snapshot(),
    });
    return;
  }

  // ---- GET /v1/models discovery ----
  if (method === "GET" && path.endsWith("/v1/models")) {
    if (await handleModels(req, res, rt, ac.signal)) return;
  }

  // ---- build the request context ----
  const id = randomHex(6);

  let body: Buffer;
  if (method === "GET" || method === "HEAD") {
    body = Buffer.alloc(0);
  } else {
    try {
      body = await readBody(req, rt.maxBodyBytes ?? 0);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        log(`[${id}] rejected oversized body (> ${e.limit} bytes)`);
        sendJson(res, 413, { type: "error", error: { type: "request_too_large", message: e.message } });
        return;
      }
      throw e;
    }
  }
  let route: Route = {};
  let parsed: Json | null = null;
  let modelId = "";
  let wantStream = false;

  const isMessagesPost = method === "POST" && path.endsWith("/v1/messages");
  const isCountTokens = method === "POST" && path.endsWith("/v1/messages/count_tokens");
  if (isMessagesPost || isCountTokens) {
    // count_tokens needs routing (backend id, stripped [1m], upstream, auth) but
    // NOT the UltraCode envelope — hence skipEnvelope for it.
    const t = transformMessagesBody(body, req.headers, rt.slotMap, rt.modelMap, rt.settings, isCountTokens);
    body = t.body;
    route = t.route;
    try {
      const p = JSON.parse(body.toString("utf-8"));
      if (p && typeof p === "object" && !Array.isArray(p)) {
        parsed = p as Json;
        modelId = typeof parsed.model === "string" ? parsed.model : "";
        wantStream = Boolean(parsed.stream);
      }
    } catch {
      /* leave parsed null */
    }
  }

  // count_tokens to a third-party backend: those endpoints don't implement the
  // Anthropic token-counting API, and forwarding the original (claude-* alias,
  // [1m]-suffixed) id to api.anthropic.com fails with "model not found" — which
  // is what makes /context and /compact error out and stall. Answer locally with
  // a fast estimate instead. Real Claude (no third-party route) still forwards
  // upstream for an exact count, now with the [1m] suffix correctly stripped.
  if (isCountTokens && (route.type !== undefined || route.upstream !== undefined)) {
    vlog(`[${id}] count_tokens (local estimate) model=${modelId || "?"} type=${route.type || "anthropic"}`);
    sendJson(res, 200, { input_tokens: estimateInputTokens(parsed) });
    return;
  }

  const ctx: RequestContext = {
    id,
    method,
    path,
    url: req.url || path,
    reqHeaders: req.headers,
    body,
    parsed,
    route,
    modelId,
    wantStream,
    startedAt: Date.now(),
    signal: ac.signal,
  };

  const provider = resolveProvider(route.type);
  if (isMessagesPost) {
    if (route.want1m) recordWant1m();
    vlog(
      `[${id}] ${method} ${path} model=${modelId || "?"} provider=${provider.type} stream=${wantStream} want1m=${Boolean(route.want1m)}`,
    );
  }
  await provider.handle({ rt, ctx, res });
  if (isMessagesPost) vlog(`[${id}] done in ${Date.now() - ctx.startedAt}ms`);
}

/**
 * A fast, dependency-free estimate of an Anthropic request's input tokens, for
 * count_tokens on backends that don't implement the endpoint. Roughly 4 chars per
 * token over the system prompt, messages, and tools — accurate enough for the
 * /context usage display and /compact's size precheck, and it never blocks on a
 * network round-trip.
 */
export function estimateInputTokens(parsed: Json | null): number {
  if (!parsed) return 0;
  let chars = 0;
  const add = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (v != null) chars += JSON.stringify(v).length;
  };
  add(parsed.system);
  if (Array.isArray(parsed.messages)) for (const m of parsed.messages) add((m as Json)?.content);
  add(parsed.tools);
  return Math.max(1, Math.ceil(chars / 4));
}

async function handleModels(req: IncomingMessage, res: ServerResponse, rt: ProxyContext, signal: AbortSignal): Promise<boolean> {
  if (!rt.discoveryModels.length) return false;
  const fwd = forwardRequestHeaders(req.headers);
  const url = rt.upstream + (req.url || "");
  let upstreamData: unknown = null;
  try {
    const resp = await requestUpstream({ url, method: "GET", headers: fwd, timeoutMs: 30_000, signal });
    if (resp.status < 400) {
      const parsed = JSON.parse(await resp.text());
      if (parsed && typeof parsed === "object") upstreamData = parsed;
    }
  } catch (e) {
    vlog(`/v1/models upstream fetch failed, serving custom-only: ${String(e)}`);
  }
  sendJson(res, 200, mergeModelsResponse(upstreamData, rt.discoveryModels));
  return true;
}
