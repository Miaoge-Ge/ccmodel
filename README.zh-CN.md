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
> 选择一个已配置的 `[1m]` 模型，它就会**真正用上 1,000,000 token 的上下文窗口** —— 不会再
> 悄悄退回到 20 万。代理会在每个需要的请求上注入
> `anthropic-beta: context-1m-2025-08-07` 头部，**即使 Claude Code 在传入途中把它丢掉了**
> （子代理、`--model` 参数、网关路由里都真实存在这种丢头部的 bug）。详见
> **[docs/MANUAL.zh-CN.md](docs/MANUAL.zh-CN.md)**。

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

- **Node.js 20+**（`node --version`）。代理在运行时只用 Node 内置模块 —— **运行**它无需
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
每个模型写一条。常见情况下，一条只要三个字段：

```jsonc
{ "model": "<模型 id>", "url": "<基础 url>", "key": "<API key>" }
```

只有 `model` 是必填的，其余全部自动推断：

| 你写的 | 代理推断出 |
|--------|-----------|
| `model`（必填） | 发往上游的后端 id **以及** `/model` 里的 id `claude-<slug(model)>`（Claude Code 只保留 `claude`/`anthropic` 开头的 id）。结尾带 **`[1m]`** 即标记为 1M 模型。 |
| `url` | **后端类型**：`…/anthropic` → 直通；其他 → OpenAI 兼容。真·Claude 则省略不写。 |
| `key` | 鉴权头 —— 包装成 `Authorization: Bearer <key>`（也可直接写 `"x-api-key: …"`）。省略则复用 Claude Code 自己的凭证。 |

**1M 只差一个后缀。** 给 `model` id 结尾加上 `[1m]`，该选项就以「保证」的 1,000,000 token
窗口运行；不加则是标准 20 万。后缀会在 id 发往后端前被剥掉，所以只给真正支持 1M 的模型加。
一条 = 一个 `/model` 选项。

### 已验证示例：DeepSeek（原生 Anthropic 端点）

DeepSeek 自带一个原生兼容 Anthropic 的端点，所以 `…/anthropic` 的 url 会被自动识别为
**passthrough（直通）** —— 工具调用、流式、模型的 `thinking` 思考块全都原生可用。本示例已
端到端实测通过（非流式与流式路径）：

```jsonc
{
  "models": [
    { "model": "deepseek-v4-flash", "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" },
    { "model": "deepseek-v4-pro",   "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" }
  ]
}
```

想在菜单里显示更好看的名字？加一个可选的 `"name": "DeepSeek V4 Pro"`。
key 可以直接写在文件里（已被 gitignore），也可以用 `${ENV_VAR}` —— 通过环境变量导出，或写进
一个被 gitignore 的 `ccmodel.env`（启动器会加载它）。

### 后端类型

类型由 `url` 推断（或用 `api` 强制指定）：

| 类型 | 何时使用 | 需要 |
|------|----------|------|
| Anthropic 直通 | 不写 `url`（真·Claude），或 `…/anthropic` 的 url（DeepSeek、任意兼容 Anthropic 的端点） | 无，或 `key`/`url` |
| OpenAI 兼容 | 其他任意 `url` —— MiniMax、OpenRouter、OpenAI、Ollama、本地 llama.cpp（工具会双向转换） | `key`（本地服务可省略） |
| Codex（`"api": "codex"`） | 通过 ChatGPT/Codex 登录使用 GPT-5.5（无需 API key） | 跑一次 `codex login`，并写 `"api": "codex"`（没有 url 可推断） |
| Cursor（`"api": "cursor"`） | Cursor Composer（实验性） | `cursor-agent login`，并写 `"api": "cursor"` |

### 每个模型的可选项

都是可选的，和 `model`/`url`/`key` 并列：

- `name` —— `/model` 里更好看的显示名（默认就是 `model`）。
- `api` —— 强制后端类型（`anthropic` / `openai` / `codex` / `cursor`），不再从 `url` 推断；
  codex/cursor 必填（它们没有 url 可推断）。
- `effort` —— 设置另一个 effort 等级，或设为 `false` 以对严格后端停止强制 effort。
- `max_output_tokens` —— OpenAI 兼容后端的补全上限（默认 8192）。
- `body` —— 合并进每个 OpenAI 兼容请求的额外参数（如 MiniMax-M3 的
  `{ "reasoning_split": true }`）。支持 `${VARS}`。
- `headers` —— 额外请求头（支持 `${VARS}`）。

### 开启 100 万上下文

| 你想要 | 这样做 |
|--------|--------|
| 某个模型的 1M 选项 | 在它的 `model` id 结尾加 `[1m]`，如 `"model": "MiniMax-M3[1m]"`。 |
| 同一模型同时要 200K *和* 1M 两个选项 | 写两条 —— 一条 `"X"`、一条 `"X[1m]"`。 |
| 标准上下文模型 | 不加 `[1m]` 后缀即可。 |
| *全部*请求始终用 1M | 顶层 `"force_1m": true`（仅当所有后端都支持时）。 |

`[1m]` 模型端到端「保证」1M：即便 Claude Code 在传入途中把 beta 头部或后缀丢掉，代理也会在
每个相关请求上把 `anthropic-beta: context-1m-2025-08-07` 头部补回去。详见
[docs/MANUAL.zh-CN.md](docs/MANUAL.zh-CN.md)。

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

逐文件说明见 [docs/MANUAL.zh-CN.md](docs/MANUAL.zh-CN.md)。

## 开发 / 测试

```bash
npm run build     # tsc -> dist/
npm test          # 构建并运行离线自测（node:test，无需网络/密钥）
npm run doctor    # 校验环境与配置，然后运行自测
```

自测（105 个用例，全部离线）按关注点拆分在 `test/unit/*`（配置、`[1m]`/发现、信封、翻译、SSE
解析、HTTP 客户端 + 头部辅助、空回合重试、Provider/cursor 解析、`${ENV}` 展开），外加一个端到端
`test/integration.test.ts`（真实代理 + 进程内 mock 后端，共享装置在 `test/helpers/harness.ts`）。
覆盖：`[1m]` 后缀解析、配置归一化与校验、UltraCode 信封、1M beta 头部保证（后缀/每模型强制/全局
开关/传入头部四种途径）、Anthropic⇄OpenAI 工具转换、严格后端的工具相邻性修复，以及空回合重试。

## 文档

主题文档已经合并成一本中英文手册。

| 文档 | 中文 | EN |
|------|------|----|
| 系统手册：安装、配置、后端范例、1M、环境变量、架构、排错 | [中文](docs/MANUAL.zh-CN.md) | [EN](docs/MANUAL.md) |
| 贡献指南 | [中文](CONTRIBUTING.zh-CN.md) | [EN](CONTRIBUTING.md) |
| 安全策略 | [中文](SECURITY.zh-CN.md) | [EN](SECURITY.md) |
| 更新日志 | — | [EN](CHANGELOG.md) |

## 许可

MIT —— 见 [LICENSE](LICENSE)。这是一个非官方的社区项目；与 Anthropic、OpenAI、DeepSeek 或
任何模型提供商均无关联。你需要自行遵守你所路由的各账号的条款。
