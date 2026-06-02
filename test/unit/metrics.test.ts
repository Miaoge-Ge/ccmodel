/** Unit tests for the in-process metrics. */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { recordRequest, recordWant1m, requestKind, snapshot, prometheus, resetMetrics } from "../../src/core/metrics.js";

beforeEach(() => resetMetrics());

test("requestKind classifies paths", () => {
  assert.equal(requestKind("/v1/messages"), "messages");
  assert.equal(requestKind("/anthropic/v1/messages"), "messages");
  assert.equal(requestKind("/v1/messages/count_tokens"), "count_tokens", "count_tokens is its own kind, not 'other'");
  assert.equal(requestKind("/anthropic/v1/messages/count_tokens"), "count_tokens");
  assert.equal(requestKind("/v1/models"), "models");
  assert.equal(requestKind("/healthz"), "health");
  assert.equal(requestKind("/metrics"), "health");
  assert.equal(requestKind("/whatever"), "other");
});

test("recordRequest aggregates counts, status classes, latency", () => {
  recordRequest("messages", 200, 10);
  recordRequest("messages", 200, 30);
  recordRequest("models", 503, 5);
  const s = snapshot();
  assert.equal(s.requests_total, 3);
  assert.equal(s.requests_by_kind.messages, 2);
  assert.equal(s.requests_by_kind.models, 1);
  assert.equal(s.requests_by_status_class["2xx"], 2);
  assert.equal(s.requests_by_status_class["5xx"], 1);
  assert.equal(s.errors_total, 1, "5xx counts as an error");
  assert.equal(s.latency_ms_avg, 15, "(10+30+5)/3 = 15");
  assert.equal(s.latency_ms_max, 30);
});

test("recordWant1m + reset", () => {
  recordWant1m();
  recordWant1m();
  assert.equal(snapshot().want_1m_total, 2);
  resetMetrics();
  assert.equal(snapshot().want_1m_total, 0);
  assert.equal(snapshot().requests_total, 0);
});

test("prometheus renders valid exposition text", () => {
  recordRequest("messages", 200, 12);
  recordWant1m();
  const text = prometheus();
  assert.ok(text.includes("# TYPE ccmodel_requests_total counter"));
  assert.ok(text.includes("ccmodel_requests_total 1"));
  assert.ok(text.includes('ccmodel_requests_by_kind_total{kind="messages"} 1'));
  assert.ok(text.includes("ccmodel_want_1m_total 1"));
  assert.ok(text.endsWith("\n"));
});
