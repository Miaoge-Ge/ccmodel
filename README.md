# ccmodel

**English** · [简体中文](README.zh-CN.md)

A zero-dependency loopback proxy that brings Claude Code's UltraCode behavior, and
a reliable `[1m]` 1M-token context, to any model you already pay for — selectable
live from the `/model` menu.

```
   Claude Code ──ANTHROPIC_BASE_URL──▶ ccmodel proxy ──▶ Claude · DeepSeek · GPT-5.5 · MiniMax-M3 · …
                   (loopback :8141)        │  applies the UltraCode envelope per backend
                                           │  guarantees 1M context for [1m] picks
                                           └  routes each /model selection to its provider
```

## Overview

ccmodel sits on Claude Code's `ANTHROPIC_BASE_URL` and adds two capabilities that
stock Claude Code does not provide, without a secret model and without modifying
your installation:

1. **UltraCode on any backend.** At the API boundary, UltraCode is an envelope on
   each request — maximum effort, adaptive thinking, a raised `max_tokens` floor,
   and a Workflow system reminder. ccmodel applies that envelope per backend kind:
   Anthropic-family backends receive it in full; Codex retains the effort (mapped
   to its reasoning effort); OpenAI-compatible and Cursor backends are not sent
   Claude-specific fields they cannot use.
2. **A 1M context that is guaranteed, not best-effort.** The `[1m]` suffix is meant
   to deliver a 1,000,000-token window, but the beta header that unlocks it is
   dropped on several Claude Code code paths, silently capping the request at 200K.
   ccmodel re-adds the `anthropic-beta: context-1m-2025-08-07` header on every
   request that needs it, so `[1m]` reliably means 1M.

Your existing Claude Code installation is left untouched; ccmodel only sets
environment variables for the process it launches and passes a session-scoped
`--settings` file.

## Requirements

- **Node.js 20+** — the runtime uses only Node built-ins; TypeScript is a build-time
  dev dependency.
- **Claude Code CLI** with UltraCode access (`npm i -g @anthropic-ai/claude-code`).
- **At least one backend credential** — an API key (DeepSeek, MiniMax, OpenRouter,
  a local server, …) and/or `codex login` for GPT-5.5. Real Claude with `[1m]`
  requires only your existing login.

A single launcher (`bin/ccmodel.mjs`) supports Windows, macOS, Linux, and WSL.

## Quick start

```bash
git clone git@github.com:Miaoge-Ge/ccmodel.git && cd ccmodel

npm install                              # install dev deps and build
npm run doctor                           # validate environment + config, run the offline test suite
cp config.example.jsonc config.jsonc     # Windows: copy config.example.jsonc config.jsonc
#   edit config.jsonc — add your models and keys

npm run launch                           # build (first run), start the proxy, open Claude Code
```

In Claude Code, open `/model` and select a backend. Entries ending in `[1m]` run
at a 1,000,000-token context window.

> ccmodel sessions start in **`bypassPermissions`** mode (no per-action prompts) —
> session-scoped, so your global `~/.claude` is untouched. Restore prompts with
> `ccmodel --permission-mode default` (or Shift+Tab mid-session). Details:
> [MANUAL §9](docs/MANUAL.md#9-permissions-and-security).

- `npm run launch -- --proxy-only` starts only the proxy and leaves it running.
- `npm run icons` installs cross-platform desktop launchers.
- `npm run uninstall` stops the proxy and removes the launchers and session state.

### Use it from any directory

To launch ccmodel on other projects without `cd`-ing back here, install it on your
`PATH` once:

```bash
npm link        # from this repo — symlinks the `ccmodel` command globally
```

Then, from any project folder:

```bash
cd ~/some/other/project
ccmodel          # starts the proxy and opens Claude Code here, using this repo's config.jsonc
```

`ccmodel --version` shows the version and the linked repo; `ccmodel --help` lists
the options; any other arguments pass through to `claude`. Remove the global link
with `npm rm -g ccmodel`. (`npm i -g .` also works, but `npm link` keeps the global
command pointed at this repo, so config and code edits take effect immediately.)

## Configuration

The entire configuration is a single list of models in `config.jsonc` (JSONC, so
comments and trailing commas are permitted; the file is gitignored). A typical
entry requires three fields:

```jsonc
{
  "models": [
    { "model": "deepseek-v4-pro",  "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" },
    { "model": "MiniMax-M3[1m]",   "url": "https://api.minimax.io/v1",          "key": "${MINIMAX_API_KEY}" }
  ]
}
```

- **`model`** (required) — the backend model id. A trailing `[1m]` marks it as a
  1M-context model; the suffix is stripped before the id reaches the backend.
- **`url`** — determines the backend kind: a `…/anthropic` URL is treated as an
  Anthropic passthrough, any other URL as OpenAI-compatible. Omit for real Claude.
- **`key`** — the API key (supports `${ENV}` expansion). Omit for login-based
  (Codex) or keyless (local) backends.

Everything else — the backend id, the `/model` id, and the auth header — is
inferred. The complete reference (backend kinds, per-model options, the 1M
guarantee, environment variables, architecture, and troubleshooting) is in the
**[System Manual](docs/MANUAL.md)**.

## Development

```bash
npm run build           # compile TypeScript to dist/
npm test                # build and run the offline test suite (no network or keys)
npm run test:coverage   # the suite with V8 coverage
npm run lint            # ESLint
npm run format:check    # Prettier
```

The test suite (139 cases) runs entirely offline against an in-process mock
backend. Continuous integration runs lint, format-check, and the suite on Node
20/22/24 across Linux and Windows.

## Documentation

| Document | English | 中文 |
|----------|---------|------|
| System manual — setup, configuration, the 1M guarantee, environment variables, architecture, troubleshooting | [MANUAL.md](docs/MANUAL.md) | [手册](docs/MANUAL.zh-CN.md) |
| Contributing guide | [CONTRIBUTING.md](CONTRIBUTING.md) | [贡献指南](CONTRIBUTING.zh-CN.md) |
| Security policy | [SECURITY.md](SECURITY.md) | [安全策略](SECURITY.zh-CN.md) |
| Release notes | [CHANGELOG.md](CHANGELOG.md) | — |

## License

MIT — see [LICENSE](LICENSE). This is an unofficial, community project, not
affiliated with Anthropic, OpenAI, DeepSeek, or any provider. You are responsible
for complying with the terms of the accounts you route through it.
