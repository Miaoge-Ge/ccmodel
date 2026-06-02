# ccmodel — System Manual

**English** · [简体中文](MANUAL.zh-CN.md)

The complete reference for ccmodel: setup, configuration, the `[1m]` guarantee,
how it works, environment variables, architecture, and troubleshooting. For a
one-minute overview see the [README](../README.md).

## Contents

- [1. What ccmodel is](#1-what-ccmodel-is)
- [2. Requirements](#2-requirements)
- [3. Install and run](#3-install-and-run)
- [4. Configure your models](#4-configure-your-models)
- [5. Backend recipes](#5-backend-recipes)
- [6. The `[1m]` 1M-context guarantee](#6-the-1m-1m-context-guarantee)
- [7. How it works](#7-how-it-works)
- [8. Environment variables](#8-environment-variables)
- [9. Architecture and file map](#9-architecture-and-file-map)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Develop and test](#11-develop-and-test)
- [12. For AI assistants](#12-for-ai-assistants)
- [13. Uninstall](#13-uninstall)

---

## 1. What ccmodel is

ccmodel is a small loopback proxy that sits on Claude Code's `ANTHROPIC_BASE_URL`.
It does two things on top of stock Claude Code, with no secret model and no
changes to your install:

1. **UltraCode on any model.** At the API boundary "UltraCode" is just an
   *envelope* on a `/v1/messages` request — `output_config.effort = "xhigh"`,
   adaptive `thinking`, a large `max_tokens`, and one system reminder. ccmodel
   puts that envelope on every request and forwards it to whatever backend you
   pick from `/model`.
2. **A 1M context that doesn't lie.** Claude Code's `[1m]` suffix is supposed to
   give a 1,000,000-token window, but the beta header that unlocks it gets dropped
   in several code paths, so it can silently fall back to 200K. ccmodel re-adds
   the header on every request that needs it — so `[1m]` means 1M.

Your normal Claude Code install is untouched: ccmodel only sets env for the
launched process and passes a session-scoped `--settings` file.

## 2. Requirements

| Need | Check | Get it |
|------|-------|--------|
| Node.js 20+ | `node --version` | https://nodejs.org (Windows: tick **Add to PATH**) |
| Claude Code CLI | `claude --version` | `npm i -g @anthropic-ai/claude-code` |
| UltraCode access | you've used `/effort ultracode` | part of your Claude plan |
| ≥1 backend credential | — | an API key and/or `codex login` |

The proxy runs on Node built-ins only; TypeScript is a dev dependency for the
build. One launcher (`bin/ccmodel.mjs`) works on **Windows, macOS, Linux, WSL**.

## 3. Install and run

```bash
git clone <this-repo> ccmodel && cd ccmodel
npm install        # installs dev deps and builds dist/
npm run doctor     # validates env + config, runs the offline self-test

cp config.example.jsonc config.jsonc   # Windows: copy config.example.jsonc config.jsonc
#   edit config.jsonc — keep the models you have, add your keys

npm run launch     # build (first run), start the proxy, open Claude Code
```

In Claude Code, type `/model` and pick a backend. Picks ending in `[1m]` run at a
1,000,000-token window.

| Command | What it does |
|---------|--------------|
| `npm install` | Install dev deps and build `dist/`. |
| `npm run doctor` | Validate environment + config, then run the offline self-test. |
| `npm run launch` | Build (first run), start the proxy, open Claude Code. |
| `npm run launch -- --proxy-only` | Start just the proxy, leave it running (detached). |
| `npm run icons` | Create desktop launchers (`.lnk` / `.command` / `.desktop`). |
| `npm run uninstall` | Stop the proxy, remove launchers + session state. |
| `npm test` | Build + run the offline self-test. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `node dist/src/main.js --models` | Print the advertised model list as JSON. |

`npm run icons` creates two desktop entries: **CCModel (All Models)** (proxy +
Claude Code, discovery on) and **Claude Code (Normal)** (your usual install,
untouched).

### Use it from any directory

`npm run launch` must be run from the repo. To use ccmodel on other projects
without that, put the `ccmodel` command on your `PATH` once:

```bash
npm link        # from the repo — symlinks `ccmodel` globally (npm rm -g ccmodel to undo)
```

Then `cd` into any project and run `ccmodel`: it starts the proxy, opens Claude
Code **in that directory**, and uses this repo's `config.jsonc` (resolved through
the symlink, so config and code edits take effect immediately). `ccmodel --version`
prints the version and the linked repo path; `ccmodel --help` lists the options;
any other arguments pass through to `claude`. `npm i -g .` also installs the
command, but `npm link` keeps it pointed at your working copy.

## 4. Configure your models

Everything is in one file: **`config.jsonc`** (copied from
`config.example.jsonc`). It's JSONC — `//` and `/* */` comments and trailing
commas are fine; keys starting with `_` are ignored (handy for notes).
`config.jsonc` is gitignored, so your keys never get committed.

**The whole config is a single list of models.** In the common case an entry is
just three fields — `{ "model": …, "url": …, "key": … }`. Only `model` is
required; everything else is inferred:

| You write | The proxy infers |
|-----------|------------------|
| `model` (required) | the backend id sent upstream **and** the `/model` id `claude-<slug(model)>` (Claude Code only keeps `claude`/`anthropic` ids). A trailing **`[1m]`** marks it a 1M model. |
| `url` | the **backend kind**: `…/anthropic` → passthrough, any other url → OpenAI-compatible. Omit for real Claude. |
| `key` | the auth header — wrapped as `Authorization: Bearer <key>` (or pass a literal `"x-api-key: …"`). Omit to reuse Claude Code's own credential. |

**1M is one character: the `[1m]` suffix.** `"model": "MiniMax-M3"` is a standard
200K pick; `"model": "MiniMax-M3[1m]"` is a guaranteed-1M pick. The suffix is
stripped before the id reaches the backend, so only add it to models that really
support 1M. One entry = one `/model` pick (see [§6](#6-the-1m-1m-context-guarantee)).

```jsonc
{
  // optional globals (defaults shown):
  // "host": "127.0.0.1", "port": 8141, "max_tokens": 64000, "force_1m": false,
  "models": [
    { "model": "claude-opus-4-8[1m]", "name": "Claude Opus 4.8 (1M)" },
    { "model": "deepseek-v4-pro", "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" }
  ]
}
```

### Top-level globals (all optional)

| Key | Default | Meaning |
|-----|---------|---------|
| `host` | `127.0.0.1` | bind address |
| `port` | `8141` | listen port |
| `upstream` | `https://api.anthropic.com` | default Anthropic upstream for passthrough |
| `max_tokens` | `64000` | the `max_tokens` floor forced onto every request |
| `force_1m` | `false` | force 1M on **every** request (only if every backend supports it) |

### Per-model options (all optional, beside `model`/`url`/`key`)

| Field | Meaning |
|-------|---------|
| `name` | a prettier display label in `/model` (defaults to `model`) |
| `api` | force the backend kind (`anthropic` / `openai` / `codex` / `cursor`) instead of inferring from `url`. Required for codex/cursor (no url to infer from) |
| `effort` | a different effort level, or `false` to stop forcing effort on a strict backend |
| `max_output_tokens` | completion cap for OpenAI-compatible backends (default 8192) |
| `body` | extra params merged into each OpenAI-compatible request (e.g. `{ "reasoning_split": true }`). `${VARS}` expanded |
| `headers` | extra request headers (`${VARS}` expanded) |
| `workspace` | working dir for a `cursor` backend |

> **1M** is not a per-model field — it's the `[1m]` suffix on `model`. See
> [§6](#6-the-1m-1m-context-guarantee).

### Backend kinds

The kind is inferred from `url` (or forced with `api`):

| Kind | When | Needs |
|------|------|-------|
| Anthropic passthrough | no `url` (real Claude), a `…/anthropic` url, or `"api": "anthropic"` | nothing, or `key`/`url` |
| OpenAI-compatible | any other `url`, or `"api": "openai"` (tools translated both ways) | `key` (a local server can omit it) |
| Codex | `"api": "codex"` — GPT-5.5 via a ChatGPT/Codex login (no API key) | `codex login` once; `model` (e.g. `gpt-5.5`) |
| Cursor | `"api": "cursor"` — Cursor Composer (experimental) | `cursor-agent login`; `model` (e.g. `composer-2.5`) |

### Where keys go

`config.jsonc` is gitignored. Put a key **inline** (`"key": "sk-…"`) or keep it
out of the file with **`${ENV}`** expansion (`"key": "${DEEPSEEK_API_KEY}"`). The
launchers also load an optional gitignored **`ccmodel.env`** in the repo root:

```
DEEPSEEK_API_KEY=...
OPENROUTER_API_KEY=...
```

A bare `key` becomes `Authorization: Bearer <key>`. Need a different header? Write
it out — `"key": "x-api-key: ${SOME_KEY}"` is passed through as-is. ccmodel never
forwards Claude Code's own credential to a non-Anthropic backend.

## 5. Backend recipes

Each recipe is **one entry** in the `models` list.

**DeepSeek (Anthropic-native passthrough — verified end-to-end):**

```jsonc
{ "model": "deepseek-v4-pro", "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" }
```

**MiniMax-M3 (OpenAI-compatible, native ~1M — note the `[1m]` suffix):**

```jsonc
{
  "model": "MiniMax-M3[1m]",
  "url": "https://api.minimax.io/v1",
  "key": "${MINIMAX_API_KEY}",
  "max_output_tokens": 64000,
  "body": { "reasoning_split": true }
}
```

- The `[1m]` suffix advertises M3 as a 1M pick; it's stripped to `MiniMax-M3`
  before the id reaches the backend.
- `"body": { "reasoning_split": true }` keeps M3's `<think>` chain-of-thought out
  of the visible answer. Without it you'll see raw `<think>…</think>`.

**OpenRouter / any OpenAI Chat Completions endpoint:**

```jsonc
{ "model": "meta-llama/llama-3.3-70b-instruct", "url": "https://openrouter.ai/api/v1", "key": "${OPENROUTER_API_KEY}", "name": "OpenRouter Llama 3.3" }
```

- `url` is the base exactly as the provider documents it (usually ends `/v1`); the
  proxy appends `/chat/completions`. `model` is the backend's real id.

**Local server (Ollama / llama.cpp / LM Studio) — no key:**

```jsonc
{ "model": "your-local-model", "url": "http://127.0.0.1:11434/v1" }
```

**GPT-5.5 via a ChatGPT/Codex login (no API key):**

```jsonc
{ "model": "gpt-5.5", "api": "codex" }
```

Run `codex login` once (creates `~/.codex/auth.json`). codex honors the UltraCode
effort (`xhigh` → `high`). Env knobs: `UC_CODEX_EFFORT`, `UC_CODEX_SERVICE_TIER`,
`CODEX_HOME`, `UC_CODEX_STREAM_IDLE_TIMEOUT`.

**Cursor Composer (experimental):**

```jsonc
{ "model": "composer-2.5", "api": "cursor" }
```

Needs the `cursor-agent` CLI and `cursor-agent login`. Runs in read-only "ask"
mode with a best-effort tool bridge. Knobs: `CURSOR_AGENT_TIMEOUT` (default 240s),
`CURSOR_AGENT_WORKSPACE`, `CURSOR_AGENT_NO_PROXY=1` (if a TLS-intercepting proxy
makes it hang).

**Strict Anthropic-compatible backend that rejects the effort field:**

```jsonc
{ "model": "some-model", "url": "https://example/anthropic", "key": "${KEY}", "effort": false }
```

## 6. The `[1m]` 1M-context guarantee

### Background

`[1m]` is Claude Code's convention for a model's 1M-context variant
(`claude-opus-4-8[1m]`). Selecting it should (1) make Claude Code track a
1,000,000-token window (so it doesn't auto-compact at ~200K) and (2) send the
header **`anthropic-beta: context-1m-2025-08-07`**, which unlocks 1M on the
Anthropic Messages API. Claude Code strips the `[1m]` suffix before sending the
model id to the provider.

The problem: that beta header **gets dropped in several real code paths**
(subagent model resolution, the `--model` flag, some gateway/`ANTHROPIC_BASE_URL`
routes). When it goes missing, the request silently falls back to 200K.

### What ccmodel does

On each `POST /v1/messages` it:

1. **Detects 1M intent** from any of: the `model` id ends in `[1m]`; the request
   already carries the `context-1m-2025-08-07` beta; the picked model came from a
   `[1m]` config entry (so 1M is guaranteed even if Claude Code stripped the suffix
   on the wire); or the global `force_1m` is on.
2. **Strips the `[1m]` suffix** from the outgoing model id (backends don't
   understand it — mirrors Claude Code).
3. **Guarantees the beta header** on Anthropic passthrough, merging with any betas
   already present (e.g. `prompt-caching-…`) and de-duplicating. Idempotent.

For OpenAI-compatible backends the 1M window is the backend's *native* property,
not an Anthropic beta — the proxy just forwards the clean id and never caps input.

### 1M is opt-in via the `[1m]` suffix (important)

**A model is standard (200K) unless its `model` id carries `[1m]`** — most models
are *not* 1M-capable, so ccmodel does not pretend they are. The suffix is the only
switch, and each entry maps to exactly one `/model` pick:

| `model` value | `/model` shows | Behavior |
|---------------|----------------|----------|
| `"X"` | `claude-x` | standard 200K window; never auto-1M |
| `"X[1m]"` | `claude-x[1m]` | guaranteed 1M on every request to it |

Want both a 200K *and* a 1M pick of the same backend model? Add two entries — one
`"X"` and one `"X[1m]"`. (They get distinct ids, e.g. `claude-x` and `claude-x-2[1m]`.)

A standard entry still **honors an explicit `[1m]`** if one reaches the proxy on
the wire — so the guarantee applies even to a pick you didn't pre-advertise.

Global always-on: top-level `"force_1m": true` (or `UC_FORCE_1M=1`) — only if
every backend supports 1M.

### Caveats

- **Eligibility & billing are the provider's.** ccmodel sends the right header;
  whether your plan grants 1M (and how it bills past 200K) is between you and the
  provider.
- **Beta support changes over time.** Use a current model/plan combination that
  your provider documents as 1M-capable; retired or ineligible models may still
  reject or ignore the beta.
- **Not magic.** `[1m]` can't give 1M to a backend that doesn't support it.

## 7. How it works

### The UltraCode envelope

| Field | Value | Meaning |
|-------|-------|---------|
| `output_config.effort` | `"xhigh"` | maximum reasoning effort |
| `thinking` | `{"type": "adaptive"}` | extended/adaptive thinking |
| `max_tokens` | `>= 64000` | room for long answers |
| `system` | + an *"Ultracode is on…"* reminder | steers toward the Workflow/quality harness |

Each field is toggleable globally (`UC_FORCE_EFFORT`, `UC_FORCE_THINKING`,
`UC_MAX_TOKENS`, `UC_INJECT_REMINDER`) or per-model (`"effort": false`).

**The envelope is scoped by backend kind** so a backend never receives fields it
can't use:

| Backend | effort | thinking | Workflow reminder | max_tokens floor |
|---------|:------:|:--------:|:-----------------:|:----------------:|
| Anthropic passthrough (real Claude, `…/anthropic`) | ✅ | ✅ | ✅ | ✅ |
| Codex (GPT-5.5) | ✅ (→ reasoning effort) | — | — | ✅ |
| OpenAI-compatible / cursor | — | — | — | ✅¹ |

¹ The OpenAI provider re-caps `max_tokens` to its own default/slot value, so the
floor is effectively a no-op there. The point: OpenAI-compatible and cursor
backends are **not** sent the Claude-only `output_config`/`thinking` fields or the
Workflow reminder — that would just add tokens and reference tooling the model
can't use.

### Endpoints

| Path | What |
|------|------|
| `POST /v1/messages` | the proxied Messages API (envelope + `[1m]` + routing) |
| `GET /v1/models` | discovery: upstream models merged with your configured ones |
| `GET /healthz` (`/health`) | liveness + config summary (version, providers, 1M policy, slots) **and a `metrics` snapshot** |
| `GET /metrics` | the same counters in Prometheus text format (requests by kind/status, errors, 1M count, latency avg/max, uptime) |

`/healthz` and `/metrics` make the proxy observable instead of a black box; point
a scraper at `/metrics` or just `curl` it.

### Gateway discovery (why your models appear in `/model`)

When `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, Claude Code calls
`GET /v1/models` and lists what comes back. The launchers set that env var and
pre-seed `cache/gateway-models.json` so your models — including any `[1m]` picks —
show on first open. Discovered ids are filtered with `/^(claude|anthropic)/i`;
ccmodel's auto id is `claude-<slug(model)>` (and a `[1m]` id inherits that prefix),
so this is handled for you. Discovery only triggers on a first-party (OAuth) login,
not a raw `ANTHROPIC_API_KEY`.

### Routing

The server resolves a `Provider` by backend kind and forwards: Anthropic
passthrough relays unchanged (and lands the 1M beta guarantee); `openai_compat`
translates Anthropic ⇄ OpenAI Chat Completions (tools both ways, SSE re-emitted);
`codex` uses your Codex login's token against the Responses API; `cursor` bridges
to the `cursor-agent` CLI.

## 8. Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `UC_LISTEN_HOST` | `127.0.0.1` | Bind host (overrides config `host`). |
| `UC_LISTEN_PORT` | `8141` | Listen port (overrides config `port`). |
| `UC_UPSTREAM` | `https://api.anthropic.com` | Default Anthropic upstream (overrides config `upstream`). |
| `UC_CONFIG` | auto | Path to the config file. |
| `UC_MAX_TOKENS` | `64000` | `max_tokens` floor (overrides config `max_tokens`). |
| `UC_MAX_BODY_BYTES` | `67108864` | Inbound `/v1/messages` body cap in bytes (0 disables); over it → `413`. |
| `UC_SHUTDOWN_GRACE_MS` | `10000` | Grace window to drain in-flight requests on SIGINT/SIGTERM before forcing sockets closed. |
| `UC_FORCE_EFFORT` | `xhigh` | Effort to force (empty = leave untouched). |
| `UC_FORCE_THINKING` | `1` | Force adaptive thinking. |
| `UC_INJECT_REMINDER` | `1` | Inject the Ultracode reminder. |
| `UC_FORCE_1M` | `0` | Force 1M on every request (overrides config `force_1m`). |
| `UC_EMPTY_RETRY_ATTEMPTS` / `UC_EMPTY_RETRY_BACKOFF` | `2` / `0.75` | Empty-turn retry. |
| `UC_MODEL_MAP` | `{}` | JSON map of extra `id → backend model` overrides. |
| `UC_LOG` / `UC_VERBOSE` | stderr / `0` | Log file / verbose logging. |

Codex: `CODEX_HOME`, `UC_CODEX_EFFORT`, `UC_CODEX_SERVICE_TIER`, `UC_CODEX_STREAM_IDLE_TIMEOUT`.
Cursor: `CURSOR_AGENT_BIN`, `CURSOR_AGENT_WORKSPACE`, `CURSOR_AGENT_TIMEOUT`, `CURSOR_AGENT_NO_PROXY`.

## 9. Architecture and file map

```
Claude Code → server.ts (thin HTTP) → envelope/[1m] transform → Provider (by backend kind)
                                                                  ├─ anthropic   (passthrough + 1M beta)
                                                                  ├─ openai_compat (Anthropic⇄OpenAI, tools)
                                                                  ├─ codex_oauth  (GPT-5.5 via login)
                                                                  └─ cursor_agent (Composer, experimental)
```

The source is layered: `config/` (load + normalize + validate), `core/` (env, ids,
log, runtime types, `which`), `net/` (HTTP client + SSE/Anthropic emitters),
`pipeline/` (envelope, `[1m]`, discovery, translation, retry), `providers/` (one
module per backend). A `RequestContext` carries the transformed body, route, 1M
intent, streaming flag, a request id, and an `AbortSignal` (so a downstream
disconnect aborts the upstream call).

| Path | What |
|------|------|
| `src/main.ts` | entry: load config, start server; `--models` / `--seed-cache` |
| `src/server.ts` | HTTP handler: health, `/v1/models`, `/v1/messages` routing |
| `src/config/config.ts` | JSONC loader + `normalizeModels` (entries → routing slots + discovery models, one each) |
| `src/config/{types,validate}.ts` | shared types / config validation |
| `src/core/{env,ids,log,which,runtime,metrics}.ts` | env + `${VAR}` / ids / redacting logger / `which` / context types / metrics |
| `src/net/{http,httpUtil,sse,emit}.ts` | HTTP client / header helpers / OpenAI→event / Anthropic SSE+JSON |
| `src/pipeline/envelope.ts` | the UltraCode envelope + `[1m]` enforcement |
| `src/pipeline/model1m.ts` | `[1m]` parsing + the `context-1m-2025-08-07` beta |
| `src/pipeline/models.ts` | `/v1/models` discovery merge (upstream + custom) |
| `src/pipeline/translate.ts` | Anthropic ⇄ OpenAI (tools both ways, strict-backend adjacency) |
| `src/pipeline/retry.ts` | empty-turn retry |
| `src/providers/*` | the Provider interface, registry, and one module per backend |
| `scripts/doctor.ts` | environment + config validator that runs the self-test |
| `test/unit/*.test.ts` | per-module unit tests (config, `[1m]`, envelope, translate, sse, http, retry, providers, env, discovery) |
| `test/integration.test.ts` | offline end-to-end self-test (no network/keys) |
| `test/helpers/harness.ts` | shared mock backend + proxy harness for the suites |
| `bin/ccmodel.mjs` | the cross-platform launcher |
| `scripts/{install-icons,uninstall}.mjs` | desktop entries + cleanup |

## 10. Troubleshooting

Run the doctor first — it catches most problems and prints the fix:
`npm run doctor`. Proxy log: `%LOCALAPPDATA%\ccmodel\proxy.log` (Windows) or
`~/.local/state/ccmodel/proxy.log`. Run the proxy in the foreground to watch it:
`UC_VERBOSE=1 node dist/src/main.js`.

| Symptom | Fix |
|---------|-----|
| **`[1m]` pick still caps at ~200K** | Confirm `curl -s localhost:8141/v1/models \| grep '\[1m\]'` lists it; with `UC_VERBOSE=1` a `[1m]` request logs `want1m=true` and (on passthrough) the beta is added. If it still caps, the cause is usually **eligibility** (plan doesn't grant 1M) or a **retired-beta** model (Sonnet 4/4.5) — not the header. |
| **Model missing from `/model`** | The auto id is always `claude-…`, so this is usually environment: use the launcher (it sets the discovery env var) with an OAuth login, not a raw API key. Reopen `/model`. |
| **401 / "invalid api key"** | The entry's `key` (or its `${VAR}`) is wrong/empty. Re-run the doctor. |
| **404 / "model not found"** | The entry's `model` isn't valid for that backend (it's the backend's id, not the `claude-…` alias), or `url` is wrong. |
| **Replies in text, never calls tools** | The model is on a passthrough/chat endpoint that drops tools. Give it an OpenAI-compatible `url` (or `"api": "openai"`) so tools are translated both ways. Real Claude handles tools natively. |
| **"insufficient tool messages following tool_calls"** | Strict backends (DeepSeek) after you reject a tool call. The proxy already synthesizes a stub and reorders replies — no config change needed. |
| **Answer contains `<think>…</think>`** | Add `"body": { "reasoning_split": true }` to the entry. |
| **Occasional empty reply** | Some upstreams return an empty turn; the proxy auto-retries (default 2). Tune `UC_EMPTY_RETRY_ATTEMPTS` / `UC_EMPTY_RETRY_BACKOFF`. |
| **Codex 401 / "run codex login"** | Your ChatGPT/Codex token expired — run `codex login` again. |
| **"Proxy did not become healthy"** | Port in use — set `port`/`UC_LISTEN_PORT`, or stop the stale `node … main.js`. Or the build is missing — `npm install && npm run build`. |
| **Did I break my normal Claude Code?** | No — ccmodel never edits `~/.claude`; use the **Claude Code (Normal)** icon or `npm run uninstall`. |

If `npm test` passes, the code is fine and the problem is configuration/credentials.

## 11. Develop and test

```bash
npm run build         # tsc -> dist/
npm test              # build + run the offline self-test (node:test, no network/keys)
npm run test:coverage # same, with V8 coverage (node --experimental-test-coverage)
npm run doctor        # validate environment + config, then run the self-test
npm run lint          # eslint . (typescript-eslint)
npm run format:check  # prettier --check .
```

The self-test (105 cases) is fully offline (an in-process mock backend) and is
split by concern:

| File | Covers |
|------|--------|
| `test/unit/config.test.ts` | normalization (id/type/auth inference, dedup, `${ENV}`), JSONC stripping, validation |
| `test/unit/model1m.test.ts` | `[1m]` parsing, beta-header add/idempotency/detection |
| `test/unit/envelope.test.ts` | the UltraCode envelope + 1M routing (suffix / force / global / header) |
| `test/unit/translate.test.ts` | Anthropic⇄OpenAI tools + the strict-backend tool-adjacency fix |
| `test/unit/discovery.test.ts` | `/v1/models` merge |
| `test/unit/sse.test.ts` | OpenAI SSE + JSON → internal events |
| `test/unit/http.test.ts` | the HTTP client (status passthrough, streaming, abort) + header helpers |
| `test/unit/retry.test.ts` | empty-turn retry + retryable-status policy |
| `test/unit/providers.test.ts` | the provider registry + cursor stream parsing |
| `test/unit/env.test.ts` | `${VAR}` expansion |
| `test/integration.test.ts` | end-to-end proxy over a mock backend (shared `test/helpers/harness.ts`) |

CI runs it on Node 20/22/24 × Linux/Windows, plus lint + format checks.

## 12. For AI assistants

If you're helping a user set ccmodel up: (0) the end state is they launch
**CCModel (All Models)**, open `/model`, and pick any configured backend including
a genuinely-1M `[1m]` variant. (1) `node`/`claude` present. (2) `npm install &&
npm run doctor` — if the self-test fails, the install is broken, stop and report
it. (3) Ask what they have (an OpenAI-compatible key → give it a `url`; a Codex
login → `"api": "codex"`; just Claude → still useful). Copy
`config.example.jsonc` → `config.jsonc`, one entry per model; only `model` is
required (`{ model, url, key }` covers most); mark genuinely-1M models by adding a
`[1m]` suffix to `model`; codex/cursor need `"api"`. (4) `npm run doctor` until
exit 0. (5) `npm run launch`. (6) Verify in
`/model`, send "say OK", confirm tools fire on an OpenAI-compatible model, and a
`[1m]` pick logs `want1m=true`. **Never** commit `config.jsonc`/`ccmodel.env`,
never touch global `~/.claude`, and never paper over a failing `npm test`.

## 13. Uninstall

- `npm run uninstall` stops a running proxy and removes the desktop launchers +
  session state (cross-platform). Your config and Claude Code are left alone.
- To remove everything, delete the repo folder. Your `~/.claude` and credentials
  are never modified by this project.
