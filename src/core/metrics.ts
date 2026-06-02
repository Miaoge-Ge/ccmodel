/**
 * Tiny in-process metrics. A local proxy doesn't need a full metrics stack, but
 * "how many requests, how slow, how many errors" is the difference between a
 * black box and something you can operate. Exposed as JSON on /healthz and in
 * Prometheus text format on /metrics.
 */

export type RequestKind = "messages" | "count_tokens" | "models" | "health" | "other";

interface Counters {
  startedAt: number;
  total: number;
  byKind: Record<RequestKind, number>;
  byStatusClass: Record<string, number>; // "2xx" | "4xx" | "5xx" | ...
  errors: number; // status >= 500
  want1m: number;
  latencyMsSum: number;
  latencyCount: number;
  maxLatencyMs: number;
}

function fresh(now: number): Counters {
  return {
    startedAt: now,
    total: 0,
    byKind: { messages: 0, count_tokens: 0, models: 0, health: 0, other: 0 },
    byStatusClass: {},
    errors: 0,
    want1m: 0,
    latencyMsSum: 0,
    latencyCount: 0,
    maxLatencyMs: 0,
  };
}

let c = fresh(Date.now());

/** Classify a request path so counters stay low-cardinality. */
export function requestKind(path: string): RequestKind {
  if (path.endsWith("/v1/messages/count_tokens")) return "count_tokens";
  if (path.endsWith("/v1/messages")) return "messages";
  if (path.endsWith("/v1/models")) return "models";
  if (path === "/healthz" || path === "/health" || path === "/metrics") return "health";
  return "other";
}

export function recordRequest(kind: RequestKind, status: number, ms: number): void {
  c.total += 1;
  c.byKind[kind] += 1;
  const cls = `${Math.floor(status / 100)}xx`;
  c.byStatusClass[cls] = (c.byStatusClass[cls] ?? 0) + 1;
  if (status >= 500) c.errors += 1;
  c.latencyMsSum += ms;
  c.latencyCount += 1;
  if (ms > c.maxLatencyMs) c.maxLatencyMs = ms;
}

export function recordWant1m(): void {
  c.want1m += 1;
}

/** For tests: reset all counters. */
export function resetMetrics(now = Date.now()): void {
  c = fresh(now);
}

export interface MetricsSnapshot {
  uptime_ms: number;
  requests_total: number;
  requests_by_kind: Record<RequestKind, number>;
  requests_by_status_class: Record<string, number>;
  errors_total: number;
  want_1m_total: number;
  latency_ms_avg: number;
  latency_ms_max: number;
}

export function snapshot(now = Date.now()): MetricsSnapshot {
  return {
    uptime_ms: now - c.startedAt,
    requests_total: c.total,
    requests_by_kind: { ...c.byKind },
    requests_by_status_class: { ...c.byStatusClass },
    errors_total: c.errors,
    want_1m_total: c.want1m,
    latency_ms_avg: c.latencyCount ? Math.round(c.latencyMsSum / c.latencyCount) : 0,
    latency_ms_max: c.maxLatencyMs,
  };
}

/** Render the snapshot in Prometheus text exposition format. */
export function prometheus(now = Date.now()): string {
  const s = snapshot(now);
  const lines: string[] = [];
  const metric = (name: string, help: string, type: string, value: number, labels = "") => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${labels} ${value}`);
  };
  metric("ccmodel_uptime_seconds", "Proxy uptime in seconds.", "gauge", Math.round(s.uptime_ms / 1000));
  metric("ccmodel_requests_total", "Total HTTP requests handled.", "counter", s.requests_total);
  lines.push("# HELP ccmodel_requests_by_kind_total Requests by kind.");
  lines.push("# TYPE ccmodel_requests_by_kind_total counter");
  for (const [k, v] of Object.entries(s.requests_by_kind)) lines.push(`ccmodel_requests_by_kind_total{kind="${k}"} ${v}`);
  lines.push("# HELP ccmodel_requests_by_status_total Requests by HTTP status class.");
  lines.push("# TYPE ccmodel_requests_by_status_total counter");
  for (const [k, v] of Object.entries(s.requests_by_status_class)) lines.push(`ccmodel_requests_by_status_total{class="${k}"} ${v}`);
  metric("ccmodel_errors_total", "Responses with status >= 500.", "counter", s.errors_total);
  metric("ccmodel_want_1m_total", "Requests that resolved to a 1M-context window.", "counter", s.want_1m_total);
  metric("ccmodel_request_latency_ms_avg", "Mean request latency (ms).", "gauge", s.latency_ms_avg);
  metric("ccmodel_request_latency_ms_max", "Max request latency (ms).", "gauge", s.latency_ms_max);
  return lines.join("\n") + "\n";
}
