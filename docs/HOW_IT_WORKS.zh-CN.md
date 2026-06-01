# 工作原理

[English](HOW_IT_WORKS.md) · **简体中文**

ccmodel 是一个小巧的本地回环代理加一个启动器。没有魔法,也没有秘密模型。

## 1. “UltraCode” 到底是什么

在 Anthropic API 边界上,Claude Code 的 **UltraCode** 模式并不是某个隐藏模型 —— 它只是套在
普通 `/v1/messages` 请求上的一个「信封」:

| 字段 | UltraCode 取值 | 含义 |
|------|----------------|------|
| `output_config.effort` | `"xhigh"` | 最高推理强度 |
| `thinking` | `{"type": "adaptive"}` | 开启扩展/自适应思考 |
| `max_tokens` | `>= 64000` | 给长而充分的回答留空间 |
| `system` | + 一条 *“Ultracode is on…”* 提醒块 | 引导走向 Workflow/质量范式 |

任何讲 Anthropic Messages API、并尊重这些字段的后端,都能得到 UltraCode 待遇。因为这只是请求
的「形状」,代理就可以把同样的信封套上,再转发给**任意**后端。

## 2. `[1m]` 到底是什么

`[1m]` 是 Claude Code 表示某模型 1M 上下文变体的约定。真正在 Anthropic API 上解锁 1M 的开关
是头部 `anthropic-beta: context-1m-2025-08-07`。该头部会在 Claude Code 的多条代码路径里被丢掉,
于是 `[1m]` 可能悄悄退回 20 万。ccmodel 会在每个需要的请求上保证该头部。完整说明见
[ONE_MILLION_CONTEXT.zh-CN.md](ONE_MILLION_CONTEXT.zh-CN.md)。

## 3. 代理

通过 `ANTHROPIC_BASE_URL` 把 Claude Code 指向它(启动器替你做)。对每个请求它会:

1. 在 `POST /v1/messages` 上**强制注入信封**(可用 `UC_FORCE_EFFORT`、`UC_FORCE_THINKING`、
   `UC_MAX_TOKENS`、`UC_INJECT_REMINDER` 调整)。
2. **解析 `[1m]`**:检测 1M 意图、去掉后缀,并在 Anthropic 直通路径上保证
   `context-1m-2025-08-07` beta 头部。
3. **提供 `GET /v1/models`**,把 Anthropic 真实模型列表与你的自定义模型及其 `[1m]` 变体合并。
4. 按 `config.jsonc` 的 `routes` 把每个模型 ID **路由**到真实后端。

## 4. 为什么你的模型会出现在 `/model`(网关发现)

当 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 时,Claude Code 会调用网关的
`GET /v1/models` 并列出返回的内容。启动器会设置该环境变量,并预先播种 Claude Code 的
`cache/gateway-models.json`(通过 `node dist/src/main.js --seed-cache`),这样你的模型 —— 及其
`[1m]` 兄弟 —— 第一次打开就能显示。

> **Claude Code 的硬性规则:** 发现到的 ID 会被 `/^(claude|anthropic)/i` 过滤。每个 `id`
> (因而每个 `<id>[1m]` 变体)都必须以 `claude` 或 `anthropic` 开头。网关发现只在第一方
> (OAuth)登录下触发,裸 `ANTHROPIC_API_KEY` 不行。

## 5. 把每个选择路由到真实后端

- **Anthropic 直通**(无 `type`,或 `type: "anthropic"`)—— 原样转发到 `upstream`(默认真·Claude)。
  工具原生可用。这条路径会得到 1M beta 头部保证。
- **`openai_compat`** —— 把 Anthropic 请求翻译成 OpenAI Chat Completions,POST 到
  `upstream + /chat/completions`,再把响应翻译回来。**工具调用双向翻译**,流式 SSE 重新发成
  Anthropic SSE。覆盖 MiniMax、OpenRouter、OpenAI、Ollama、本地 llama.cpp/LM Studio 等。
- **`codex_oauth`** —— 通过你的 ChatGPT/Codex *登录*(无需 API key)走 GPT-5.5,使用
  `codex login` 得到的 token。
- **`cursor_agent`**(实验性)—— 通过 `cursor-agent` CLI 桥接到 Cursor 的 Composer。

## 6. 哪些东西会接触你的机器

- 启动器只为**被启动的进程**设置环境变量(`ANTHROPIC_BASE_URL`、发现开关),并传入一个
  会话级 `--settings` 文件。你全局的 `~/.claude` 配置与凭证从不被修改。
- `config.jsonc`(你的 key/选择)被 **gitignore**。
- Claude Code 退出时代理会被停止。

## 架构与文件地图(TypeScript 源码 → `dist/`)

| 路径 | 作用 |
|------|------|
| `src/main.ts` | 入口:加载配置、启动服务;`--models` / `--seed-cache` 辅助命令 |
| `src/server.ts` | HTTP 处理:健康检查、`/v1/models`、`/v1/messages` 路由分发 |
| `src/envelope.ts` | UltraCode 信封 + `[1m]` 强制(含每路由覆盖) |
| `src/model1m.ts` | `[1m]` 解析、`context-1m-2025-08-07` beta、头部合并 |
| `src/models.ts` | `/v1/models` 合并 + `[1m]` 变体广告 |
| `src/translate.ts` | Anthropic ⇄ OpenAI(工具双向、严格后端的工具相邻性) |
| `src/sse.ts` / `src/emit.ts` | OpenAI→事件解析 / Anthropic SSE + JSON 发射器 |
| `src/retry.ts` | 空回合重试 |
| `src/config.ts` | JSONC 加载、routes→slots、models |
| `src/providers/provider.ts`、`registry.ts` | Provider 接口 + 注册表(路由类型 → provider) |
| `src/providers/{anthropic,openai,codex,cursor}Provider.ts` | 每个后端一个模块 |
| `src/validate.ts` | 配置校验(错误 + 警告),启动时呈现 |
| `scripts/doctor.ts` | 环境 + 配置校验器,会运行自测 |
| `test/proxy.test.ts` | 离线端到端自测(无网络/密钥) |
| `bin/ccmodel.mjs` | 跨平台启动器(Windows / macOS / Linux / WSL) |
| `scripts/install-icons.mjs`、`scripts/uninstall.mjs` | 跨平台桌面项 + 清理 |
