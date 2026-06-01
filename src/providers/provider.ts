/**
 * Provider abstraction. Each backend kind (anthropic passthrough, openai_compat,
 * codex_oauth, cursor_agent) is a Provider that knows how to turn one inbound
 * request into an Anthropic response written to `res`. The server resolves a
 * provider from the route type via the registry and calls `handle` — it does not
 * know anything about backends.
 */
import type { ServerResponse } from "node:http";
import type { EventFactory, RouteType } from "../config/types.js";
import type { ProxyContext, RequestContext } from "../core/runtime.js";
import { eventsWithRetry } from "../pipeline/retry.js";
import { streamAnthropicFromEvents, jsonAnthropicFromEvents } from "../net/emit.js";
import { sendError } from "../net/httpUtil.js";

export interface ProviderRequest {
  /** Process-wide runtime (default upstream, settings, …). */
  rt: ProxyContext;
  /** Per-request context (transformed body, route, model id, abort signal, …). */
  ctx: RequestContext;
  res: ServerResponse;
}

export interface Provider {
  readonly type: RouteType;
  handle(req: ProviderRequest): Promise<void>;
}

/**
 * Shared emit path for the event-producing providers (openai_compat / codex /
 * cursor): optionally wrap the event factory in empty-turn retry, then render it
 * as either an Anthropic SSE stream or a single Anthropic JSON message.
 *
 * `retry` defaults to true; cursor_agent opts out because re-running the
 * subprocess on an empty turn is expensive and rarely helps.
 */
export async function emitEvents(
  req: ProviderRequest,
  makeEvents: EventFactory,
  label: string,
  retry = true,
): Promise<void> {
  const events = retry ? eventsWithRetry(makeEvents, label) : makeEvents();
  if (req.ctx.wantStream) await streamAnthropicFromEvents(req.res, events, req.ctx.modelId);
  else await jsonAnthropicFromEvents(req.res, events, req.ctx.modelId, (s, m) => sendError(req.res, s, m));
}
