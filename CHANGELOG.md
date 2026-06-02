# Changelog

All notable changes to ccmodel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] — 2026-06-02

### Changed

- **The UltraCode envelope is now scoped by backend kind.** The Workflow system
  reminder and the `thinking` field are injected only for Anthropic-family
  backends; `output_config.effort` is kept for Anthropic and Codex (which maps it
  to a reasoning effort) but dropped for OpenAI-compatible/cursor. Third-party
  models are no longer shipped a Claude-specific reminder they can't act on — no
  wasted tokens, no irrelevant instruction. The `max_tokens` floor is unchanged.
- **Node baseline is now 20+** (Node 18 is EOL). CI matrix: 20 / 22 / 24. The test
  runner enumerates files explicitly (`scripts/test.mjs`) rather than relying on
  `node --test` glob expansion, which only exists from Node 21.

### Added

- **Graceful shutdown / connection draining** — on SIGINT/SIGTERM the proxy now
  stops accepting connections, frees idle keep-alive sockets, lets in-flight
  requests (including streaming turns) finish, and only force-closes stragglers
  after a grace window (`UC_SHUTDOWN_GRACE_MS`, default 10 s) — instead of a blunt
  1.5 s force-exit.
- **Observability** — in-process metrics (requests by kind/status, errors, 1M
  count, latency avg/max, uptime) exposed as a `metrics` snapshot on `/healthz`
  and in Prometheus text format on a new `GET /metrics` endpoint.
- **Inbound body size cap** (`UC_MAX_BODY_BYTES`, default 64 MiB) — the proxy
  returns `413 request_too_large` instead of buffering an unbounded upload.

- **Connection pooling** — the upstream HTTP client now uses shared keep-alive
  agents (http + https), reusing sockets instead of a TCP+TLS handshake per
  request. A real latency win on streaming/subagent workloads.
- **Log secret-redaction** — `Bearer` tokens, `authorization`/`x-api-key` header
  values, and `sk-…`/`sk-ant-…` key shapes are masked before anything is written
  to the log file or stderr.
- **CLI** — `--version` / `--help` (and `-v` / `-h`) on `ccmodel-proxy`.
- **Clear bind errors** — `EADDRINUSE` / `EACCES` print an actionable message and
  exit 1 instead of an unhandled throw.
- **Tooling** — ESLint (flat config, typescript-eslint) + Prettier +
  `.editorconfig`; `npm run lint` / `format` / `format:check` / `test:coverage`.
  CI runs lint + format-check before build/test.
- **Tests** — the monolithic `test/proxy.test.ts` is split into per-module suites
  under `test/unit/*` plus an end-to-end `test/integration.test.ts` (shared
  `test/helpers/harness.ts`), with new coverage for config, the `[1m]`/envelope
  pipeline, the SSE parser, the HTTP client, empty-turn retry, the Codex/Cursor
  helpers, the Anthropic emitters, metrics, draining, and a concurrency check.
  **32 → 139 cases; line coverage ~81% → ~90%.**

## [1.2.0]

### Changed

- **Simplified config schema.** A model entry is now just
  `{ "model", "url", "key" }`. 1M context is opt-in via a **`[1m]` suffix** on the
  `model` id (e.g. `"MiniMax-M3[1m]"`) — the only 1M switch. One entry maps to
  exactly one advertised `/model` pick.
- **Streamlined normalization.** `normalizeModels()` now produces routing slots +
  discovery models directly (removing the old `ModelEntry → Slot + ModelConfig →
  DiscoveryModel` triple representation and the `context_1m` tri-state; slots now
  carry a plain `force1m` boolean).

### Removed

- The per-entry `"1m": true | "force" | false` field (replaced by the `[1m]`
  suffix) and the `id` override (the auto `claude-<slug(model)>` id is always
  used). `name` is now an optional display label.

## [1.1.0]

- Baseline: UltraCode envelope on any model, a reliable `[1m]` 1M-context
  guarantee, `/model` discovery, and the anthropic / openai_compat / codex /
  cursor providers.
