/**
 * GET /v1/models discovery: merge Anthropic's real model list with the user's
 * custom models so both show up in the /model picker.
 *
 * Claude Code only keeps discovered ids matching /^(claude|anthropic)/i, which is
 * why every custom id is normalized to a `claude-…` form upstream (and a `[1m]`
 * variant id inherits that prefix, so it passes the same filter).
 */
import type { DiscoveryModel } from "../config/types.js";

type Json = Record<string, unknown>;
function isRecord(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merge the discovery models into an upstream /v1/models response body (or a
 * fresh skeleton), appending any ids not already present.
 */
export function mergeModelsResponse(upstream: unknown, custom: DiscoveryModel[]): Json {
  const base: Json = isRecord(upstream) ? upstream : { data: [], has_more: false, first_id: null, last_id: null };
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
