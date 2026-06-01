# 添加一个模型

[English](ADD_A_MODEL.md) · **简体中文**

一切都在一个文件里:**`config.jsonc`**(首次运行时从 `config.example.jsonc` 复制)。要添加一个
后端,你编辑两个部分:

1. **`models`** —— 出现在 Claude Code `/model` 选择器里的条目。
2. **`routes`** —— 每个 id 实际去往哪里。

```jsonc
{
  "models": [
    { "id": "claude-mimo", "display_name": "MiMo v2.5 Pro" }
  ],
  "routes": {
    "claude-mimo": {
      "type": "openai_compat",
      "upstream": "https://token-plan-sgp.xiaomimimo.com/v1",
      "model": "mimo-v2.5-pro",
      "auth": "Bearer ${MIMO_API_KEY}"
    }
  }
}
```

> **两条规则:**
> 1. `models` 里的每个 `id` **必须以 `claude` 或 `anthropic` 开头** —— 其余的会被 Claude Code
>    从 `/model` 里丢掉。
> 2. `models` 里的 `id` 必须**等于** `routes` 里的 key(若你选 `[1m]` 变体,则等于其基础 id ——
>    代理会在路由前去掉后缀)。
>
> 跑 `npm run doctor`,它会替你检查这两点。

## key 放在哪

`config.jsonc` 已被 gitignore,所以你可以把 key **直接写在文件里**(`"auth": "Bearer sk-…"`),
或用 **`${ENV}`** 展开(`"auth": "Bearer ${MIMO_API_KEY}"`)把它留在文件外。启动器还会加载仓库
根目录下一个可选、被 gitignore 的 **`ccmodel.env`**:

```
MIMO_API_KEY=...
OPENROUTER_API_KEY=...
```

## 添加 `[1m]` 100 万上下文变体

任何模型都能在选择器里多出一个 1M 上下文兄弟。完整说明见
[ONE_MILLION_CONTEXT.zh-CN.md](ONE_MILLION_CONTEXT.zh-CN.md);速记版:

- **单个模型:** 在其 `models` 条目加 `"context_1m": true` → 出现一个 `<id>[1m]` 选项。
- **所有模型:** 设 `"proxy": { "advertise_1m_variants": true }`。
- **某路由始终启用:** 给该路由加 `"context_1m": "force"`。

```jsonc
{ "id": "claude-opus-4-8", "display_name": "Opus 4.8", "context_1m": true }
```

## 路由类型

### `openai_compat` —— 任何讲 OpenAI Chat Completions 的

MiMo、DeepSeek、StepFun、Ollama Cloud、OpenRouter、OpenAI、Together、本地 llama.cpp / LM Studio
服务等。工具调用双向翻译。

```jsonc
"claude-openrouter": {
  "type": "openai_compat",
  "upstream": "https://openrouter.ai/api/v1",
  "model": "meta-llama/llama-3.3-70b-instruct",
  "auth": "Bearer ${OPENROUTER_API_KEY}"
}
```

- `upstream` 是**provider 文档里写的那个 OpenAI 基础 URL**(通常以 `/v1` 结尾)。代理会自动
  追加 `/chat/completions`。
- `model` 是后端真实的 id,**不是** `claude-…` 别名。
- 可选:`headers`(字典,支持 `${VARS}`)、`max_output_tokens`(补全上限,默认 8192)、
  `body`(合并进每个请求的字典,支持 `${VARS}`)、`context_1m`(`true` / `"force"` / `"variant"`)。

一个**本地**服务同理,key 通常被忽略:

```jsonc
"claude-local": {
  "type": "openai_compat",
  "upstream": "http://127.0.0.1:11434/v1",
  "model": "your-local-model",
  "auth": "Bearer local"
}
```

### MiniMax-M3

兼容 OpenAI,有两点值得设置:

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

- **`"body": { "reasoning_split": true }`** 把 M3 的 `<think>` 思维链留在可见回答之外(改为
  返回在 `reasoning_content` 里)。不设它的话,回复里会出现原始的 `<think>…</think>`。
- M3 原生上下文约 **1M**,所以 `"context_1m": "force"` 很合适。
- `max_output_tokens` 最高可到 64000。

### Anthropic 直通 —— 真·Claude 或兼容 Anthropic 的端点

省略 `type`(或设 `"anthropic"`)。不带 `auth`/`upstream` 时,就是带 UltraCode 信封(以及
`[1m]` 1M 保证)的真·Claude。它也覆盖那些自带原生 Anthropic 端点的 provider,比如
**DeepSeek**(已验证):

```json
"claude-deepseek-v4-pro": {
  "upstream": "https://api.deepseek.com/anthropic",
  "model": "deepseek-v4-pro",
  "auth": "Bearer ${DEEPSEEK_API_KEY}"
}
```

或者指向一个 Anthropic 形态的网关并加头部:

```jsonc
"claude-opencode": {
  "upstream": "https://opencode.ai/zen/go",
  "model": "claude-sonnet-4-5",
  "auth": "Bearer ${OPENCODE_API_KEY}",
  "headers": { "User-Agent": "openclaw/2026.4.20" }
}
```

### `codex_oauth` —— 用 ChatGPT/Codex 登录跑 GPT-5.5(无需 API key)

```jsonc
"claude-gpt-5.5-codex": { "type": "codex_oauth", "model": "gpt-5.5" }
```

跑一次 `codex login`(生成 `~/.codex/auth.json`)。可选环境变量:`UC_CODEX_EFFORT`、
`UC_CODEX_SERVICE_TIER`、`CODEX_HOME`、`UC_CODEX_STREAM_IDLE_TIMEOUT`。

### `cursor_agent` —— Cursor Composer(实验性)

```jsonc
"claude-composer": { "type": "cursor_agent", "model": "composer-2.5" }
```

需要 `cursor-agent` CLI 并 `cursor-agent login`。以只读 "ask" 模式运行,工具调用用尽力而为的
桥接 —— 推理/问答很好用。可调项:`CURSOR_AGENT_TIMEOUT`(默认 240s)、`CURSOR_AGENT_WORKSPACE`、
`CURSOR_AGENT_NO_PROXY=1`(若有 TLS 拦截代理导致卡住)。

编辑完后,校验并启动:

```
npm run doctor
npm run launch                   # 跨平台:Windows / macOS / Linux / WSL
```
