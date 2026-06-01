/**
 * OpenAI-compatible provider. Translates the Anthropic request to an OpenAI
 * Chat Completions request, POSTs it to `upstream + /chat/completions`, and
 * renders the response back as Anthropic (tools both ways, SSE re-emitted).
 */
import type { Provider, ProviderRequest } from "./provider.js";
import { emitEvents } from "./provider.js";
import { anthropicToOpenai } from "../pipeline/translate.js";
import { oaiResponseToEvents } from "../net/sse.js";
import { requestUpstream } from "../net/http.js";
import { applyAuthHeader, sendError } from "../net/httpUtil.js";
import { expandEnv } from "../core/env.js";
import { log, vlog } from "../core/log.js";

type Json = Record<string, unknown>;

export const openaiProvider: Provider = {
  type: "openai_compat",
  async handle(req: ProviderRequest): Promise<void> {
    const { rt, ctx, res } = req;
    const anth = ctx.parsed;
    if (!anth) {
      sendError(res, 400, "openai_compat: missing request body");
      return;
    }
    const oaiBody = anthropicToOpenai(anth) as unknown as Json;
    // UltraCode forces a large Anthropic max_tokens; many OpenAI backends reject
    // a completion cap that big. Use a safe default unless the slot overrides it.
    const cap = ctx.route.max_output_tokens;
    oaiBody.max_tokens = cap ? Number(cap) : 8192;
    // Per-route extra body params (e.g. MiniMax-M3 reasoning_split). ${ENV}-expanded.
    if (ctx.route.body && typeof ctx.route.body === "object") {
      for (const [k, v] of Object.entries(ctx.route.body)) oaiBody[k] = typeof v === "string" ? expandEnv(v) : v;
    }
    const payload = Buffer.from(JSON.stringify(oaiBody), "utf-8");

    const upstream = (ctx.route.upstream || rt.upstream).replace(/\/+$/, "");
    const url = upstream + "/chat/completions";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: ctx.wantStream ? "text/event-stream" : "application/json",
      "Content-Length": String(payload.length),
    };
    // Use the configured key. With no key we send NO Authorization — a local
    // server (Ollama/llama.cpp/LM Studio) doesn't need one, and a remote backend
    // returns a clear 401. We never forward Claude Code's own credential to a
    // third-party OpenAI backend.
    if (ctx.route.auth) applyAuthHeader(headers, ctx.route.auth);
    for (const [k, v] of Object.entries(ctx.route.headers || {})) headers[k] = v;

    vlog(`[${ctx.id}] openai_compat -> ${url} model=${ctx.modelId} stream=${ctx.wantStream}`);

    const makeEvents = async function* () {
      let resp;
      try {
        resp = await requestUpstream({ url, method: "POST", headers, body: payload, timeoutMs: 600_000, signal: ctx.signal });
      } catch (e) {
        if (ctx.signal.aborted) return;
        log(`[${ctx.id}] openai_compat upstream error ${String(e)} for ${url}`);
        yield { type: "error" as const, status: 502, message: `openai_compat upstream error: ${String(e)}` };
        return;
      }
      if (resp.status >= 400) {
        let detail = "";
        try {
          detail = (await resp.text()).slice(0, 800);
        } catch {
          /* ignore */
        }
        log(`[${ctx.id}] openai_compat upstream HTTP ${resp.status} for ${url}: ${detail}`);
        yield { type: "error" as const, status: resp.status, message: `openai_compat upstream ${resp.status}: ${detail}` };
        return;
      }
      yield* oaiResponseToEvents(resp);
    };

    await emitEvents(req, makeEvents, `openai_compat ${ctx.modelId}`);
  },
};
