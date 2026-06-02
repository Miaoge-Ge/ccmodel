# Changelog

All notable changes to ccmodel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  `test/helpers/harness.ts`), with new coverage for the SSE parser, HTTP client,
  empty-turn retry, cursor stream parsing and `${ENV}` expansion. **32 → 109
  cases.**

### Changed

- **Node baseline is now 20+** (Node 18 is EOL). CI matrix: 20 / 22 / 24.

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

[Unreleased]: https://github.com/
[1.2.0]: https://github.com/
[1.1.0]: https://github.com/
