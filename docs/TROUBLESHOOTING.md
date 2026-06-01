# Troubleshooting

**English** · [简体中文](TROUBLESHOOTING.zh-CN.md)

First, run the doctor — it catches most problems and prints the fix:

```
npm run doctor
```

Proxy log:
- Windows: `%LOCALAPPDATA%\ccmodel\proxy.log`
- mac/linux/WSL: `~/.local/state/ccmodel/proxy.log`

Run the proxy in the foreground to watch it live: `UC_VERBOSE=1 node dist/src/main.js`.

---

### My `[1m]` pick isn't getting 1M context (still capping ~200K)

This is the exact failure ccmodel exists to fix — work through it:

- **Confirm the variant is advertised.** `curl -s localhost:8141/v1/models | grep '\[1m\]'`
  should list `<id>[1m]`. If not, set `"advertise_1m_variants": true` (or the
  model's `"context_1m": true`) and restart.
- **Confirm the beta header is leaving the proxy.** With `UC_VERBOSE=1`, a `[1m]`
  request logs `want1m=true`. On Anthropic passthrough the proxy adds
  `anthropic-beta: context-1m-2025-08-07`. If you still cap at 200K, the cause is
  usually **eligibility**, not the header:
  - your plan may not grant 1M for that model (Sonnet 1M often needs usage
    credits; Opus 1M is included on Max/Team/Enterprise), or
  - you're on a **retired** beta model (Sonnet 4 / 4.5 lost the beta on
    2026-04-30) — switch to Opus 4.6+/Sonnet 4.6.
- **openai_compat backend?** 1M there is the backend's native limit, not an
  Anthropic beta. The proxy forwards a clean (suffix-stripped) id; make sure the
  backend model actually supports the context length you expect.

Full detail: [ONE_MILLION_CONTEXT.md](ONE_MILLION_CONTEXT.md).

### My model doesn't appear in `/model`

- **Id doesn't start with `claude`/`anthropic`.** Claude Code filters discovered
  ids with `/^(claude|anthropic)/i`. Rename it (e.g. `claude-mimo`).
- **Discovery not enabled.** The launcher sets
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; if you started `claude`
  yourself, set it (and `ANTHROPIC_BASE_URL`) or use the launcher.
- **First-open timing.** Close `/model` and reopen, or restart — the launcher
  pre-seeds the cache so it should show immediately.
- **You're not on an OAuth login.** Gateway discovery only triggers for
  first-party (OAuth) logins, not raw `ANTHROPIC_API_KEY` keys.

### The model is listed but the answer is an error / empty

- Check the proxy log for the upstream status line.
- **401 / "invalid api key":** the route's `auth` (or its `${VAR}`) is wrong/empty.
  Re-run the doctor.
- **404 / "model not found":** the route's `model` isn't valid for that backend
  (it's the backend's id, not the `claude-…` alias), or `upstream` is wrong.
- **Codex 401 / "run codex login":** your ChatGPT/Codex token expired — run
  `codex login` again.
- **Occasional empty reply:** some upstreams (GPT-5.5 at high effort, a flaky
  OpenAI-compatible backend) now and then return a turn with no text and no tool
  call. The proxy auto-retries a fresh turn (default 2) before giving up. Tune
  with `UC_EMPTY_RETRY_ATTEMPTS` / `UC_EMPTY_RETRY_BACKOFF`.
- **A turn hangs for minutes (codex):** the codex upstream sometimes opens the
  stream then goes silent. The reader uses a bounded idle timeout
  (`UC_CODEX_STREAM_IDLE_TIMEOUT`, default 150s) so a stall becomes a retryable
  error instead of blocking.

### It replies in text but never calls tools

The route is probably **passthrough** (or a chat endpoint that drops tools). Set
`"type": "openai_compat"` so the proxy translates Anthropic `tool_use`/`tool_result`
⇄ OpenAI `tool_calls` both ways. Real Claude (passthrough) handles tools natively.

### Rejecting a tool call errors with "insufficient tool messages following tool_calls message"

Seen on strict backends (DeepSeek). When you reject/skip a tool call, Claude Code
may send your comment in the same turn as the result — or send no result at all.
OpenAI requires every assistant `tool_calls` message to be *immediately* followed
by one `tool` message per id. The proxy emits the tool replies first,
**synthesizes a stub** for any unanswered call, and puts your comment after — no
config change needed.

### The answer contains `<think>…</think>` (MiniMax-M3 and other reasoning models)

Add `"body": { "reasoning_split": true }` to the `openai_compat` route so the
chain-of-thought is returned separately instead of inline. Other reasoning
backends may expose a similar flag under a different name; the generic `body`
dict passes whatever the provider documents.

### "Proxy did not become healthy"

- Another process is on the port. Set `proxy.listen_port` (or `UC_LISTEN_PORT`)
  and relaunch, or stop the stale `node … main.js`.
- Node not found, or the build is missing — run `npm install && npm run build`.
- Run it in the foreground to see the error: `node dist/src/main.js` (Ctrl-C to
  stop).

### The launcher won't start / "claude not found"

The launcher is plain Node (`node bin/ccmodel.mjs` / `npm run launch`) and works
the same on Windows, macOS, and Linux. If it can't find Claude Code, install it
(`npm i -g @anthropic-ai/claude-code`) and confirm `claude --version` works.

### Did I break my normal Claude Code?

No — this project never edits your global `~/.claude` config or credentials; it
only sets env for the launched process and uses a session `--settings` file. Use
the **Claude Code (Normal)** icon, or `npm run uninstall` to remove the launchers
+ session state.

### Prove the install itself is fine

```
npm test
```

If the offline self-test passes, the code is good and the problem is
configuration/credentials. If it fails, re-clone and report the output.
