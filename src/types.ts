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
 * Only `name` is required. Everything else is inferred:
 *   - `id`     auto = `claude-<slug(name)>` (so Claude Code keeps it)
 *   - `api`    auto from `url` (".../anthropic" → anthropic, else openai)
 *   - `key`    auto-wrapped as `Authorization: Bearer <key>` (or `Header: value`)
 *   - `1m`     defaults on (a `<id>[1m]` variant is advertised)
 */
export interface ModelEntry {
  /** Display name in /model; also the basis for the auto id. */
  name: string;
  /** Upstream base URL. Omit for real Claude (api.anthropic.com). */
  url?: string;
  /** API key (supports ${ENV}). Omit to pass Claude Code's own credential through. */
  key?: string;
  /** Backend model id sent upstream. */
  model?: string;
  /** Force a backend kind instead of inferring from `url`. */
  api?: "anthropic" | "openai" | "codex" | "cursor";
  /** Override the auto-generated id (must start with claude/anthropic). */
  id?: string;
  /** 1M policy: true (advertise a [1m] variant, default), "force" (always on), false (off). */
  "1m"?: boolean | "force";
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

/** Internal resolved routing slot (post-normalization), keyed by model id. */
export interface Slot {
  type?: RouteType;
  model?: string;
  upstream?: string;
  auth?: string;
  headers?: Record<string, string>;
  max_output_tokens?: number;
  body?: Record<string, unknown>;
  workspace?: string;
  context_1m?: boolean | "force" | "variant";
  envelope?: EnvelopeOverride;
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

/** A normalized model for /v1/models discovery. */
export interface ModelConfig {
  id: string;
  display_name?: string;
  context_window?: number;
  context_1m?: boolean | "force" | "variant";
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
