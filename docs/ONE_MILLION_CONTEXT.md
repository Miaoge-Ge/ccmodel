# The `[1m]` 1M-context guarantee

**English** · [简体中文](ONE_MILLION_CONTEXT.zh-CN.md)

This is ccmodel's headline feature: **add `[1m]` to a model and it reliably gets
a 1,000,000-token context window** — instead of silently capping at 200K.

## Background: what `[1m]` is, and why it breaks

`[1m]` is Claude Code's own convention for the 1M-context *variant* of a model
(`opus[1m]`, `sonnet[1m]`, `claude-opus-4-8[1m]`). When you select it, Claude
Code is supposed to:

1. Track a **1,000,000-token** window (so it doesn't auto-compact at ~200K), and
2. Send the wire-level switch that unlocks 1M on the Anthropic Messages API: the
   header **`anthropic-beta: context-1m-2025-08-07`**.
   (On Opus 4.6+ / Sonnet 4.6 the header is redundant-but-accepted; 1M is the
   default. On other eligible models it is required.)

> "Claude Code strips the `[1m]` suffix before sending the model ID to your
> provider." — Claude Code model-config docs

The problem: that beta header **gets dropped in several real code paths** —
subagent model resolution, the `--model` flag, and some gateway/`ANTHROPIC_BASE_URL`
routes (tracked across multiple upstream issues). When the header goes missing,
the request quietly falls back to a **200K** window and large prompts start
erroring — exactly when you reached for 1M.

## What ccmodel does about it

The proxy sits on `ANTHROPIC_BASE_URL`, so it sees **every** request and is the
last hop before Anthropic. On each `POST /v1/messages` it:

1. **Detects 1M intent** from any of these signals (OR):
   - the incoming `model` id ends in `[1m]`, **or**
   - the request already carries `anthropic-beta: context-1m-2025-08-07`
     (Claude Code added it — we honor it), **or**
   - the matched route has `"context_1m": true | "force"`, **or**
   - the global `proxy.force_1m` (env `UC_FORCE_1M=1`) is set.
2. **Strips the `[1m]` suffix** from the outgoing model id (backends don't
   understand it — mirrors Claude Code's own behavior).
3. **Guarantees the beta header** on Anthropic passthrough: it adds
   `context-1m-2025-08-07` to `anthropic-beta`, **merging** with any betas
   already there (e.g. `prompt-caching-…`) and de-duplicating. Idempotent.

So even if Claude Code dropped the header, ccmodel puts it back. `[1m]` means 1M.

For **OpenAI-compatible** backends (MiniMax-M3, etc.) the 1M window is the
backend's *native* property, not an Anthropic beta — so the proxy just forwards
the clean (suffix-stripped) model id and never caps the input. The `[1m]` variant
still matters there: it's what makes Claude Code track a 1M window for its own
compaction math.

## How to turn it on

### 1. Per pick (smallest blast radius)

Advertise a `[1m]` companion in the `/model` picker, then choose it when you want
1M:

```jsonc
{
  "proxy": { "advertise_1m_variants": true },   // adds "<id>[1m]" for every model
  "models": [ { "id": "claude-opus-4-8", "display_name": "Opus 4.8" } ],
  "routes": { "claude-opus-4-8": { "model": "claude-opus-4-8", "auth": "passthrough" } }
}
```

In `/model` you'll see both **Opus 4.8** and **Opus 4.8[1m]**. Pick the
latter for a 1M session.

Prefer it per-model instead of globally? Drop `advertise_1m_variants` and set
`"context_1m": true` on the individual `models` entry.

### 2. Always-on for one route

```jsonc
"claude-minimax-m3": {
  "type": "openai_compat",
  "upstream": "https://api.minimax.io/v1",
  "model": "MiniMax-M3",
  "auth": "Bearer ${MINIMAX_API_KEY}",
  "context_1m": "force"        // every request to this route uses 1M
}
```

With `"force"`, ccmodel advertises **only** the `[1m]` variant for that model
(the bare id would behave identically, so showing both would just be confusing).

### 3. Always-on, everywhere

```jsonc
"proxy": { "force_1m": true }
```

or run with `UC_FORCE_1M=1`. Use this only if **every** backend you route to
supports 1M — otherwise a backend that doesn't will reject oversized inputs.

## Verifying it works

The offline self-test asserts the whole chain (`npm test`):

- a `[1m]` pick → the upstream sees the suffix **stripped** *and* the
  `context-1m-2025-08-07` beta header present;
- an incoming beta header → **preserved and de-duplicated** alongside other betas;
- a `[1m]` pick on an `openai_compat` backend → the backend gets the **clean**
  model id (native 1M, no Anthropic beta);
- discovery advertises the `[1m]` variants with a `context_window: 1000000` hint.

Live check against the running proxy:

```bash
# the [1m] variants are advertised
curl -s localhost:8141/v1/models | grep '\[1m\]'

# health shows the 1M policy
curl -s localhost:8141/healthz
```

To watch the header on a real request, run the proxy with `UC_VERBOSE=1` and
check the log (`%LOCALAPPDATA%\ccmodel\ccmodel_proxy.log` on Windows,
`~/.local/state/ccmodel/proxy.log` elsewhere).

## Caveats

- **Eligibility & billing are the provider's.** ccmodel sends the right header;
  whether your plan grants 1M (and how it's billed past 200K) is between you and
  the provider. On Max/Team/Enterprise, Opus 1M is typically included; Sonnet 1M
  often needs usage credits. See Anthropic's context-window docs.
- **Retired betas.** Anthropic retired the `context-1m-2025-08-07` beta for
  Sonnet 4 / 4.5 on 2026-04-30; on those models the header no longer helps. Use a
  current 1M-capable model (Opus 4.6+/Sonnet 4.6) — where the header is, at
  worst, harmlessly redundant.
- **`[1m]` ≠ magic.** It can't give 1M to a backend that doesn't support it; for
  `openai_compat` you still need a model whose context is actually that large.
