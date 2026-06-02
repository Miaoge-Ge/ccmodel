/** Environment knobs and ${VAR} expansion. */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Resolved env-driven defaults (config.json can override some of these). */
export const ENV = {
  LISTEN_HOST: process.env.UC_LISTEN_HOST || "127.0.0.1",
  LISTEN_PORT: envInt("UC_LISTEN_PORT", 8141),
  UPSTREAM: (process.env.UC_UPSTREAM || "https://api.anthropic.com").replace(/\/+$/, ""),
  MAX_TOKENS_FLOOR: envInt("UC_MAX_TOKENS", 64000),
  /** Inbound /v1/messages body cap in bytes (0 disables). 64 MiB headroom for 1M-token requests. */
  MAX_BODY_BYTES: envInt("UC_MAX_BODY_BYTES", 64 * 1024 * 1024),
  /** Empty string => leave effort untouched. */
  FORCE_EFFORT: process.env.UC_FORCE_EFFORT ?? "xhigh",
  FORCE_THINKING: envBool("UC_FORCE_THINKING", true),
  INJECT_REMINDER: envBool("UC_INJECT_REMINDER", true),
  /** Force 1M on every request regardless of suffix (UC_FORCE_1M=1). */
  FORCE_1M: envBool("UC_FORCE_1M", false),
  EMPTY_RETRY_ATTEMPTS: envInt("UC_EMPTY_RETRY_ATTEMPTS", 2),
  EMPTY_RETRY_BACKOFF: envFloat("UC_EMPTY_RETRY_BACKOFF", 0.75),
  /** Explicit per-id overrides, e.g. {"claude-opus-4-8":"my-model"}. */
  MODEL_MAP: parseModelMap(process.env.UC_MODEL_MAP),
} as const;

function parseModelMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // ignore malformed maps
  }
  return {};
}

const ENV_TOKEN = "${";

/**
 * Expand ${VAR} references in a string from process.env. Unknown vars expand to
 * "". Non-strings pass through unchanged.
 */
export function expandEnv<T>(value: T): T {
  if (typeof value !== "string" || !value.includes(ENV_TOKEN)) return value;
  let out = "";
  const s = value;
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === "$" && i + 1 < n && s[i + 1] === "{") {
      const end = s.indexOf("}", i + 2);
      if (end !== -1) {
        const name = s.slice(i + 2, end);
        out += process.env[name] ?? "";
        i = end + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out as unknown as T;
}
