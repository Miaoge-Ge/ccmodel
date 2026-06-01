# Runbook for AI assistants

**English** · [简体中文](AGENTS.zh-CN.md)

You are helping a user set up **ccmodel**: it lets Claude Code's UltraCode mode —
and a reliable `[1m]` 1M-token context — run on any model the user already pays
for, chosen from the `/model` menu.

Follow these phases in order. Do not skip the doctor.

## Phase 0 — Understand the goal

End state: the user launches **CCModel (All Models)**, Claude Code opens, they
type `/model`, and they can pick any backend they configured — including a
`<model>[1m]` variant of each that genuinely runs at 1,000,000 tokens.
Mechanism (no magic): a loopback proxy (`dist/src/main.js`) sits at
`ANTHROPIC_BASE_URL`, advertises the user's models (and `[1m]` siblings) on
`GET /v1/models`, adds the UltraCode envelope, guarantees the
`context-1m-2025-08-07` beta on `[1m]` requests, and routes each pick to its
backend. See `docs/HOW_IT_WORKS.md` and `docs/ONE_MILLION_CONTEXT.md`.

## Phase 1 — Prerequisites

1. `node --version` → must be ≥ 18.
2. `claude --version` → install with `npm i -g @anthropic-ai/claude-code` if missing.
3. Confirm the user has UltraCode access (they'd have used `/effort ultracode`).

## Phase 2 — Build + baseline check

```
npm install      # installs dev deps and builds dist/
npm run doctor
```

The doctor runs an **offline self-test** (no network/keys) proving the proxy,
discovery, the `[1m]` variant advertisement, the UltraCode envelope, the 1M
beta-header guarantee, and tool translation. If it fails, STOP and report the
output — the install is broken, not the user's config.

## Phase 3 — Ask what they have, then configure

Ask which the user has (only configure those):

- An **API key** for an OpenAI-compatible service (MiniMax-M3, MiMo, DeepSeek,
  OpenRouter, OpenAI, a local server, …) → `openai_compat`.
- A **ChatGPT/Codex login** for GPT-5.5 → `codex_oauth` (`codex login`).
- Just **Claude** → still useful: real Claude with the UltraCode envelope, and
  `[1m]` gives a guaranteed 1M window.

Copy `config.example.jsonc` → `config.jsonc` and edit:

- `models` — one entry per model to show in `/model`. **Every `id` MUST start
  with `claude` or `anthropic`.**
- `routes` — a route per id (key == id, or the id's base for a `[1m]` pick).
- Keys inline (gitignored) or as `${VAR}` (export, or a gitignored `ccmodel.env`).
- **1M:** set `"proxy": { "advertise_1m_variants": true }` to offer a `[1m]`
  sibling for every model, or `"context_1m": true` per model, or
  `"context_1m": "force"` per route for always-on. See `docs/ONE_MILLION_CONTEXT.md`.
- **Reasoning models that inline `<think>` (MiniMax-M3):** add
  `"body": { "reasoning_split": true }`.

## Phase 4 — Validate

```
npm run doctor
```

Validates ids are discoverable+routed, every `${VAR}` is present (or inline), and
`codex_oauth`/`cursor_agent` routes have their login/CLI. Fix every `[FAIL]` until
exit code 0.

## Phase 5 — Launch

One cross-platform launcher (Windows / macOS / Linux / WSL):

```
npm run launch          # == node bin/ccmodel.mjs
```

Optional desktop entries: `npm run icons` (creates **CCModel (All Models)** and
**Claude Code (Normal)**). Proxy-only: `npm run launch -- --proxy-only`.

## Phase 6 — Verify end to end

1. In `/model`, confirm the user's custom models AND their `[1m]`
   variants appear.
2. Pick one, send "say OK", confirm a reply.
3. Pick a tool-using one and confirm tools fire (the proxy translates both ways).
4. Pick a `[1m]` variant; with `UC_VERBOSE=1` confirm the log shows
   `want1m=true` and (for passthrough) the beta header is added.

Match symptoms in `docs/TROUBLESHOOTING.md`. Common ones:
- Model missing from `/model` → id didn't start with `claude`/`anthropic`, or
  discovery env not set.
- "responded but never called tools" → that route must be `openai_compat`.
- 401/empty → wrong/empty key, or expired `codex login`.
- `[1m]` still capping → usually plan eligibility or a retired-beta model, not the
  header (the proxy always sends it). See `docs/ONE_MILLION_CONTEXT.md`.

## Hard rules

- Never commit `config.jsonc`/`config.json` or `ccmodel.env` (gitignored; they
  hold the user's keys).
- Don't modify the user's global `~/.claude` config; this tool is session-scoped.
- If the offline self-test (`npm test`) fails, the problem is the code/clone, not
  the user — report it, don't paper over it.
