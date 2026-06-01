/**
 * Config validation. Returns structured errors (things that will misbehave) and
 * warnings (things to double-check). Used at server startup to surface problems
 * loudly, and available to the doctor.
 */
import type { Config, RouteType } from "./types.js";
import { parseModelId } from "./model1m.js";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const KNOWN_TYPES: RouteType[] = ["anthropic", "openai_compat", "codex_oauth", "cursor_agent"];
const PLACEHOLDER = /REPLACE_WITH|YOUR_|your-/;

export function validateConfig(cfg: Config): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const models = Array.isArray(cfg.models) ? cfg.models : [];
  const routes = cfg.routes && typeof cfg.routes === "object" ? cfg.routes : {};

  const seen = new Set<string>();
  for (const m of models) {
    const id = m?.id;
    if (!id || typeof id !== "string") {
      errors.push("a model entry is missing a string 'id'");
      continue;
    }
    if (!/^(claude|anthropic)/i.test(id)) {
      errors.push(`model '${id}' will be dropped by Claude Code — id must start with 'claude' or 'anthropic'`);
    }
    if (seen.has(id)) warnings.push(`duplicate model id '${id}'`);
    seen.add(id);
    const base = parseModelId(id).baseId;
    if (!(id in routes) && !(base in routes)) errors.push(`model '${id}' has no matching route`);
  }

  for (const [name, route] of Object.entries(routes)) {
    if (!route || typeof route !== "object") {
      errors.push(`route '${name}' is not an object`);
      continue;
    }
    const type = (route.type || "anthropic") as RouteType;
    if (!KNOWN_TYPES.includes(type)) errors.push(`route '${name}': unknown type '${String(route.type)}'`);
    if (type === "openai_compat" && !route.upstream) errors.push(`route '${name}': openai_compat requires 'upstream'`);
    if (type === "openai_compat" && !route.model) {
      warnings.push(`route '${name}': no 'model' set — the claude-* alias will be sent upstream`);
    }
    if (typeof route.auth === "string" && PLACEHOLDER.test(route.auth) && !route.auth.includes("${")) {
      warnings.push(`route '${name}': auth still looks like a placeholder (${route.auth})`);
    }
  }

  const p = cfg.proxy || {};
  if (typeof p.listen_port === "number" && (p.listen_port < 1 || p.listen_port > 65535)) {
    errors.push(`proxy.listen_port ${p.listen_port} is out of range`);
  }
  if (p.force_1m) {
    warnings.push("proxy.force_1m is on — EVERY request uses 1M context; ensure all backends support it");
  }

  return { errors, warnings };
}
