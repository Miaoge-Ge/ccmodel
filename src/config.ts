/** Load + normalize the single config file (proxy / models / routes). */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, ModelConfig, RouteConfig, Slot } from "./types.js";
import { expandEnv } from "./env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root is two levels up from dist/src (or src in dev): dist/src -> repo. */
export const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * Strip JSONC: line comments (`// …`), block comments (`/* … *​/`) and trailing
 * commas, while leaving string contents untouched. Hand-rolled so the loader has
 * zero dependencies.
 */
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
        // copy the escaped char verbatim
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
  // Remove trailing commas: `, }` / `, ]`
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Drop keys starting with `_` (used as inline documentation in config). */
export function stripUnderscoreKeys<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((x) => stripUnderscoreKeys(x)) as unknown as T;
  }
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
  const parsed = JSON.parse(stripJsonc(text));
  return stripUnderscoreKeys(parsed) as Config;
}

export function loadConfig(path: string): Config {
  return parseConfigText(readFileSync(path, "utf-8"));
}

/** Find config.jsonc/json beside the repo root, falling back to the example. */
export function defaultConfigPath(): string {
  for (const name of ["config.jsonc", "config.json", "config.example.jsonc", "config.example.json"]) {
    const p = join(REPO_ROOT, name);
    if (existsSync(p)) return p;
  }
  return join(REPO_ROOT, "config.jsonc");
}

/** routes{} -> resolved slots, expanding ${ENV} in model/upstream/auth/headers. */
export function routesToSlots(routes: Record<string, RouteConfig> | undefined): Record<string, Slot> {
  const out: Record<string, Slot> = {};
  if (!routes || typeof routes !== "object") return out;
  for (const [mid, route] of Object.entries(routes)) {
    if (!route || typeof route !== "object") continue;
    const slot: Slot = {};
    if (route.model) slot.model = expandEnv(route.model);
    if (route.upstream) slot.upstream = expandEnv(route.upstream).replace(/\/+$/, "");
    if (route.auth && route.auth !== "passthrough") slot.auth = expandEnv(route.auth);
    if (route.type) slot.type = route.type;
    if (route.max_output_tokens) slot.max_output_tokens = route.max_output_tokens;
    if (route.workspace) slot.workspace = expandEnv(route.workspace);
    if (route.context_1m !== undefined) slot.context_1m = route.context_1m;
    if (route.envelope && typeof route.envelope === "object") slot.envelope = route.envelope;
    if (route.headers && typeof route.headers === "object") {
      slot.headers = {};
      for (const [k, v] of Object.entries(route.headers)) slot.headers[k] = expandEnv(v);
    }
    if (route.body && typeof route.body === "object") {
      slot.body = route.body; // carried raw; ${ENV} expanded at use-site
    }
    out[mid] = slot;
  }
  return out;
}

/** models[] from config -> normalized model objects (id required). */
export function modelsFromConfig(models: ModelConfig[] | undefined): ModelConfig[] {
  const out: ModelConfig[] = [];
  for (const m of models || []) {
    if (!m || typeof m !== "object") continue;
    if (!m.id || typeof m.id !== "string") continue;
    out.push({
      id: m.id,
      display_name: m.display_name || m.id,
      created_at: m.created_at || "2025-01-01T00:00:00Z",
      ...(m.context_window ? { context_window: m.context_window } : {}),
      ...(m.context_1m !== undefined ? { context_1m: m.context_1m } : {}),
    });
  }
  return out;
}
