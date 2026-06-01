/** Load + normalize the config file (a single list of model entries). */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, ModelConfig, ModelEntry, RouteType, Slot } from "./types.js";
import { expandEnv } from "../core/env.js";

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
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
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

// ---- normalization: ModelEntry[] -> internal slots + discovery models -------

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
  slotMap: Record<string, Slot>;
  models: ModelConfig[];
}

/** Expand the user's model list into internal slots + discovery models. */
export function normalizeModels(entries: ModelEntry[] | undefined): NormalizedModels {
  const slotMap: Record<string, Slot> = {};
  const models: ModelConfig[] = [];
  const used = new Set<string>();

  for (const e of entries || []) {
    if (!e || typeof e !== "object" || !e.name || typeof e.name !== "string") continue;

    // id: honor a claude/anthropic id, else derive one from the name (and only
    // add the `claude-` prefix when the slug doesn't already start with it).
    const s = slug(e.id || e.name);
    let id =
      e.id && /^(claude|anthropic)/i.test(e.id)
        ? e.id
        : /^(claude|anthropic)/.test(s)
          ? s
          : "claude-" + s;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);

    const url = e.url ? expandEnv(e.url) : undefined;
    const type = inferType(url, e.api);
    const slot: Slot = {};
    if (type !== "anthropic") slot.type = type;
    if (e.model) slot.model = expandEnv(e.model);
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
    if (e["1m"] !== undefined) slot.context_1m = e["1m"];
    if (e.effort !== undefined) slot.envelope = { effort: e.effort };

    slotMap[id] = slot;
    models.push({
      id,
      display_name: e.name,
      ...(e["1m"] !== undefined ? { context_1m: e["1m"] } : {}),
    });
  }

  return { slotMap, models };
}
