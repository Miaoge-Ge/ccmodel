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
> Add `[1m]` to any model and it **actually reaches a 1,000,000-token context
> window** — no silent fallback to 200K. The proxy injects the
> `anthropic-beta: context-1m-2025-08-07` header on every request that needs it,
> even when Claude Code drops it on the way in (a real, recurring bug in
> subagents, the `--model` flag, and gateway routes). See
> **[docs/ONE_MILLION_CONTEXT.md](docs/ONE_MILLION_CONTEXT.md)**.

## Why this exists

Two things, on top of stock Claude Code:

1. **UltraCode on any model.** At the API boundary, "UltraCode" is just
   `effort=xhigh` + adaptive thinking + a big `max_tokens` + one system reminder
   — there's no secret model. ccmodel puts that envelope on every request and
   forwards it to whatever backend you pick.
2. **A 1M context that doesn't lie.** Claude Code's `[1m]` suffix is supposed to
   give you 1M tokens, but the beta header that actually unlocks it gets dropped
   in several code paths, so you quietly cap at 200K. ccmodel sits exactly where
   it can re-add the header on every request — so `[1m]` means 1M.

Your normal Claude Code install is left untouched (session-scoped `--settings` +
env only).

## What you need

- **Node.js 18+** (`node --version`). The proxy uses only Node built-ins at
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
model you want in `/model`. Only `name` is required; everything else is inferred:

| You write | The proxy infers |
|-----------|------------------|
| `name` (required) | the `/model` display name **and** the id `claude-<slug(name)>` (Claude Code only keeps `claude`/`anthropic` ids) |
| `url` | the **backend kind**: `…/anthropic` → passthrough, anything else → OpenAI-compatible. Omit for real Claude. |
| `key` | the auth header — wrapped as `Authorization: Bearer <key>` (or pass a literal `"x-api-key: …"`). Omit to reuse Claude Code's own credential. |
| *(nothing)* | a `<name>[1m]` 1M-context variant, advertised automatically |

### Verified example: DeepSeek (Anthropic-native endpoint)

DeepSeek ships a native Anthropic-compatible endpoint, so a `…/anthropic` url is
auto-detected as a **passthrough** — tools, streaming and the model's `thinking`
blocks all work as-is. Verified live end-to-end (non-stream, stream, and `[1m]`):

```jsonc
{
  "models": [
    { "name": "DeepSeek V4 Flash", "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}", "model": "deepseek-v4-flash" },
    { "name": "DeepSeek V4 Pro",   "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}", "model": "deepseek-v4-pro" }
  ]
}
```

Put keys inline (gitignored) or as `${ENV_VAR}` — export them or drop them into a
gitignored `ccmodel.env` the launcher loads.

### Backend kinds

The kind is inferred from `url` (or forced with `api`):

| Kind            | When it's used                                                  | Needs |
|-----------------|-----------------------------------------------------------------|-------|
| Anthropic passthrough | no `url` (real Claude), or a `…/anthropic` url (DeepSeek, any Anthropic-compatible endpoint) | nothing, or `key`/`url` |
| OpenAI-compatible | any other `url` — MiniMax, OpenRouter, OpenAI, Ollama, local llama.cpp (tools translated both ways) | `key` (a local server can omit it) |
| Codex (`"api": "codex"`) | GPT-5.5 via a ChatGPT/Codex login (no API key)            | `codex login` once |
| Cursor (`"api": "cursor"`) | Cursor Composer (experimental)                          | `cursor-agent login` |

### Per-model options

All optional, alongside `name`/`url`/`key`/`model`:

- `api` — force the backend kind (`anthropic` / `openai` / `codex` / `cursor`)
  instead of inferring it from `url`.
- `id` — override the auto id (must start with `claude`/`anthropic`, else it's prefixed).
- `1m` — `true` (default: advertise a `[1m]` variant), `"force"` (always 1M), or
  `false` (no variant).
- `effort` — set a different effort level, or `false` to stop forcing effort on a
  strict backend.
- `max_output_tokens` — completion cap for OpenAI-compatible backends (default 8192).
- `body` — extra params merged into each OpenAI-compatible request (e.g. MiniMax-M3
  `{ "reasoning_split": true }`). `${VARS}` expanded.
- `headers` — extra request headers (`${VARS}` expanded).

### Turning on 1M context

| Want | Do this |
|------|---------|
| 1M only when *you* pick it | Pick the **`<model>[1m]`** entry in `/model` — advertised automatically for every model. |
| Skip the `[1m]` variant for a model | `"1m": false` on that entry. |
| 1M *always* for one model | `"1m": "force"` (advertises only the `[1m]` pick). |
| 1M *always*, everywhere | Top-level `"force_1m": true` (only if every backend supports it). |

Full detail: [docs/ONE_MILLION_CONTEXT.md](docs/ONE_MILLION_CONTEXT.md).

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

File-by-file map: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

## Develop / test

```bash
npm run build     # tsc -> dist/
npm test          # build + run the offline self-test (node:test, no network/keys)
npm run doctor    # validate environment + config, then run the self-test
```

The self-test (23 cases, all offline) covers discovery + `[1m]` variant
advertisement, the UltraCode envelope, the 1M beta-header guarantee, per-model
effort overrides, the provider registry, config validation + normalization,
Anthropic⇄OpenAI tool translation, the strict-backend tool-adjacency fix, and
empty-turn retry.

## Docs

Every doc is bilingual — **English** and **简体中文**.

| Doc | EN | 中文 |
|-----|----|----|
| Usage reference (commands, recipes, env vars) | [USAGE.md](docs/USAGE.md) | [中文](docs/USAGE.zh-CN.md) |
| The `[1m]` 1M-context guarantee | [ONE_MILLION_CONTEXT.md](docs/ONE_MILLION_CONTEXT.md) | [中文](docs/ONE_MILLION_CONTEXT.zh-CN.md) |
| Mechanism + architecture + file map | [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) | [中文](docs/HOW_IT_WORKS.zh-CN.md) |
| Setup guide | [SETUP.md](docs/SETUP.md) | [中文](docs/SETUP.zh-CN.md) |
| Add a backend to `/model` | [ADD_A_MODEL.md](docs/ADD_A_MODEL.md) | [中文](docs/ADD_A_MODEL.zh-CN.md) |
| Troubleshooting | [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | [中文](docs/TROUBLESHOOTING.zh-CN.md) |
| AI install/config runbook | [AGENTS.md](AGENTS.md) | [中文](AGENTS.zh-CN.md) |

## License

MIT — see [LICENSE](LICENSE). Unofficial, community project; not affiliated with
Anthropic, OpenAI, DeepSeek, or any provider. You are responsible for complying
with the terms of whatever accounts you route through it.
