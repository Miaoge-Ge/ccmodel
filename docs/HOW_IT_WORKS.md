# How it works

**English** · [简体中文](HOW_IT_WORKS.zh-CN.md)

ccmodel is a small loopback proxy plus a launcher. No magic, no secret model.

## 1. What "UltraCode" actually is

At the Anthropic API boundary, Claude Code's **UltraCode** mode is not a hidden
model — it's an *envelope* applied to an ordinary `/v1/messages` request:

| Field | UltraCode value | Meaning |
|-------|-----------------|---------|
| `output_config.effort` | `"xhigh"` | maximum reasoning effort |
| `thinking` | `{"type": "adaptive"}` | extended/adaptive thinking on |
| `max_tokens` | `>= 64000` | room for long, thorough answers |
| `system` | + an *"Ultracode is on…"* reminder block | steers toward the Workflow/quality harness |

Anything that speaks the Anthropic Messages API and honors those fields gets the
UltraCode treatment. Because it's just request shape, the proxy can put the same
envelope on a request and forward it to **any** backend.

## 2. What `[1m]` actually is

`[1m]` is Claude Code's convention for a model's 1M-context variant. The wire
switch that unlocks 1M on the Anthropic API is the header
`anthropic-beta: context-1m-2025-08-07`. That header is dropped in several Claude
Code code paths, so `[1m]` can silently fall back to 200K. ccmodel guarantees the
header on every request that needs it. Full detail:
[ONE_MILLION_CONTEXT.md](ONE_MILLION_CONTEXT.md).

## 3. The proxy

Point Claude Code at it via `ANTHROPIC_BASE_URL` (the launchers do this). For
every request it:

1. **Forces the envelope** on `POST /v1/messages` (toggle with `UC_FORCE_EFFORT`,
   `UC_FORCE_THINKING`, `UC_MAX_TOKENS`, `UC_INJECT_REMINDER`).
2. **Resolves `[1m]`**: detects 1M intent, strips the suffix, and ensures the
   `context-1m-2025-08-07` beta on Anthropic passthrough.
3. **Serves `GET /v1/models`**, merging Anthropic's real list with your custom
   models and their `[1m]` variants.
4. **Routes** each model id to a real backend per `config.jsonc` → `routes`.

## 4. Why your models appear in `/model` (gateway discovery)

When `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, Claude Code calls
`GET /v1/models` on the gateway and lists what comes back. The launchers set that
env var and pre-seed Claude Code's `cache/gateway-models.json` (via
`node dist/src/main.js --seed-cache`) so your models — and their `[1m]`
siblings — show on the very first open.

> **Hard rule from Claude Code:** discovered ids are filtered with
> `/^(claude|anthropic)/i`. Every `id` (and therefore every `<id>[1m]` variant)
> must start with `claude` or `anthropic`. Gateway discovery only triggers on a
> first-party (OAuth) login, not a raw `ANTHROPIC_API_KEY`.

## 5. Routing each pick to a real backend

- **Anthropic passthrough** (no `type`, or `type: "anthropic"`) — forwards
  unchanged to `upstream` (default real Claude). Tools work natively. This is the
  path that gets the 1M beta-header guarantee.
- **`openai_compat`** — translates Anthropic ⇄ OpenAI Chat Completions, POSTs to
  `upstream + /chat/completions`, translates the response back. **Tool calls are
  translated both ways**; streaming SSE is re-emitted as Anthropic SSE. Covers
  MiniMax, DeepSeek, OpenRouter, OpenAI, Ollama, local llama.cpp/LM Studio, etc.
- **`codex_oauth`** — GPT-5.5 via your ChatGPT/Codex *login* (no API key), using
  the token from `codex login`.
- **`cursor_agent`** (experimental) — bridges to Cursor's Composer via the
  `cursor-agent` CLI.

## 6. What touches your machine

- The launchers set env (`ANTHROPIC_BASE_URL`, discovery flag) for **the launched
  process only** and pass a session-scoped `--settings` file. Your global
  `~/.claude` config and credentials are never modified.
- `config.jsonc` (your keys/choices) is **gitignored**.
- The proxy is stopped when Claude Code exits.

## File map (TypeScript source → `dist/`)

| Path | What |
|------|------|
| `src/main.ts` | entry: load config, start server; `--models` / `--seed-cache` helpers |
| `src/server.ts` | HTTP handler: health, `/v1/models`, `/v1/messages` routing |
| `src/envelope.ts` | the UltraCode envelope + `[1m]` enforcement |
| `src/model1m.ts` | `[1m]` parsing, the `context-1m-2025-08-07` beta, header merge |
| `src/models.ts` | `/v1/models` discovery merge + `[1m]` variant advertisement |
| `src/translate.ts` | Anthropic ⇄ OpenAI (tools both ways, strict-backend adjacency) |
| `src/sse.ts` / `src/emit.ts` | OpenAI→event parsing / Anthropic SSE + JSON emitters |
| `src/retry.ts` | empty-turn retry |
| `src/config.ts` | JSONC loader, routes→slots, models |
| `src/providers/codexOauth.ts` | GPT-5.5-via-ChatGPT-login helper |
| `src/providers/cursorAgent.ts` | Cursor Composer bridge (experimental) |
| `src/providers/provider.ts`, `registry.ts` | the Provider interface + registry (route type → provider) |
| `src/providers/{anthropic,openai,codex,cursor}Provider.ts` | one module per backend |
| `src/validate.ts` | config validation (errors + warnings) surfaced at startup |
| `scripts/doctor.ts` | environment + config validator that runs the self-test |
| `test/proxy.test.ts` | offline end-to-end self-test (no network/keys) |
| `bin/ccmodel.mjs` | the cross-platform launcher (Windows / macOS / Linux / WSL) |
| `scripts/install-icons.mjs`, `scripts/uninstall.mjs` | cross-platform desktop entries + cleanup |
