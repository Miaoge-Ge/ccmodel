/**
 * GET /v1/models discovery: merge Anthropic's real model list with the user's
 * custom models, and auto-advertise `[1m]` companion variants so the 1M-context
 * option shows up in the /model picker for any backend.
 *
 * Claude Code only keeps discovered ids matching /^(claude|anthropic)/i, so the
 * variant id (`<id>[1m]`) inherits the base id's prefix and passes that filter.
 */
import type { ModelConfig } from "../config/types.js";
import { ONE_MILLION, STANDARD_CONTEXT, parseModelId, withOneMSuffix } from "./model1m.js";

export interface DiscoveryModel {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  /** Context-window hint (forward-looking; harmless if ignored). */
  context_window?: number;
}

/**
 * Should this model get a `<id>[1m]` companion in the picker? ONLY when the user
 * opted in — most models are not 1M-capable, so advertising a [1m] pick for them
 * would be a lie. `true` offers base + [1m]; `"force"` offers [1m] only.
 */
function wants1mVariant(m: ModelConfig): boolean {
  if (parseModelId(m.id).want1m) return false; // already a [1m] id
  return m.context_1m === true || m.context_1m === "force";
}

/**
 * Expand configured models into the discovery list (1M is OPT-IN per model):
 *   - `"1m"` unset / `false` → the base model only, at the standard window.
 *   - `"1m": true`           → the base (standard) AND a `<id>[1m]` (1M) companion.
 *   - `"1m": "force"`        → ONLY the `<id>[1m]` (1M) entry (the base would be 1M too).
 */
export function expandModels(models: ModelConfig[]): DiscoveryModel[] {
  const out: DiscoveryModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, ctx: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ type: "model", id, display_name: name, created_at: "2025-01-01T00:00:00Z", context_window: ctx });
  };

  for (const m of models) {
    const name = m.display_name || m.id;
    if (m.context_1m !== "force") push(m.id, name, m.context_window ?? STANDARD_CONTEXT);
    if (wants1mVariant(m)) push(withOneMSuffix(m.id), `${name}[1m]`, ONE_MILLION);
  }
  return out;
}

type Json = Record<string, unknown>;
function isRecord(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merge the discovery models into an upstream /v1/models response body (or a
 * fresh skeleton), appending any ids not already present.
 */
export function mergeModelsResponse(upstream: unknown, custom: DiscoveryModel[]): Json {
  const base: Json = isRecord(upstream)
    ? upstream
    : { data: [], has_more: false, first_id: null, last_id: null };
  const data: unknown[] = Array.isArray(base.data) ? (base.data as unknown[]) : [];
  base.data = data;
  const existing = new Set<string>();
  for (const m of data) {
    if (isRecord(m) && typeof m.id === "string") existing.add(m.id);
  }
  for (const m of custom) {
    if (!existing.has(m.id)) data.push({ ...m });
  }
  return base;
}
