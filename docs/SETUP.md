# Setup

**English** · [简体中文](SETUP.zh-CN.md)

Works on **Windows 11** (no WSL required) and on **macOS / Linux / WSL**.

## 1. Prerequisites

| Need | Check | Get it |
|------|-------|--------|
| Node.js 18+ | `node --version` | https://nodejs.org (Windows: tick **Add to PATH**) |
| Claude Code CLI | `claude --version` | `npm i -g @anthropic-ai/claude-code` |
| UltraCode access | you've used `/effort ultracode` before | part of your Claude plan |
| ≥1 backend credential | — | an API key and/or `codex login` |

Only **dev** dependencies (TypeScript, type defs) are installed; the proxy runs
on Node built-ins.

## 2. Clone, build, check

```bash
git clone <this-repo> ccmodel
cd ccmodel
npm install        # installs dev deps and builds (dist/)
npm run doctor     # validates env + config, runs the offline self-test
```

If the doctor says `self-test passed`, the install is good. (Safe to run anytime.)

## 3. Configure your models

```bash
copy config.example.jsonc config.jsonc   # Windows
cp   config.example.jsonc config.jsonc   # mac/linux
```

`config.jsonc` is gitignored. Keep the entries you want in `models` + `routes`,
delete the rest, and put each key inline or as `${VAR}`. Per-backend templates:
[ADD_A_MODEL.md](ADD_A_MODEL.md). Turning on the `[1m]` 1M-context variants:
[ONE_MILLION_CONTEXT.md](ONE_MILLION_CONTEXT.md).

### GPT-5.5 via ChatGPT/Codex login (optional)

1. Install the Codex CLI and run `codex login` once → creates `~/.codex/auth.json`.
2. Keep the `claude-gpt-5.5-codex` entries. No API key needed.

## 4. Re-run the doctor

```bash
npm run doctor
```

Resolve any `[FAIL]` lines (each prints the fix) until it exits cleanly.

## 5. Launch (cross-platform)

One launcher works on Windows, macOS, Linux, and WSL:

```bash
npm run launch          # == node bin/ccmodel.mjs
```

It builds on first run, starts the proxy, enables gateway discovery, seeds the
model cache, and opens Claude Code. `npm run launch -- --proxy-only` starts just
the proxy and leaves it running.

Optional desktop launchers (Windows `.lnk` / macOS `.command` / Linux `.desktop`):

```bash
npm run icons
```

Creates **CCModel (All Models)** (proxy + Claude Code, discovery on) and **Claude
Code (Normal)** (your usual install, untouched).

## 6. Use it

Launch, type `/model`, pick a backend. Everything runs with full UltraCode. The
picks labeled **`[1m]`** run at a 1,000,000-token
window.

## Uninstall

- `npm run uninstall` stops a running proxy and removes the desktop launchers +
  session state (cross-platform). Your config and Claude Code are left alone.
- To remove everything, delete the repo folder. Your `~/.claude` and credentials
  are never modified by this project.
