# ccmodel

**English** · [简体中文](README.zh-CN.md)

**Run Claude Code's UltraCode mode — and a *reliable* `[1m]` 1M-token context —
on any model you already pay for.** Pick it live from the `/model` menu.

```
   Claude Code  ──ANTHROPIC_BASE_URL──▶  ccmodel proxy  ──▶  real Claude / DeepSeek / GPT-5.5 / MiniMax-M3 / …
                    (loopback :8141)        ├─ forces the UltraCode envelope
                                            ├─ GUARANTEES 1M context for [1m] picks
                                            └─ routes each /model pick to its provider
```

ccmodel is a small, dependency-light **TypeScript/Node** proxy. It runs entirely
on Node's built-ins — nothing to install just to run it — and its headline
capability is:

> ### The `[1m]` guarantee
> Pick a configured `[1m]` model and it **actually reaches a 1,000,000-token
> context window** — no silent fallback to 200K. The proxy injects the
> `anthropic-beta: context-1m-2025-08-07` header on every request that needs it,
> even when Claude Code drops it on the way in (a real, recurring bug in
> subagents, the `--model` flag, and gateway routes). See
> **[docs/MANUAL.md](docs/MANUAL.md#6-the-1m-1m-context-guarantee)**.

## Why this exists

Two things, on top of stock Claude Code:

1. **UltraCode on any model.** At the API boundary, "UltraCode" is just
   `effort=xhigh` + adaptive thinking + a big `max_tokens` + one system reminder
   — there's no secret model. ccmodel applies the envelope **per backend kind**,
   not blindly: Anthropic-family backends (real Claude, `…/anthropic`) get the
   full envelope; Codex keeps the effort (mapped to its reasoning effort); and
   OpenAI-compatible/cursor backends are *not* shipped Claude-only fields or the
   Workflow reminder they can't use (no wasted tokens, no irrelevant instruction).
2. **A 1M context that doesn't lie.** Claude Code's `[1m]` suffix is supposed to
   give you 1M tokens, but the beta header that actually unlocks it gets dropped
   in several code paths, so you quietly cap at 200K. ccmodel sits exactly where
   it can re-add the header on every request — so `[1m]` means 1M.

Your normal Claude Code install is left untouched (session-scoped `--settings` +
env only).

## What you need

- **Node.js 20+** (`node --version`). The proxy uses only Node built-ins at
  runtime — nothing to install to *run* it; TypeScript is a dev dependency for
  the build.
- **Claude Code CLI** with UltraCode access (`npm i -g @anthropic-ai/claude-code`).
- **At least one backend credential** — an API key (DeepSeek / MiniMax /
  OpenRouter / a local server …) and/or `codex login` for GPT-5.5. Real Claude
  with `[1m]` needs only your existing login.

One launcher (`bin/ccmodel.mjs`) runs on **Windows, macOS, Linux, and WSL** — no
PowerShell or bash scripts.

## Quick start

```bash
git clone <this-repo> ccmodel && cd ccmodel

# 1. Build + sanity-check (installs dev deps, validates, runs the offline self-test).
npm install
npm run doctor

# 2. Pick your models: copy the example and edit it (config.jsonc is gitignored).
cp config.example.jsonc config.jsonc      # Windows: copy config.example.jsonc config.jsonc

# 3. (optional) Desktop launchers — cross-platform (.lnk / .command / .desktop).
npm run icons

# 4. Launch. Builds on first run, starts the proxy, opens Claude Code.
npm run launch          # == node bin/ccmodel.mjs
#   then type /model and pick a backend. Picks ending in `[1m]` run at 1M.
```

`npm run launch -- --proxy-only` starts just the proxy (leaves it running);
`npm run uninstall` stops it and removes the launchers + session state.

## Configure your models

Everything is in one file: **`config.jsonc`** (copied from
`config.example.jsonc`). It's JSONC — `//` and `/* */` comments and trailing
commas are fine. **The whole config is a single list of models** — one entry per
model you want in `/model`. In the common case an entry is just three fields:

```jsonc
{ "model": "<id>", "url": "<base url>", "key": "<api key>" }
```

Only `model` is required; everything else is inferred:

| You write | The proxy infers |
|-----------|------------------|
| `model` (required) | the backend id sent upstream **and** the `/model` id `claude-<slug(model)>` (Claude Code only keeps `claude`/`anthropic` ids). A trailing **`[1m]`** marks it a 1M model. |
| `url` | the **backend kind**: `…/anthropic` → passthrough, anything else → OpenAI-compatible. Omit for real Claude. |
| `key` | the auth header — wrapped as `Authorization: Bearer <key>` (or pass a literal `"x-api-key: …"`). Omit to reuse Claude Code's own credential. |

**1M is one character.** Add `[1m]` to the model id and that pick runs at a
guaranteed 1,000,000-token window; leave it off for the standard 200K. The suffix
is stripped before the id reaches the backend, so only add it to models that
really support 1M. One entry = one `/model` pick.

### Verified example: DeepSeek (Anthropic-native endpoint)

DeepSeek ships a native Anthropic-compatible endpoint, so a `…/anthropic` url is
auto-detected as a **passthrough** — tools, streaming and the model's `thinking`
blocks all work as-is. Verified live end-to-end for non-stream and stream paths:

```jsonc
{
  "models": [
    { "model": "deepseek-v4-flash", "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" },
    { "model": "deepseek-v4-pro",   "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" }
  ]
}
```

Want a prettier label in the menu? Add an optional `"name": "DeepSeek V4 Pro"`.
Put keys inline (gitignored) or as `${ENV_VAR}` — export them or drop them into a
gitignored `ccmodel.env` the launcher loads.

### Backend kinds

The kind is inferred from `url` (or forced with `api`):

| Kind            | When it's used                                                  | Needs |
|-----------------|-----------------------------------------------------------------|-------|
| Anthropic passthrough | no `url` (real Claude), or a `…/anthropic` url (DeepSeek, any Anthropic-compatible endpoint) | nothing, or `key`/`url` |
| OpenAI-compatible | any other `url` — MiniMax, OpenRouter, OpenAI, Ollama, local llama.cpp (tools translated both ways) | `key` (a local server can omit it) |
| Codex (`"api": "codex"`) | GPT-5.5 via a ChatGPT/Codex login (no API key)            | `codex login` once, plus `"api": "codex"` (no url to infer from) |
| Cursor (`"api": "cursor"`) | Cursor Composer (experimental)                          | `cursor-agent login`, plus `"api": "cursor"` |

### Per-model options

All optional, alongside `model`/`url`/`key`:

- `name` — a prettier display label in `/model` (defaults to `model`).
- `api` — force the backend kind (`anthropic` / `openai` / `codex` / `cursor`)
  instead of inferring it from `url`. Required for codex/cursor (they have no url).
- `effort` — set a different effort level, or `false` to stop forcing effort on a
  strict backend.
- `max_output_tokens` — completion cap for OpenAI-compatible backends (default 8192).
- `body` — extra params merged into each OpenAI-compatible request (e.g. MiniMax-M3
  `{ "reasoning_split": true }`). `${VARS}` expanded.
- `headers` — extra request headers (`${VARS}` expanded).

### Turning on 1M context

| Want | Do this |
|------|---------|
| A 1M pick for one model | Add `[1m]` to its `model` id, e.g. `"model": "MiniMax-M3[1m]"`. |
| Both a 200K *and* a 1M pick | Add two entries — one `"X"` and one `"X[1m]"`. |
| Standard-only model | Leave the `[1m]` suffix off. |
| 1M *always*, everywhere | Top-level `"force_1m": true` (only if every backend supports it). |

A `[1m]` model is guaranteed 1M end-to-end: even if Claude Code drops the beta
header or the suffix on the way in, the proxy re-adds the
`anthropic-beta: context-1m-2025-08-07` header on every request for it. Full
detail: [docs/MANUAL.md](docs/MANUAL.md#6-the-1m-1m-context-guarantee).

## Architecture

```
Claude Code → server.ts (thin HTTP) → envelope/[1m] transform → Provider (by backend kind)
                                                                  ├─ anthropic   (passthrough + 1M beta)
                                                                  ├─ openai_compat (Anthropic⇄OpenAI, tools)
                                                                  ├─ codex_oauth  (GPT-5.5 via login)
                                                                  └─ cursor_agent (Composer, experimental)
```

- **Layered source.** `config/` (load + normalize + validate), `core/` (env, ids,
  logging, runtime types), `net/` (HTTP client + SSE/Anthropic emitters),
  `pipeline/` (the envelope, `[1m]`, discovery, translation, retry), and
  `providers/` (one module per backend).
- **Provider registry.** Each backend is a self-contained `Provider`; the server
  resolves one by backend kind and never touches transport details. Adding a
  backend = one module + registering it.
- **Request pipeline.** A `RequestContext` carries the transformed body, route,
  1M intent, streaming flag, a request id, and an `AbortSignal`.
- **Robustness.** Empty-turn retry, transient connect retry, per-request idle
  timeouts, and downstream-disconnect cancellation (the upstream call is aborted
  when the client goes away).
- **Validation + observability.** Config is validated at startup (errors +
  warnings); `/healthz` reports version, providers, and the 1M policy; verbose
  logs carry a per-request id and timing.

File-by-file map: [docs/MANUAL.md](docs/MANUAL.md#9-architecture-and-file-map).

## Develop / test

```bash
npm run build     # tsc -> dist/
npm test          # build + run the offline self-test (node:test, no network/keys)
npm run doctor    # validate environment + config, then run the self-test
```

The self-test (105 cases, all offline) is split by concern under `test/unit/*`
(config, `[1m]`/discovery, envelope, translate, SSE parsing, HTTP client + header
helpers, empty-turn retry, providers/cursor parsing, `${ENV}` expansion) plus an
end-to-end `test/integration.test.ts` driving a real proxy over an in-process mock
backend (shared setup in `test/helpers/harness.ts`). It covers `[1m]`-suffix
parsing, config normalization + validation, the UltraCode envelope, the 1M
beta-header guarantee (via suffix, per-model force, global flag, and incoming
header), Anthropic⇄OpenAI tool translation, the strict-backend tool-adjacency
fix, and empty-turn retry.

## Docs

The topic docs have been consolidated into one bilingual manual.

| Doc | EN | 中文 |
|-----|----|----|
| System manual: setup, recipes, 1M, env vars, architecture, troubleshooting | [MANUAL.md](docs/MANUAL.md) | [中文](docs/MANUAL.zh-CN.md) |
| Contributing guide | [CONTRIBUTING.md](CONTRIBUTING.md) | [中文](CONTRIBUTING.zh-CN.md) |
| Security policy | [SECURITY.md](SECURITY.md) | [中文](SECURITY.zh-CN.md) |
| Release notes | [CHANGELOG.md](CHANGELOG.md) | — |

## License

MIT — see [LICENSE](LICENSE). Unofficial, community project; not affiliated with
Anthropic, OpenAI, DeepSeek, or any provider. You are responsible for complying
with the terms of whatever accounts you route through it.
