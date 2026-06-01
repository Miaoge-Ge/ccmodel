/**
 * Shared types for the ccmodel proxy.
 *
 * The config shape is deliberately permissive: unknown keys are ignored and any
 * key starting with `_` is treated as an inline comment, in addition to real
 * JSONC `//` comments.
 */

/** Backend route kinds. Omit `type` (or use "anthropic") for passthrough. */
export type RouteType = "anthropic" | "openai_compat" | "codex_oauth" | "cursor_agent";

/**
 * Per-route override of the UltraCode envelope. Use it for a strict backend that
 * rejects Anthropic-specific fields (e.g. set `"effort": false` to stop sending
 * `output_config.effort`). Any field left unset falls back to the global setting.
 */
export interface EnvelopeOverride {
  /** A string sets effort; `false` disables effort forcing for this route. */
  effort?: string | false;
  /** `false` stops forcing adaptive thinking. */
  thinking?: boolean;
  /** `false` stops injecting the Ultracode reminder. */
  reminder?: boolean;
  /** Override the max_tokens floor for this route. */
  max_tokens?: number;
}

/** A single route entry from config.json `routes`. */
export interface RouteConfig {
  type?: RouteType;
  /** Backend model id sent upstream (the real provider id, not the claude-* alias). */
  model?: string;
  /** Backend base URL. openai_compat: usually ends in /v1 (we append /chat/completions). */
  upstream?: string;
  /** "passthrough" to keep Claude Code's own credential, or a literal header value. */
  auth?: string;
  /** Extra request headers (values support ${VAR}). */
  headers?: Record<string, string>;
  /** Completion cap for openai_compat (default 8192). */
  max_output_tokens?: number;
  /** Extra params merged into the openai_compat request body (values support ${VAR}). */
  body?: Record<string, unknown>;
  /** cursor_agent workspace dir. */
  workspace?: string;
  /**
   * 1M context policy for this route:
   *   - true / "force": always enable 1M (every request, regardless of suffix).
   *   - "variant" (default when advertise_1m_variants is on): advertise a
   *     companion `<id>[1m]` entry; 1M turns on only when that variant is picked.
   *   - false: never auto-enable.
   */
  context_1m?: boolean | "force" | "variant";
  /** Per-route override of the UltraCode envelope (see EnvelopeOverride). */
  envelope?: EnvelopeOverride;
}

/** A model advertised on GET /v1/models so it shows in the /model picker. */
export interface ModelConfig {
  id: string;
  display_name?: string;
  created_at?: string;
  /** Optional context-window hint surfaced to gateway discovery. */
  context_window?: number;
  /** Shorthand: also advertise an `<id>[1m]` variant for this model. */
  context_1m?: boolean | "force" | "variant";
}

export interface ProxyConfig {
  listen_host?: string;
  listen_port?: number;
  anthropic_upstream?: string;
  max_tokens_floor?: number;
  /** Auto-advertise a `<id>[1m]` companion for every configured model. */
  advertise_1m_variants?: boolean;
  /** Force 1M context on every request (use only if every backend supports it). */
  force_1m?: boolean;
}

export interface Config {
  proxy?: ProxyConfig;
  models?: ModelConfig[];
  routes?: Record<string, RouteConfig>;
}

/**
 * A resolved routing slot (post ${ENV} expansion). This is what the request
 * pipeline actually consults; it is derived from RouteConfig.
 */
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

/**
 * The per-request routing decision produced by the envelope step. Empty object
 * means "Anthropic passthrough to the default upstream".
 */
export interface Route {
  type?: RouteType;
  upstream?: string;
  auth?: string;
  headers?: Record<string, string>;
  max_output_tokens?: number;
  body?: Record<string, unknown>;
  workspace?: string;
  /** True when this request should be served with a 1M context window. */
  want1m?: boolean;
}

/**
 * The internal event vocabulary. The openai_compat, codex and cursor paths all
 * yield these so a single Anthropic-SSE emitter can serve every backend.
 */
export type InternalEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id?: string | null; name: string; arguments: string }
  | { type: "usage"; input_tokens?: number; output_tokens?: number }
  | { type: "error"; message: string; status?: number };

/** A zero-arg factory returning a FRESH event stream (used by the retry wrapper). */
export type EventFactory = () => AsyncGenerator<InternalEvent>;

/** OpenAI chat-completions message shape (the subset we emit/consume). */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
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
