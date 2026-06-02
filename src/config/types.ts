/** Shared types for the ccmodel proxy. */

/** Backend kinds. */
export type RouteType = "anthropic" | "openai_compat" | "codex_oauth" | "cursor_agent";

/**
 * Per-route override of the UltraCode envelope (for a strict backend that
 * rejects Anthropic-specific fields). Unset fields fall back to the global.
 */
export interface EnvelopeOverride {
  effort?: string | false;
  thinking?: boolean;
  reminder?: boolean;
  max_tokens?: number;
}

/**
 * A single user-facing model entry — the WHOLE config is just a list of these.
 * Only `model` is required; key + url cover the common case. Everything else is
 * inferred:
 *   - a trailing `[1m]` on `model` marks it as a 1M-context model (guaranteed)
 *   - `id`   auto = `claude-<slug(model)>` (so Claude Code keeps it in /model)
 *   - `api`  auto from `url` (".../anthropic" → passthrough, else openai-compat)
 *   - `key`  auto-wrapped as `Authorization: Bearer <key>` (or a `Header: value`)
 *
 * The simplest possible entry is just `{ "model": "...", "url": "...", "key": "..." }`.
 */
export interface ModelEntry {
  /**
   * Backend model id sent upstream. REQUIRED. A trailing `[1m]` (e.g.
   * `"MiniMax-M3[1m]"`) marks this as a 1M-context model: the suffix is stripped
   * before the id reaches the backend, and the 1M window is guaranteed.
   */
  model: string;
  /** Upstream base URL. Omit for real Claude; `…/anthropic` = passthrough, else OpenAI-compatible. */
  url?: string;
  /** API key (supports ${ENV}). Omit for a login-based (codex) or keyless (local) backend. */
  key?: string;
  /** Display name in /model (defaults to `model`). */
  name?: string;
  /** Force a backend kind instead of inferring from `url` (needed for codex/cursor, which have no url). */
  api?: "anthropic" | "openai" | "codex" | "cursor";
  /** Effort override: a level string, or false to stop forcing effort on this model. */
  effort?: string | false;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  max_output_tokens?: number;
  workspace?: string;
}

/** The whole config file. */
export interface Config {
  host?: string;
  port?: number;
  /** Default Anthropic upstream (for real-Claude passthrough). */
  upstream?: string;
  /** max_tokens floor (default 64000). */
  max_tokens?: number;
  /** Force 1M on every request (only if every backend supports it). */
  force_1m?: boolean;
  models?: ModelEntry[];
}

/** Internal resolved routing slot (post-normalization), keyed by the base model id. */
export interface Slot {
  type?: RouteType;
  model?: string;
  upstream?: string;
  auth?: string;
  headers?: Record<string, string>;
  max_output_tokens?: number;
  body?: Record<string, unknown>;
  workspace?: string;
  /** This entry is a 1M model (its `model` carried `[1m]`) — always guarantee 1M. */
  force1m?: boolean;
  envelope?: EnvelopeOverride;
}

/** A model advertised on GET /v1/models (and in Claude Code's /model picker). */
export interface DiscoveryModel {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  /** Context-window hint (1M for [1m] models, else the standard window). */
  context_window?: number;
}

/** Per-request routing decision from the envelope step. */
export interface Route {
  type?: RouteType;
  upstream?: string;
  auth?: string;
  headers?: Record<string, string>;
  max_output_tokens?: number;
  body?: Record<string, unknown>;
  workspace?: string;
  want1m?: boolean;
}

/** Internal event vocabulary shared by every backend path. */
export type InternalEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id?: string | null; name: string; arguments: string }
  | { type: "usage"; input_tokens?: number; output_tokens?: number }
  | { type: "error"; message: string; status?: number };

export type EventFactory = () => AsyncGenerator<InternalEvent>;

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface OpenAIBody {
  model?: string;
  messages: OpenAIMessage[];
  stream: boolean;
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
}
