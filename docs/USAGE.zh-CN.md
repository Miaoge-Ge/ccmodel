# 使用方法参考

[English](USAGE.md) · **简体中文**

一份可直接复制粘贴的实用参考。第一次用?先看
[README](../README.zh-CN.md) 和 [安装指南](SETUP.zh-CN.md)。

## 命令

| 命令 | 作用 |
|------|------|
| `npm install` | 安装开发依赖并构建 `dist/`。 |
| `npm run doctor` | 校验环境 + 配置,然后跑离线自测。 |
| `npm run launch` | 首次会自动构建,启动代理,打开 Claude Code。 |
| `npm run launch -- --proxy-only` | 只启动代理并让它常驻(分离运行)。 |
| `npm run icons` | 创建桌面启动项(`.lnk` / `.command` / `.desktop`)。 |
| `npm run uninstall` | 停止代理,移除启动项 + 会话状态。 |
| `npm test` | 构建并运行离线自测。 |
| `npm run build` | 把 TypeScript 编译到 `dist/`。 |
| `node dist/src/main.js --models` | 以 JSON 打印广告出的模型列表。 |

启动器与代理都读取 `config.jsonc`(没有则回退到 `config.example.jsonc`)。

## 全流程:在 `/model` 里选后端

1. `cp config.example.jsonc config.jsonc` 并编辑(保留你用的,填上 key)。
2. `npm run doctor` 直到退出码为 0。
3. `npm run launch`。
4. 在 Claude Code 里输入 `/model`。你会看到你的模型,每个都带一个
   `…[1m]` 兄弟条目。选一个即可开干。

## 配置范例

### A. DeepSeek(原生 Anthropic 直通 —— 已验证)

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
export DEEPSEEK_API_KEY=sk-...   # 或写进被 gitignore 的 ccmodel.env
npm run launch
```

### B. 兼容 OpenAI 的后端(MiniMax-M3、OpenRouter、本地服务……)

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

### C. 用 ChatGPT/Codex 登录跑 GPT-5.5(无需 API key)

```bash
codex login            # 跑一次,生成 ~/.codex/auth.json
```
```jsonc
"claude-gpt-5.5-codex": { "type": "codex_oauth", "model": "gpt-5.5" }
```

### D. 拒绝信封字段的严格后端

```jsonc
"claude-strict": {
  "upstream": "https://example/anthropic",
  "model": "some-model",
  "auth": "Bearer ${KEY}",
  "envelope": { "effort": false, "thinking": false }
}
```

## 开启 100 万上下文

| 你想要 | 配置 |
|--------|------|
| 仅在你主动选时 | `"proxy": { "advertise_1m_variants": true }`,然后在 `/model` 里选 `…[1m]`。 |
| 仅某个模型 | `{ "id": "claude-x", "context_1m": true }` |
| 某条路由始终 | 该路由加 `"context_1m": "force"` |
| 全部、始终 | `"proxy": { "force_1m": true }`(仅当所有后端都支持时) |

详见 [ONE_MILLION_CONTEXT.zh-CN.md](ONE_MILLION_CONTEXT.zh-CN.md)。

## 验证是否在工作

```bash
curl -s localhost:8141/healthz                  # ok、版本、providers、1M 策略
curl -s localhost:8141/v1/models | grep '\[1m\]' # [1m] 变体已被广告
UC_VERBOSE=1 node dist/src/main.js               # 观察每请求日志(模型、want1m、耗时)
```

## 环境变量

| 变量 | 默认 | 用途 |
|------|------|------|
| `UC_LISTEN_HOST` | `127.0.0.1` | 绑定地址。 |
| `UC_LISTEN_PORT` | `8141` | 监听端口(覆盖 `proxy.listen_port`)。 |
| `UC_UPSTREAM` | `https://api.anthropic.com` | 默认 Anthropic 上游。 |
| `UC_CONFIG` | 自动 | 配置文件路径。 |
| `UC_MAX_TOKENS` | `64000` | `max_tokens` 下限。 |
| `UC_FORCE_EFFORT` | `xhigh` | 强制的 effort(置空 = 不改)。 |
| `UC_FORCE_THINKING` | `1` | 强制自适应 thinking。 |
| `UC_INJECT_REMINDER` | `1` | 注入 Ultracode 提醒。 |
| `UC_FORCE_1M` | `0` | 每个请求都强制 1M。 |
| `UC_EMPTY_RETRY_ATTEMPTS` / `UC_EMPTY_RETRY_BACKOFF` | `2` / `0.75` | 空回合重试。 |
| `UC_MODEL_MAP` | `{}` | 额外的 `id → 后端模型` 覆盖映射(JSON)。 |
| `UC_LOG` / `UC_VERBOSE` | stderr / `0` | 日志文件 / 详细日志。 |

Codex:`CODEX_HOME`、`UC_CODEX_EFFORT`、`UC_CODEX_SERVICE_TIER`、`UC_CODEX_STREAM_IDLE_TIMEOUT`。
Cursor:`CURSOR_AGENT_BIN`、`CURSOR_AGENT_WORKSPACE`、`CURSOR_AGENT_TIMEOUT`、`CURSOR_AGENT_NO_PROXY`。

卡住了?见 [TROUBLESHOOTING.zh-CN.md](TROUBLESHOOTING.zh-CN.md)。
