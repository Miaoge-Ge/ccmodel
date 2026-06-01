# Add a model

**English** · [简体中文](ADD_A_MODEL.zh-CN.md)

Everything lives in one file: **`config.jsonc`** (copied from
`config.example.jsonc` on first run). To add a backend you edit two sections:

1. **`models`** — what appears in Claude Code's `/model` picker.
2. **`routes`** — where each of those ids actually goes.

```jsonc
{
  "models": [
    { "id": "claude-mimo", "display_name": "MiMo v2.5 Pro" }
  ],
  "routes": {
    "claude-mimo": {
      "type": "openai_compat",
      "upstream": "https://token-plan-sgp.xiaomimimo.com/v1",
      "model": "mimo-v2.5-pro",
      "auth": "Bearer ${MIMO_API_KEY}"
    }
  }
}
```

> **Two rules:**
> 1. Every `id` in `models` **must start with `claude` or `anthropic`** — Claude
>    Code drops everything else from `/model`.
> 2. The `id` in `models` must **equal** the key in `routes` (or its base id if
>    you pick the `[1m]` variant — the proxy strips the suffix before routing).
>
> Run `npm run doctor` and it checks both for you.

## Where keys go

`config.jsonc` is gitignored, so put a key **inline** (`"auth": "Bearer sk-…"`)
or keep it out of the file with **`${ENV}`** expansion
(`"auth": "Bearer ${MIMO_API_KEY}"`). The launchers also load an optional
gitignored **`ccmodel.env`** in the repo root:

```
MIMO_API_KEY=...
OPENROUTER_API_KEY=...
```

## Adding the `[1m]` 1M-context variant

Any model can get a 1M-context sibling in the picker. See
[ONE_MILLION_CONTEXT.md](ONE_MILLION_CONTEXT.md) for the full story; the short
version:

- **One model:** add `"context_1m": true` to its `models` entry → a
  `<id>[1m]` pick appears.
- **All models:** set `"proxy": { "advertise_1m_variants": true }`.
- **Always-on for a route:** add `"context_1m": "force"` to the route.

```jsonc
{ "id": "claude-opus-4-8", "display_name": "Opus 4.8", "context_1m": true }
```

## Route types

### `openai_compat` — anything that speaks OpenAI Chat Completions

MiMo, DeepSeek, StepFun, Ollama Cloud, OpenRouter, OpenAI, Together, a local
llama.cpp / LM Studio server, etc. Tool calls are translated both ways.

```jsonc
"claude-openrouter": {
  "type": "openai_compat",
  "upstream": "https://openrouter.ai/api/v1",
  "model": "meta-llama/llama-3.3-70b-instruct",
  "auth": "Bearer ${OPENROUTER_API_KEY}"
}
```

- `upstream` is the OpenAI **base URL exactly as the provider documents it**
  (usually ends in `/v1`). The proxy appends `/chat/completions`.
- `model` is the backend's real id, **not** the `claude-…` alias.
- Optional: `headers` (dict, `${VARS}` ok), `max_output_tokens` (completion cap,
  default 8192), `body` (dict merged into every request, `${VARS}` ok), and
  `context_1m` (`true` / `"force"` / `"variant"`).

A **local** server is the same, with a usually-ignored key:

```jsonc
"claude-local": {
  "type": "openai_compat",
  "upstream": "http://127.0.0.1:11434/v1",
  "model": "your-local-model",
  "auth": "Bearer local"
}
```

### MiniMax-M3

OpenAI-compatible, with two things worth setting:

```jsonc
"claude-minimax-m3": {
  "type": "openai_compat",
  "upstream": "https://api.minimax.io/v1",
  "model": "MiniMax-M3",
  "auth": "Bearer ${MINIMAX_API_KEY}",
  "max_output_tokens": 64000,
  "context_1m": "force",
  "body": { "reasoning_split": true }
}
```

- **`"body": { "reasoning_split": true }`** keeps M3's `<think>` chain-of-thought
  out of the visible answer (returned as `reasoning_content` instead). Without it
  you'll see raw `<think>…</think>` in replies.
- M3's context is **~1M** natively, so `"context_1m": "force"` is a good fit.
- `max_output_tokens` can go up to 64000.

### Anthropic passthrough — real Claude or an Anthropic-compatible endpoint

Omit `type` (or set `"anthropic"`). With no `auth`/`upstream` it's just real
Claude with the UltraCode envelope (and the `[1m]` 1M guarantee). It also covers
providers that ship a native Anthropic endpoint, like **DeepSeek** (verified):

```json
"claude-deepseek-v4-pro": {
  "upstream": "https://api.deepseek.com/anthropic",
  "model": "deepseek-v4-pro",
  "auth": "Bearer ${DEEPSEEK_API_KEY}"
}
```

Or point at an Anthropic-shaped gateway and add headers:

```jsonc
"claude-opencode": {
  "upstream": "https://opencode.ai/zen/go",
  "model": "claude-sonnet-4-5",
  "auth": "Bearer ${OPENCODE_API_KEY}",
  "headers": { "User-Agent": "openclaw/2026.4.20" }
}
```

### `codex_oauth` — GPT-5.5 via a ChatGPT/Codex login (no API key)

```jsonc
"claude-gpt-5.5-codex": { "type": "codex_oauth", "model": "gpt-5.5" }
```

Run `codex login` once (creates `~/.codex/auth.json`). Optional env knobs:
`UC_CODEX_EFFORT`, `UC_CODEX_SERVICE_TIER`, `CODEX_HOME`,
`UC_CODEX_STREAM_IDLE_TIMEOUT`.

### `cursor_agent` — Cursor Composer (experimental)

```jsonc
"claude-composer": { "type": "cursor_agent", "model": "composer-2.5" }
```

Needs the `cursor-agent` CLI and `cursor-agent login`. Run in read-only "ask"
mode with a best-effort tool bridge — great for reasoning/answers. Knobs:
`CURSOR_AGENT_TIMEOUT` (default 240s), `CURSOR_AGENT_WORKSPACE`,
`CURSOR_AGENT_NO_PROXY=1` (if a TLS-intercepting proxy makes it hang).

After editing, validate and launch:

```
npm run doctor
npm run launch                   # cross-platform: Windows / macOS / Linux / WSL
```
