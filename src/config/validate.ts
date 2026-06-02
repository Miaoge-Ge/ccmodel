/**
 * Config validation. Returns structured errors (things that will misbehave) and
 * warnings (things to double-check). Surfaced at startup; reused by the doctor.
 */
import type { Config } from "./types.js";
import { inferType } from "./config.js";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const PLACEHOLDER = /REPLACE_WITH|YOUR_|your-|sk-xxx|sk-\.\.\./i;
const KNOWN_API = ["anthropic", "openai", "codex", "cursor"];

export function validateConfig(cfg: Config): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const models = Array.isArray(cfg.models) ? cfg.models : [];

  if (models.length === 0) warnings.push("no models configured — /model will show only built-in Claude models");

  const seen = new Set<string>();
  for (const e of models) {
    if (!e || typeof e !== "object") {
      errors.push("a model entry is not an object");
      continue;
    }
    if (typeof e.model !== "string" || !e.model.trim()) {
      errors.push("a model entry is missing a string 'model'");
      continue;
    }
    const label = e.name || e.model;
    if (seen.has(e.model)) warnings.push(`duplicate model '${e.model}'`);
    seen.add(e.model);

    if (e.api && !KNOWN_API.includes(e.api)) {
      errors.push(`model '${label}': unknown api '${e.api}' (use anthropic | openai | codex | cursor)`);
    }
    if (e.url !== undefined && typeof e.url !== "string") {
      errors.push(`model '${label}': 'url' must be a string`);
    }
    const type = inferType(typeof e.url === "string" ? e.url : undefined, e.api);
    if (type === "openai_compat" && !e.url) {
      errors.push(`model '${label}': an openai backend needs a 'url' (the provider's base, usually ending /v1)`);
    }
    if (typeof e.key === "string" && PLACEHOLDER.test(e.key) && !e.key.includes("${")) {
      warnings.push(`model '${label}': key looks like a placeholder — put your real key there`);
    }
  }

  if (typeof cfg.port === "number" && (cfg.port < 1 || cfg.port > 65535)) {
    errors.push(`port ${cfg.port} is out of range`);
  }
  if (cfg.force_1m) {
    warnings.push("force_1m is on — every request uses 1M context; ensure all backends support it");
  }

  return { errors, warnings };
}
