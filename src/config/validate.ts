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

  const names = new Set<string>();
  for (const e of models) {
    if (!e || typeof e !== "object") {
      errors.push("a model entry is not an object");
      continue;
    }
    if (!e.name || typeof e.name !== "string") {
      errors.push("a model entry is missing a string 'name'");
      continue;
    }
    if (names.has(e.name)) warnings.push(`duplicate model name '${e.name}'`);
    names.add(e.name);

    if (e.api && !KNOWN_API.includes(e.api)) {
      errors.push(`model '${e.name}': unknown api '${e.api}' (use anthropic | openai | codex | cursor)`);
    }
    if (e.url !== undefined && typeof e.url !== "string") {
      errors.push(`model '${e.name}': 'url' must be a string`);
    }
    if (e.id && !/^(claude|anthropic)/i.test(e.id)) {
      warnings.push(`model '${e.name}': id '${e.id}' will be prefixed with 'claude-' (Claude Code only keeps claude/anthropic ids)`);
    }
    const type = inferType(typeof e.url === "string" ? e.url : undefined, e.api);
    if (type === "openai_compat") {
      if (!e.url) errors.push(`model '${e.name}': an openai backend needs a 'url' (the provider's base, usually ending /v1)`);
      if (!e.model) warnings.push(`model '${e.name}': no 'model' set — the auto claude-* id will be sent upstream`);
    }
    if ((type === "codex_oauth" || type === "cursor_agent") && !e.model) {
      const ex = type === "codex_oauth" ? "gpt-5.5" : "composer-2.5";
      errors.push(`model '${e.name}': a ${e.api} backend needs a 'model' (e.g. '${ex}') — without it the auto claude-* id is sent upstream and the backend rejects it`);
    }
    if (typeof e.key === "string" && PLACEHOLDER.test(e.key) && !e.key.includes("${")) {
      warnings.push(`model '${e.name}': key looks like a placeholder — put your real key there`);
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
