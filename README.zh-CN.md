# ccmodel

[English](README.md) · **简体中文**

**在任何你已经付费的模型上，跑出 Claude Code 的 UltraCode 模式 —— 以及一个*真正可靠*的
`[1m]` 100 万 token 上下文。** 直接在 `/model` 菜单里实时选择。

```
   Claude Code  ──ANTHROPIC_BASE_URL──▶  ccmodel 代理  ──▶  真·Claude / DeepSeek / GPT-5.5 / MiniMax-M3 / …
                    (本地回环 :8141)        ├─ 强制注入 UltraCode 信封
                                            ├─ 为 [1m] 选项「保证」100 万上下文
                                            └─ 把每个 /model 选项路由到对应 provider
```

ccmodel 是一个轻量、几乎零依赖的 **TypeScript/Node** 代理 —— 运行时只用 Node 内置模块
（运行它无需任何额外安装），它最核心的能力是：

> ### `[1m]` 保证
> 给任意模型加上 `[1m]`，它就会**真正用上 1,000,000 token 的上下文窗口** —— 不会再
> 悄悄退回到 20 万。代理会在每个需要的请求上注入
> `anthropic-beta: context-1m-2025-08-07` 头部，**即使 Claude Code 在传入途中把它丢掉了**
> （子代理、`--model` 参数、网关路由里都真实存在这种丢头部的 bug）。详见
> **[docs/ONE_MILLION_CONTEXT.zh-CN.md](docs/ONE_MILLION_CONTEXT.zh-CN.md)**。

## 为什么需要它

在原生 Claude Code 之上，做两件事：

1. **让任意模型用上 UltraCode。** 在 API 层面，“UltraCode” 不过是
   `effort=xhigh` + 自适应 thinking + 较大的 `max_tokens` + 一条系统提醒 —— 没有什么
   秘密模型。ccmodel 把这个“信封”加到每个请求上，再转发给你选的任意后端。
2. **一个不会撒谎的 100 万上下文。** Claude Code 的 `[1m]` 后缀本应给你 100 万 token，
   但真正解锁它的 beta 头部会在好几条代码路径里被丢掉，于是你被悄悄限制在 20 万。
   ccmodel 正好处在能在每个请求上把这个头部补回去的位置 —— 所以 `[1m]` 就是 1M。

你日常的 Claude Code 安装**完全不受影响**（只用会话级 `--settings` + 环境变量）。

## 你需要准备

- **Node.js 18+**（`node --version`）。代理在运行时只用 Node 内置模块 —— **运行**它无需
  安装任何东西；TypeScript 只是构建用的开发依赖。
- **Claude Code CLI**，并具备 UltraCode 权限（`npm i -g @anthropic-ai/claude-code`）。
- **至少一个后端凭证** —— 一个 API key（DeepSeek / MiniMax / OpenRouter / 本地服务……），
  和/或用于 GPT-5.5 的 `codex login`。真·Claude 的 `[1m]` 只需要你现有的登录。

一个启动器（`bin/ccmodel.mjs`）就能在 **Windows、macOS、Linux、WSL** 上运行 —— 不再需要
PowerShell 或 bash 脚本。

## 快速开始

```bash
git clone <本仓库> ccmodel && cd ccmodel

# 1. 构建 + 自检（安装开发依赖、校验配置、跑离线自测）。
npm install
npm run doctor

# 2. 选择你的模型：复制示例并编辑（config.jsonc 已被 gitignore）。
cp config.example.jsonc config.jsonc      # Windows: copy config.example.jsonc config.jsonc

# 3.（可选）桌面启动图标 —— 跨平台（.lnk / .command / .desktop）。
npm run icons

# 4. 启动。首次运行会自动构建，启动代理并打开 Claude Code。
npm run launch          # 等价于 node bin/ccmodel.mjs
#   然后输入 /model 选择后端。带 `[1m]` 后缀的选项会以 100 万上下文运行。
```

`npm run launch -- --proxy-only` 只启动代理（并让它常驻）；
`npm run uninstall` 会停止它并移除启动图标与会话状态。

## 配置你的模型

一切都在一个文件里：**`config.jsonc`**（从 `config.example.jsonc` 复制而来）。它是 JSONC ——
支持 `//`、`/* */` 注释和尾逗号。**整个配置就是一个模型列表** —— 你想在 `/model` 里看到的
每个模型写一条。只有 `name` 是必填的，其余全部自动推断：

| 你写的 | 代理推断出 |
|--------|-----------|
| `name`（必填） | `/model` 里的显示名 **以及** id `claude-<slug(name)>`（Claude Code 只保留 `claude`/`anthropic` 开头的 id） |
| `url` | **后端类型**：`…/anthropic` → 直通；其他 → OpenAI 兼容。真·Claude 则省略不写。 |
| `key` | 鉴权头 —— 包装成 `Authorization: Bearer <key>`（也可直接写 `"x-api-key: …"`）。省略则复用 Claude Code 自己的凭证。 |
| *(什么都不写)* | 一个 `<name>[1m]` 的 100 万上下文变体，自动出现在菜单里 |

### 已验证示例：DeepSeek（原生 Anthropic 端点）

DeepSeek 自带一个原生兼容 Anthropic 的端点，所以 `…/anthropic` 的 url 会被自动识别为
**passthrough（直通）** —— 工具调用、流式、模型的 `thinking` 思考块全都原生可用。本示例已
端到端实测通过（非流式、流式、以及 `[1m]`）：

```jsonc
{
  "models": [
    { "name": "DeepSeek V4 Flash", "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}", "model": "deepseek-v4-flash" },
    { "name": "DeepSeek V4 Pro",   "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}", "model": "deepseek-v4-pro" }
  ]
}
```

key 可以直接写在文件里（已被 gitignore），也可以用 `${ENV_VAR}` —— 通过环境变量导出，或写进
一个被 gitignore 的 `ccmodel.env`（启动器会加载它）。

### 后端类型

类型由 `url` 推断（或用 `api` 强制指定）：

| 类型 | 何时使用 | 需要 |
|------|----------|------|
| Anthropic 直通 | 不写 `url`（真·Claude），或 `…/anthropic` 的 url（DeepSeek、任意兼容 Anthropic 的端点） | 无，或 `key`/`url` |
| OpenAI 兼容 | 其他任意 `url` —— MiniMax、OpenRouter、OpenAI、Ollama、本地 llama.cpp（工具会双向转换） | `key`（本地服务可省略） |
| Codex（`"api": "codex"`） | 通过 ChatGPT/Codex 登录使用 GPT-5.5（无需 API key） | 跑一次 `codex login` |
| Cursor（`"api": "cursor"`） | Cursor Composer（实验性） | `cursor-agent login` |

### 每个模型的可选项

都是可选的，和 `name`/`url`/`key`/`model` 并列：

- `api` —— 强制后端类型（`anthropic` / `openai` / `codex` / `cursor`），不再从 `url` 推断。
- `id` —— 覆盖自动生成的 id（必须以 `claude`/`anthropic` 开头，否则会被加前缀）。
- `1m` —— `true`（默认：广告一个 `[1m]` 变体）、`"force"`（始终 1M）、或 `false`（不广告变体）。
- `effort` —— 设置另一个 effort 等级，或设为 `false` 以对严格后端停止强制 effort。
- `max_output_tokens` —— OpenAI 兼容后端的补全上限（默认 8192）。
- `body` —— 合并进每个 OpenAI 兼容请求的额外参数（如 MiniMax-M3 的
  `{ "reasoning_split": true }`）。支持 `${VARS}`。
- `headers` —— 额外请求头（支持 `${VARS}`）。

### 开启 100 万上下文

| 你想要 | 这样做 |
|--------|--------|
| 仅在*你主动选择*时用 1M | 在 `/model` 里选 **`<模型>[1m]`** 条目 —— 每个模型都会自动广告它。 |
| 某个模型不要 `[1m]` 变体 | 给该条目加 `"1m": false`。 |
| 某个模型*始终*用 1M | `"1m": "force"`（只广告 `[1m]` 选项）。 |
| *全部*请求始终用 1M | 顶层 `"force_1m": true`（仅当所有后端都支持时）。 |

详见 [docs/ONE_MILLION_CONTEXT.zh-CN.md](docs/ONE_MILLION_CONTEXT.zh-CN.md)。

## 架构

```
Claude Code → server.ts（轻量 HTTP）→ 信封/[1m] 变换 → Provider（按后端类型）
                                                          ├─ anthropic   （直通 + 1M beta）
                                                          ├─ openai_compat（Anthropic⇄OpenAI，工具）
                                                          ├─ codex_oauth  （登录方式的 GPT-5.5）
                                                          └─ cursor_agent （Composer，实验性）
```

- **分层源码。** `config/`（加载 + 归一化 + 校验）、`core/`（环境变量、id、日志、运行时类型）、
  `net/`（HTTP 客户端 + SSE/Anthropic 输出）、`pipeline/`（信封、`[1m]`、模型发现、转换、重试）、
  以及 `providers/`（每个后端一个模块）。
- **Provider 注册表。** 每个后端都是一个自包含的 `Provider`；server 按后端类型解析出一个
  provider，完全不碰传输细节。新增后端 = 一个模块 + 注册一下。
- **请求管线。** 一个 `RequestContext` 携带变换后的请求体、路由、1M 意图、流式标志、请求 id
  以及一个 `AbortSignal`。
- **健壮性。** 空回合重试、瞬时连接重试、每请求空闲超时、以及下游断连取消（客户端离开时会中止
  上游调用）。
- **校验 + 可观测性。** 启动时校验配置（错误 + 警告）；`/healthz` 报告版本、providers 和 1M
  策略；verbose 日志带有每请求 id 和耗时。

逐文件说明见 [docs/HOW_IT_WORKS.zh-CN.md](docs/HOW_IT_WORKS.zh-CN.md)。

## 开发 / 测试

```bash
npm run build     # tsc -> dist/
npm test          # 构建并运行离线自测（node:test，无需网络/密钥）
npm run doctor    # 校验环境与配置，然后运行自测
```

自测（23 个用例，全部离线）覆盖：模型发现 + `[1m]` 变体广告、UltraCode 信封、1M beta 头部保证、
每模型 effort 覆盖、Provider 注册表、配置校验与归一化、Anthropic⇄OpenAI 工具转换、严格后端的
工具相邻性修复，以及空回合重试。

## 文档

每篇文档都有**简体中文**和**英文**两个版本。

| 文档 | 中文 | EN |
|------|------|----|
| 使用方法参考（命令、范例、环境变量） | [中文](docs/USAGE.zh-CN.md) | [EN](docs/USAGE.md) |
| `[1m]` 100 万上下文保证 | [中文](docs/ONE_MILLION_CONTEXT.zh-CN.md) | [EN](docs/ONE_MILLION_CONTEXT.md) |
| 机制 + 架构 + 文件地图 | [中文](docs/HOW_IT_WORKS.zh-CN.md) | [EN](docs/HOW_IT_WORKS.md) |
| 安装指南 | [中文](docs/SETUP.zh-CN.md) | [EN](docs/SETUP.md) |
| 把后端加进 `/model` | [中文](docs/ADD_A_MODEL.zh-CN.md) | [EN](docs/ADD_A_MODEL.md) |
| 排错 | [中文](docs/TROUBLESHOOTING.zh-CN.md) | [EN](docs/TROUBLESHOOTING.md) |
| AI 安装/配置手册 | [中文](AGENTS.zh-CN.md) | [EN](AGENTS.md) |

## 许可

MIT —— 见 [LICENSE](LICENSE)。这是一个非官方的社区项目；与 Anthropic、OpenAI、DeepSeek 或
任何模型提供商均无关联。你需要自行遵守你所路由的各账号的条款。
