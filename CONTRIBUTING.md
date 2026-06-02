# Contributing to ccmodel

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve ccmodel. It's a small, dependency-light TypeScript/Node
proxy; the bar is high-signal changes that keep it that way.

## Setup

```bash
npm install        # installs dev deps and builds dist/
npm run doctor     # validates the environment + config, runs the self-test
```

Requires **Node.js 20+**. The runtime uses only Node built-ins; the dev toolchain
is TypeScript, ESLint, Prettier, and `node:test`.

## The development loop

```bash
npm run build         # tsc -> dist/
npm test              # build + run the offline self-test (no network/keys)
npm run test:coverage # same, with V8 coverage
npm run lint          # eslint .
npm run format        # prettier --write .   (format:check to verify)
```

All four — build, test, lint, format-check — must pass before a PR. CI runs them
on Node 20/22/24 × Linux/Windows.

## Project layout

The source is layered (see [docs/MANUAL.md §9](docs/MANUAL.md#9-architecture-and-file-map)):

- `src/config/` — load + normalize + validate the config.
- `src/core/` — env/`${VAR}`, ids, logging, runtime types, `which`.
- `src/net/` — the HTTP client + header/SSE/Anthropic emitters.
- `src/pipeline/` — the UltraCode envelope, `[1m]`, discovery, translation, retry.
- `src/providers/` — one module per backend, resolved via the registry.

Adding a backend = one module implementing `Provider` + registering it in
`src/providers/registry.ts`.

## Tests

Tests live in `test/`:

- `test/unit/*.test.ts` — one file per module.
- `test/integration.test.ts` — end-to-end against an in-process mock backend.
- `test/helpers/harness.ts` — shared mock + proxy harness (not a test itself).

Add unit tests next to the module you change, and an integration assertion if the
behavior is observable end-to-end. Everything must stay **offline** — no real keys
or network in the suite.

## Conventions

- TypeScript `strict` is on; keep it clean (`npm run build` is the type-check).
- Match the surrounding style; Prettier (printWidth 140) is the source of truth.
- Comments explain **why**, not what. Keep them where the existing code keeps them.
- Never commit `config.jsonc` or `ccmodel.env` (both are gitignored — they hold
  keys). Never log a credential; the logger redacts common shapes, but don't rely
  on that as a license to log secrets.

## Pull requests

- Keep PRs focused; one concern per PR.
- Update `CHANGELOG.md` (Unreleased section) and the docs (EN **and** zh-CN — the
  project keeps both in sync) when behavior or config changes.
- Describe what you verified (which `npm` scripts, any live run).
