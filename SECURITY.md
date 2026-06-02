# Security Policy

**English** · [简体中文](SECURITY.zh-CN.md)

## Reporting a vulnerability

ccmodel is an unofficial, community project. If you find a security issue, please
report it **privately** — open a GitHub Security Advisory (preferred) or contact
the maintainer directly — rather than filing a public issue. Include a
description, reproduction steps, and the impact you observed. Please allow a
reasonable window for a fix before any public disclosure.

## How ccmodel handles credentials

ccmodel is a loopback proxy you run yourself; understanding its trust model
matters more than most:

- **Your keys live in `config.jsonc` / `ccmodel.env`**, both gitignored. Keep them
  that way — never commit them. Prefer `${ENV_VAR}` references over inline keys.
- **It binds to `127.0.0.1` by default.** Do not expose the proxy on a public
  interface; it performs no client authentication and would forward your
  upstream credentials to whoever can reach it.
- **Credentials are never cross-forwarded.** ccmodel sends only the configured
  `key` for the matched backend, and it strips Claude Code's own inbound
  credential before talking to a third-party (OpenAI-compatible) backend.
- **Logs are redacted.** `Bearer` tokens, `authorization`/`x-api-key` values, and
  `sk-…` key shapes are masked before anything is written to the log file or
  stderr. Logs may still contain prompt/response content — treat the log file
  (`%LOCALAPPDATA%\ccmodel\proxy.log` / `~/.local/state/ccmodel/proxy.log`) as
  sensitive.
- **Your global Claude Code install is untouched.** ccmodel only sets env for the
  process it launches and passes a session-scoped `--settings` file; it never
  edits `~/.claude`.

## Scope and responsibility

You are responsible for complying with the terms of whatever accounts and
providers you route through ccmodel. Routing a provider through it may have
billing and eligibility implications that are between you and that provider.

## Supported versions

Only the latest release line receives fixes. Run a current version and a current,
supported Node.js (20+).
