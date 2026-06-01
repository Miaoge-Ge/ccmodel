/**
 * Anthropic passthrough provider. Relays the request to an Anthropic-compatible
 * upstream (real Claude by default, or DeepSeek's /anthropic, OpenCode, …). This
 * is also the default provider for any non-/v1/messages request.
 *
 * It is where the 1M guarantee lands: when the request wants 1M, the
 * `context-1m-2025-08-07` beta header is ensured on the way out.
 */
import type { ServerResponse } from "node:http";
import type { Provider, ProviderRequest } from "./provider.js";
import type { UpstreamResponse } from "../http.js";
import { requestUpstream } from "../http.js";
import { forwardRequestHeaders, applyAuthHeader, sendError, HOP_BY_HOP } from "../httpUtil.js";
import { ensure1mBetaHeader } from "../model1m.js";
import { log, vlog } from "../log.js";

export const anthropicProvider: Provider = {
  type: "anthropic",
  async handle({ rt, ctx, res }: ProviderRequest): Promise<void> {
    const upstream = ctx.route.upstream || rt.upstream;
    const url = upstream + ctx.url;
    const fwd = forwardRequestHeaders(ctx.reqHeaders);
    if (ctx.route.auth) applyAuthHeader(fwd, ctx.route.auth);
    for (const [k, v] of Object.entries(ctx.route.headers || {})) fwd[k] = v;
    // The 1M guarantee: ensure the beta header reaches Anthropic even if Claude
    // Code dropped it on the way in.
    if (ctx.route.want1m) ensure1mBetaHeader(fwd);
    if (ctx.body.length) fwd["Content-Length"] = String(ctx.body.length);

    let resp: UpstreamResponse;
    try {
      resp = await requestUpstream({
        url,
        method: ctx.method,
        headers: fwd,
        body: ctx.body.length ? ctx.body : null,
        timeoutMs: 600_000,
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal.aborted) return; // client went away
      log(`[${ctx.id}] upstream error ${String(e)} for ${url}`);
      sendError(res, 502, String(e));
      return;
    }
    const streaming = resp.contentType.includes("text/event-stream");
    await relayResponse(res, resp, streaming, ctx.signal, ctx.id);
  },
};

async function relayResponse(
  res: ServerResponse,
  resp: UpstreamResponse,
  streaming: boolean,
  signal: AbortSignal,
  id: string,
): Promise<void> {
  const status = resp.status || 200;
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(resp.headers)) {
    const kl = k.toLowerCase();
    if (HOP_BY_HOP.has(kl) || kl === "content-length" || kl === "content-encoding") continue;
    if (v !== undefined) headers[k] = v as string | string[];
  }
  if (streaming) {
    headers["Content-Type"] = "text/event-stream";
    headers["Cache-Control"] = "no-cache";
    headers["Connection"] = "close";
    res.writeHead(status, headers);
    try {
      for await (const chunk of resp.chunks()) {
        if (signal.aborted) break;
        res.write(chunk);
      }
    } catch (e) {
      vlog(`[${id}] stream relay ended: ${String(e)}`);
    }
    res.end();
  } else {
    const data = Buffer.from(await resp.text(), "utf-8");
    headers["Content-Length"] = String(data.length);
    res.writeHead(status, headers);
    res.end(data);
  }
}
