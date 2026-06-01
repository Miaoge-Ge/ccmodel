/** The HTTP proxy: health, /v1/models discovery, and provider dispatch. */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Route } from "./config/types.js";
import type { ProxyContext, RequestContext } from "./core/runtime.js";
import { transformMessagesBody } from "./pipeline/envelope.js";
import { mergeModelsResponse } from "./pipeline/models.js";
import { requestUpstream } from "./net/http.js";
import { forwardRequestHeaders, readBody, sendJson } from "./net/httpUtil.js";
import { resolveProvider, registeredTypes } from "./providers/registry.js";
import { codexAuthAvailable } from "./providers/codexClient.js";
import { randomHex } from "./core/ids.js";
import { log, vlog } from "./core/log.js";

export type { ProxyContext } from "./core/runtime.js";

type Json = Record<string, unknown>;

export function createServer(ctx: ProxyContext): Server {
  return createHttpServer((req, res) => {
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
        Object.entries(rt.slotMap).map(([k, v]) => [k, { type: v.type || "anthropic", model: v.model, upstream: v.upstream || "(default)" }]),
      ),
    });
    return;
  }

  // ---- GET /v1/models discovery ----
  if (method === "GET" && path.endsWith("/v1/models")) {
    if (await handleModels(req, res, rt, ac.signal)) return;
  }

  // ---- build the request context ----
  const id = randomHex(6);

  let body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
  let route: Route = {};
  let parsed: Json | null = null;
  let modelId = "";
  let wantStream = false;

  const isMessagesPost = method === "POST" && path.endsWith("/v1/messages");
  if (isMessagesPost) {
    const t = transformMessagesBody(body, req.headers, rt.slotMap, rt.modelMap, rt.settings);
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
    vlog(`[${id}] ${method} ${path} model=${modelId || "?"} provider=${provider.type} stream=${wantStream} want1m=${Boolean(route.want1m)}`);
  }
  await provider.handle({ rt, ctx, res });
  if (isMessagesPost) vlog(`[${id}] done in ${Date.now() - ctx.startedAt}ms`);
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
