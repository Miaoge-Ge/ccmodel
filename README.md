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
commas are fine. Two sections you edit:

- **`models`** — what shows in `/model`. Every `id` **must start with `claude` or
  `anthropic`** (Claude Code filters the rest out).
- **`routes`** — where each id actually goes. The route key matches the model
  `id` (or the base id of a `[1m]` pick — the proxy strips the suffix).

### Verified example: DeepSeek (Anthropic-native endpoint)

DeepSeek ships a native Anthropic-compatible endpoint, so it's a **passthrough**
route — tools, streaming and the model's `thinking` blocks all work as-is. This
is verified live end-to-end (non-stream, stream, and `[1m]`):

```jsonc
{
  "proxy": { "advertise_1m_variants": true },
  "models": [
    { "id": "claude-deepseek-v4-flash", "display_name": "DeepSeek V4 Flash" },
    { "id": "claude-deepseek-v4-pro",   "display_name": "DeepSeek V4 Pro" }
  ],
  "routes": {
    "claude-deepseek-v4-flash": {
      "upstream": "https://api.deepseek.com/anthropic",
      "model": "deepseek-v4-flash",
      "auth": "Bearer ${DEEPSEEK_API_KEY}"
    },
    "claude-deepseek-v4-pro": {
      "upstream": "https://api.deepseek.com/anthropic",
      "model": "deepseek-v4-pro",
      "auth": "Bearer ${DEEPSEEK_API_KEY}"
    }
  }
}
```

Put keys inline (gitignored) or as `${ENV_VAR}` — export them or drop them into a
gitignored `ccmodel.env` the launcher loads.

### Route types

| `type`          | Use for                                                            | Needs |
|-----------------|-------------------------------------------------------------------|-------|
| *(omit)*        | Real Claude / DeepSeek `/anthropic` / any Anthropic-compatible endpoint | nothing, or `auth`/`upstream` |
| `openai_compat` | MiniMax, OpenRouter, OpenAI, Ollama, local llama.cpp — anything speaking OpenAI Chat Completions (tools included) | an API key |
| `codex_oauth`   | GPT-5.5 via a ChatGPT/Codex login (no API key)                   | `codex login` once |
| `cursor_agent`  | Cursor Composer (experimental)                                   | `cursor-agent login` |

### Per-route knobs

- `max_output_tokens` — completion cap for `openai_compat` (default 8192).
- `body` — extra params merged into each `openai_compat` request (e.g. MiniMax-M3
  `{ "reasoning_split": true }`). `${VARS}` expanded.
- `headers` — extra request headers (`${VARS}` expanded).
- `context_1m` — `true` / `"force"` / `"variant"` / `false` (see below).
- `envelope` — opt out of envelope fields for a strict backend, e.g.
  `{ "effort": false, "thinking": false }`.

### Turning on 1M context

| Want | Do this |
|------|---------|
| 1M only when *you* pick it | Pick the **`<model>[1m]`** entry in `/model`. Advertise it with `"advertise_1m_variants": true` or per-model `"context_1m": true`. |
| 1M *always* for one route | Add `"context_1m": "force"` to that route. |
| 1M *always*, everywhere | Set `"proxy": { "force_1m": true }` (only if every backend supports it). |

Full detail: [docs/ONE_MILLION_CONTEXT.md](docs/ONE_MILLION_CONTEXT.md).

## Architecture

```
Claude Code → server.ts (thin HTTP) → envelope/[1m] transform → Provider (by route type)
                                                                  ├─ anthropic   (passthrough + 1M beta)
                                                                  ├─ openai_compat (Anthropic⇄OpenAI, tools)
                                                                  ├─ codex_oauth  (GPT-5.5 via login)
                                                                  └─ cursor_agent (Composer, experimental)
```

- **Provider registry.** Each backend is a self-contained `Provider`; the server
  resolves one by route type and never touches transport details. Adding a
  backend = adding one module + registering it.
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

The self-test (18 cases, all offline) covers discovery + `[1m]` variant
advertisement, the UltraCode envelope, the 1M beta-header guarantee, per-route
envelope overrides, the provider registry, config validation, Anthropic⇄OpenAI
tool translation, the strict-backend tool-adjacency fix, and empty-turn retry.

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
