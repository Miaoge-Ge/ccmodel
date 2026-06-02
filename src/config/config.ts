/** Load + normalize the config file (a single list of model entries). */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, DiscoveryModel, ModelEntry, RouteType, Slot } from "./types.js";
import { expandEnv } from "../core/env.js";
import { ONE_MILLION, STANDARD_CONTEXT, parseModelId, withOneMSuffix } from "../pipeline/model1m.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This compiles to dist/src/config/config.js, so the repo root is three up. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

/** Strip JSONC: `//` and `/* *​/` comments and trailing commas (strings intact). */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let inStr = false;
  let quote = "";

  const nextSignificant = (from: number): string => {
    let j = from;
    while (j < n) {
      const c = text[j]!;
      const next = j + 1 < n ? text[j + 1]! : "";
      if (/\s/.test(c)) {
        j += 1;
        continue;
      }
      if (c === "/" && next === "/") {
        j += 2;
        while (j < n && text[j] !== "\n") j += 1;
        continue;
      }
      if (c === "/" && next === "*") {
        j += 2;
        while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j += 1;
        j = j < n ? j + 2 : j;
        continue;
      }
      return c;
    }
    return "";
  };

  while (i < n) {
    const c = text[i]!;
    const next = i + 1 < n ? text[i + 1]! : "";
    if (inStr) {
      out += c;
      if (c === "\\") {
        if (i + 1 < n) {
          out += next;
          i += 2;
          continue;
        }
      } else if (c === quote) {
        inStr = false;
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i = i < n ? i + 2 : i;
      continue;
    }
    if (c === "," && ["}", "]"].includes(nextSignificant(i + 1))) {
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Drop keys starting with `_` (used as inline documentation in config). */
export function stripUnderscoreKeys<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((x) => stripUnderscoreKeys(x)) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!k.startsWith("_")) out[k] = stripUnderscoreKeys(v);
    }
    return out as unknown as T;
  }
  return obj;
}

export function parseConfigText(text: string): Config {
  return stripUnderscoreKeys(JSON.parse(stripJsonc(text))) as Config;
}

export function loadConfig(path: string): Config {
  return parseConfigText(readFileSync(path, "utf-8"));
}

export function defaultConfigPath(): string {
  for (const name of ["config.jsonc", "config.json", "config.example.jsonc", "config.example.json"]) {
    const p = join(REPO_ROOT, name);
    if (existsSync(p)) return p;
  }
  return join(REPO_ROOT, "config.jsonc");
}

// ---- normalization: ModelEntry[] -> routing slots + discovery models --------

const API_TO_TYPE: Record<string, RouteType> = {
  anthropic: "anthropic",
  openai: "openai_compat",
  codex: "codex_oauth",
  cursor: "cursor_agent",
};

/** Turn a display name into a `claude-…`-safe slug. */
export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "model";
}

/** Infer the backend kind from an explicit `api` or the upstream URL. */
export function inferType(url: string | undefined, api: string | undefined): RouteType {
  if (api && API_TO_TYPE[api]) return API_TO_TYPE[api]!;
  if (!url) return "anthropic"; // no url => real Claude passthrough
  if (/\/anthropic(\/|$)/i.test(url)) return "anthropic";
  return "openai_compat";
}

/** Wrap a bare key as a Bearer credential, or pass a "Header: value" form through. */
export function wrapAuth(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const k = key.trim();
  if (!k) return undefined;
  if (/^bearer\s/i.test(k)) return k;
  if (k.includes(":")) return k; // e.g. "x-api-key: sk-..."
  return "Bearer " + k;
}

export interface NormalizedModels {
  /** Routing slots keyed by the base (suffix-free) model id. */
  slotMap: Record<string, Slot>;
  /** Models advertised on GET /v1/models — one per entry. */
  discoveryModels: DiscoveryModel[];
}

/**
 * Normalize the user's model list into routing slots + discovery models. Each
 * entry maps to exactly ONE advertised model:
 *   - `"model": "x"`        → a standard (200K) `claude-<slug(x)>` pick.
 *   - `"model": "x[1m]"`    → a 1M `claude-<slug(x)>[1m]` pick; the suffix is
 *                             stripped before `x` is sent upstream, and 1M is
 *                             guaranteed on every request for it.
 * The slot is keyed by the base id (sans `[1m]`) so the envelope can resolve it
 * whether or not Claude Code kept the suffix on the wire.
 */
export function normalizeModels(entries: ModelEntry[] | undefined): NormalizedModels {
  const slotMap: Record<string, Slot> = {};
  const discoveryModels: DiscoveryModel[] = [];
  const used = new Set<string>();

  for (const e of entries || []) {
    if (!e || typeof e !== "object" || typeof e.model !== "string" || !e.model.trim()) continue;

    // Split a trailing [1m] off the model: the bare id goes upstream; the suffix
    // flags this entry as a guaranteed-1M model.
    const { baseId: backendModel, want1m } = parseModelId(expandEnv(e.model).trim());

    // Discovery id: claude-<slug(model)>, prefixed only when the slug doesn't
    // already start with claude/anthropic (Claude Code keeps only those ids).
    const s = slug(backendModel);
    let baseId = /^(claude|anthropic)/.test(s) ? s : "claude-" + s;
    if (used.has(baseId)) {
      let n = 2;
      while (used.has(`${baseId}-${n}`)) n += 1;
      baseId = `${baseId}-${n}`;
    }
    used.add(baseId);

    const url = e.url ? expandEnv(e.url) : undefined;
    const type = inferType(url, e.api);
    const slot: Slot = {};
    if (type !== "anthropic") slot.type = type;
    if (backendModel) slot.model = backendModel;
    if (url) slot.upstream = url.replace(/\/+$/, "");
    const auth = wrapAuth(expandEnv(e.key));
    if (auth) slot.auth = auth;
    if (e.headers && typeof e.headers === "object") {
      slot.headers = {};
      for (const [k, v] of Object.entries(e.headers)) slot.headers[k] = expandEnv(v);
    }
    if (e.body && typeof e.body === "object") slot.body = e.body;
    if (e.max_output_tokens) slot.max_output_tokens = e.max_output_tokens;
    if (e.workspace) slot.workspace = expandEnv(e.workspace);
    if (want1m) slot.force1m = true;
    if (e.effort !== undefined) slot.envelope = { effort: e.effort };
    slotMap[baseId] = slot;

    discoveryModels.push({
      type: "model",
      id: want1m ? withOneMSuffix(baseId) : baseId,
      display_name: e.name || e.model,
      created_at: "2025-01-01T00:00:00Z",
      context_window: want1m ? ONE_MILLION : STANDARD_CONTEXT,
    });
  }

  return { slotMap, discoveryModels };
}
