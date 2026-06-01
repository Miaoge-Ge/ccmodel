/**
 * The `[1m]` 1M-context machinery — the headline feature of ccmodel.
 *
 * Background (verified against Claude Code's model-config docs, June 2026):
 *   - `[1m]` is Claude Code's own convention for a model's 1M-context variant
 *     (e.g. `opus[1m]`, `claude-opus-4-8[1m]`). Claude Code tracks a 1,000,000
 *     token window for that variant (so it won't auto-compact at 200K) and
 *     *strips the suffix before sending the model id to the provider*.
 *   - The actual wire-level switch that unlocks 1M on the Anthropic Messages API
 *     is the beta header `anthropic-beta: context-1m-2025-08-07`. On Opus 4.6+ /
 *     Sonnet 4.6 the header is redundant-but-accepted (1M is the default); on
 *     older eligible models it is required.
 *   - Real-world bugs drop that header in several code paths (subagent model
 *     resolution, the `--model` flag, some gateway routes), so a model that
 *     *should* have 1M silently caps at 200K.
 *
 * ccmodel's job: make `[1m]` reliable end-to-end. Whatever Claude Code sends, the
 * proxy detects 1M intent, strips the suffix before forwarding, and *guarantees*
 * the beta header reaches Anthropic. For OpenAI-compatible backends (MiniMax-M3
 * etc.) 1M is the backend's native property, so we simply forward the clean id
 * and never cap the input.
 */

/** The Anthropic beta that unlocks the 1M-token context window. */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** The 1M context-window size, surfaced as a discovery hint. */
export const ONE_MILLION = 1_000_000;
/** The standard context-window size for the non-[1m] variant. */
export const STANDARD_CONTEXT = 200_000;

/** Matches a trailing `[1m]` suffix, case-insensitive, tolerant of whitespace. */
const SUFFIX_RE = /\s*\[\s*1m\s*\]\s*$/i;

export interface ParsedModelId {
  /** The model id with any `[1m]` suffix removed. */
  baseId: string;
  /** True if the original id carried a `[1m]` suffix. */
  want1m: boolean;
}

/** Split a `[1m]` suffix off a model id. `"claude-x[1m]"` -> `{baseId:"claude-x", want1m:true}`. */
export function parseModelId(modelId: string | undefined | null): ParsedModelId {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return { baseId: "", want1m: false };
  }
  if (SUFFIX_RE.test(modelId)) {
    return { baseId: modelId.replace(SUFFIX_RE, ""), want1m: true };
  }
  return { baseId: modelId, want1m: false };
}

/** Append a `[1m]` suffix to a base id (idempotent). */
export function withOneMSuffix(baseId: string): string {
  return parseModelId(baseId).want1m ? baseId : `${baseId}[1m]`;
}

/**
 * Does this request already ask for 1M via the Anthropic beta header? Claude
 * Code adds `anthropic-beta: context-1m-2025-08-07` when it resolves a [1m]
 * model itself; detecting it lets us honor 1M even when the suffix was already
 * stripped from the model id upstream.
 */
export function headerRequests1m(headers: Record<string, string | string[] | undefined>): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "anthropic-beta") continue;
    const flat = Array.isArray(v) ? v.join(",") : String(v ?? "");
    if (flat.toLowerCase().includes(CONTEXT_1M_BETA)) return true;
  }
  return false;
}

/**
 * Ensure `anthropic-beta` carries the 1M beta, preserving any betas already
 * present (prompt-caching, etc.). Mutates and returns the headers object. The
 * existing header may be under any casing; we normalize onto the canonical
 * lower-case `anthropic-beta` key and drop the old one to avoid duplicates.
 */
export function ensure1mBetaHeader(headers: Record<string, string>): Record<string, string> {
  let existing = "";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "anthropic-beta") {
      existing = headers[k] ?? "";
      if (k !== "anthropic-beta") delete headers[k];
    }
  }
  const betas = existing
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!betas.some((b) => b.toLowerCase() === CONTEXT_1M_BETA)) {
    betas.push(CONTEXT_1M_BETA);
  }
  headers["anthropic-beta"] = betas.join(",");
  return headers;
}
