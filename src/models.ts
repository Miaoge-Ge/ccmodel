/**
 * GET /v1/models discovery: merge Anthropic's real model list with the user's
 * custom models, and auto-advertise `[1m]` companion variants so the 1M-context
 * option shows up in the /model picker for any backend.
 *
 * Claude Code only keeps discovered ids matching /^(claude|anthropic)/i, so the
 * variant id (`<id>[1m]`) inherits the base id's prefix and passes that filter.
 */
import type { ModelConfig } from "./types.js";
import { ONE_MILLION, STANDARD_CONTEXT, parseModelId, withOneMSuffix } from "./model1m.js";

export interface DiscoveryModel {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  /** Context-window hint (forward-looking; harmless if ignored). */
  context_window?: number;
}

function wants1mVariant(m: ModelConfig, advertiseAll: boolean): boolean {
  if (parseModelId(m.id).want1m) return false; // already a [1m] id
  if (m.context_1m === false) return false;
  if (m.context_1m === true || m.context_1m === "variant" || m.context_1m === "force") return true;
  return advertiseAll;
}

/**
 * Expand configured models into the discovery list: each base model, plus a
 * `<id>[1m]` companion when 1M is enabled for it (per-model flag or the global
 * `advertise_1m_variants`). Force-1m models are advertised ONLY as their [1m]
 * variant (the base id always behaves as 1M anyway).
 */
export function expandModels(models: ModelConfig[], advertiseAll: boolean): DiscoveryModel[] {
  const out: DiscoveryModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, ctx?: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      type: "model",
      id,
      display_name: name,
      created_at: "2025-01-01T00:00:00Z",
      ...(ctx ? { context_window: ctx } : {}),
    });
  };

  for (const m of models) {
    const name = m.display_name || m.id;
    const forced = m.context_1m === true || m.context_1m === "force";
    const baseCtx = m.context_window;
    if (!forced) {
      push(m.id, name, baseCtx ?? STANDARD_CONTEXT);
    }
    if (wants1mVariant(m, advertiseAll) || forced) {
      const vid = withOneMSuffix(m.id);
      // 1M variants are named with a plain `[1m]` suffix (matching the id).
      push(vid, `${name}[1m]`, ONE_MILLION);
    }
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
