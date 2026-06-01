# Usage reference

**English** · [简体中文](USAGE.zh-CN.md)

A practical, copy-paste reference. New here? Start with the
[README](../README.md) and [SETUP](SETUP.md).

## Commands

| Command | What it does |
|---------|--------------|
| `npm install` | Install dev deps and build `dist/`. |
| `npm run doctor` | Validate environment + config, then run the offline self-test. |
| `npm run launch` | Build (first run), start the proxy, open Claude Code. |
| `npm run launch -- --proxy-only` | Start just the proxy and leave it running (detached). |
| `npm run icons` | Create desktop launchers (`.lnk` / `.command` / `.desktop`). |
| `npm run uninstall` | Stop the proxy, remove launchers + session state. |
| `npm test` | Build + run the offline self-test. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `node dist/src/main.js --models` | Print the advertised model list as JSON. |

The launcher and the proxy both read `config.jsonc` (falling back to
`config.example.jsonc`).

## End-to-end: pick a backend in `/model`

1. `cp config.example.jsonc config.jsonc` and edit it (keep what you use; add keys).
2. `npm run doctor` until it exits 0.
3. `npm run launch`.
4. In Claude Code, type `/model`. You'll see your models, each with a
   `…[1m]` sibling. Pick one and go.

## Recipes

### A. DeepSeek (Anthropic-native passthrough — verified)

```jsonc
{
  "proxy": { "advertise_1m_variants": true },
  "models": [
    { "id": "claude-deepseek-v4-flash", "display_name": "DeepSeek V4 Flash" },
    { "id": "claude-deepseek-v4-pro",   "display_name": "DeepSeek V4 Pro" }
  ],
  "routes": {
    "claude-deepseek-v4-flash": { "upstream": "https://api.deepseek.com/anthropic", "model": "deepseek-v4-flash", "auth": "Bearer ${DEEPSEEK_API_KEY}" },
    "claude-deepseek-v4-pro":   { "upstream": "https://api.deepseek.com/anthropic", "model": "deepseek-v4-pro",   "auth": "Bearer ${DEEPSEEK_API_KEY}" }
  }
}
```

```bash
export DEEPSEEK_API_KEY=sk-...   # or put it in a gitignored ccmodel.env
npm run launch
```

### B. An OpenAI-compatible backend (MiniMax-M3, OpenRouter, local …)

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

### C. GPT-5.5 with a ChatGPT/Codex login (no API key)

```bash
codex login            # once, creates ~/.codex/auth.json
```
```jsonc
"claude-gpt-5.5-codex": { "type": "codex_oauth", "model": "gpt-5.5" }
```

### D. A strict backend that rejects envelope fields

```jsonc
"claude-strict": {
  "upstream": "https://example/anthropic",
  "model": "some-model",
  "auth": "Bearer ${KEY}",
  "envelope": { "effort": false, "thinking": false }
}
```

## Turning on 1M context

| Want | Config |
|------|--------|
| Only when you pick it | `"proxy": { "advertise_1m_variants": true }`, then choose `…[1m]` in `/model`. |
| One model only | `{ "id": "claude-x", "context_1m": true }` |
| Always for a route | `"context_1m": "force"` on that route |
| Always, everywhere | `"proxy": { "force_1m": true }` (only if every backend supports it) |

Details: [ONE_MILLION_CONTEXT.md](ONE_MILLION_CONTEXT.md).

## Verify it's working

```bash
curl -s localhost:8141/healthz                  # ok, version, providers, 1M policy
curl -s localhost:8141/v1/models | grep '\[1m\]' # the [1m] variants are advertised
UC_VERBOSE=1 node dist/src/main.js               # watch per-request logs (model, want1m, timing)
```

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `UC_LISTEN_HOST` | `127.0.0.1` | Bind host. |
| `UC_LISTEN_PORT` | `8141` | Listen port (overrides `proxy.listen_port`). |
| `UC_UPSTREAM` | `https://api.anthropic.com` | Default Anthropic upstream. |
| `UC_CONFIG` | auto | Path to the config file. |
| `UC_MAX_TOKENS` | `64000` | `max_tokens` floor. |
| `UC_FORCE_EFFORT` | `xhigh` | Effort to force (empty = leave untouched). |
| `UC_FORCE_THINKING` | `1` | Force adaptive thinking. |
| `UC_INJECT_REMINDER` | `1` | Inject the Ultracode reminder. |
| `UC_FORCE_1M` | `0` | Force 1M on every request. |
| `UC_EMPTY_RETRY_ATTEMPTS` / `UC_EMPTY_RETRY_BACKOFF` | `2` / `0.75` | Empty-turn retry. |
| `UC_MODEL_MAP` | `{}` | JSON map of extra `id → backend model` overrides. |
| `UC_LOG` / `UC_VERBOSE` | stderr / `0` | Log file / verbose logging. |

Codex: `CODEX_HOME`, `UC_CODEX_EFFORT`, `UC_CODEX_SERVICE_TIER`, `UC_CODEX_STREAM_IDLE_TIMEOUT`.
Cursor: `CURSOR_AGENT_BIN`, `CURSOR_AGENT_WORKSPACE`, `CURSOR_AGENT_TIMEOUT`, `CURSOR_AGENT_NO_PROXY`.

Stuck? See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
