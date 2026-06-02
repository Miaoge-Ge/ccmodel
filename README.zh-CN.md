# ccmodel

[English](README.md) · **简体中文**

一个零依赖的本地回环代理：把 Claude Code 的 UltraCode 行为，以及可靠的 `[1m]` 100 万 token
上下文，带到你已经付费的任意模型上——直接在 `/model` 菜单里实时选择。

```
   Claude Code ──ANTHROPIC_BASE_URL──▶ ccmodel 代理 ──▶ Claude · DeepSeek · GPT-5.5 · MiniMax-M3 · …
                   (本地回环 :8141)        │  按后端类型注入 UltraCode 信封
                                           │  为 [1m] 选项保证 100 万上下文
                                           └  把每个 /model 选择路由到对应 provider
```

## 概述

ccmodel 挂在 Claude Code 的 `ANTHROPIC_BASE_URL` 上，在不引入秘密模型、不修改你现有安装的
前提下，补上原生 Claude Code 不具备的两项能力：

1. **让任意后端用上 UltraCode。** 在 API 层面，UltraCode 只是加在每个请求上的一组信封——
   最高 effort、自适应 thinking、抬高的 `max_tokens` 下限，以及一条 Workflow 系统提醒。
   ccmodel 按后端类型精准注入：Anthropic 系后端获得完整信封；Codex 保留 effort（映射成它的
   推理强度）；OpenAI 兼容与 Cursor 后端不会收到它们用不上的 Claude 专属字段。
2. **可靠保证的 100 万上下文，而非"尽力而为"。** `[1m]` 后缀本应提供 100 万 token 窗口，但真正
   解锁它的 beta 头部会在 Claude Code 的多条代码路径上被丢弃，导致请求被悄悄限制在 20 万。
   ccmodel 会在每个需要的请求上重新补上 `anthropic-beta: context-1m-2025-08-07` 头部，因此
   `[1m]` 能可靠地等于 1M。

你现有的 Claude Code 安装完全不受影响；ccmodel 只为它启动的进程设置环境变量，并传入一个
会话级 `--settings` 文件。

## 运行要求

- **Node.js 20+** —— 运行时只用 Node 内置模块；TypeScript 仅为构建期的开发依赖。
- **Claude Code CLI**，并具备 UltraCode 权限（`npm i -g @anthropic-ai/claude-code`）。
- **至少一个后端凭证** —— 一个 API key（DeepSeek、MiniMax、OpenRouter、本地服务……），
  和/或用于 GPT-5.5 的 `codex login`。真·Claude 的 `[1m]` 只需你现有的登录。

单个启动器（`bin/ccmodel.mjs`）即可在 Windows、macOS、Linux、WSL 上运行。

## 快速开始

```bash
git clone git@github.com:Miaoge-Ge/ccmodel.git && cd ccmodel

npm install                              # 安装开发依赖并构建
npm run doctor                           # 校验环境与配置，运行离线测试套件
cp config.example.jsonc config.jsonc     # Windows: copy config.example.jsonc config.jsonc
#   编辑 config.jsonc —— 填入你的模型与 key

npm run launch                           # 首次运行会构建，启动代理并打开 Claude Code
```

在 Claude Code 中输入 `/model` 选择后端。以 `[1m]` 结尾的选项会以 100 万 token 窗口运行。

- `npm run launch -- --proxy-only` 只启动代理并保持常驻。
- `npm run icons` 安装跨平台桌面启动图标。
- `npm run uninstall` 停止代理并移除启动图标与会话状态。

### 在任意目录下使用

想在别的项目里用 ccmodel 而不必每次 `cd` 回本仓库，只需把它装到 `PATH` 上一次：

```bash
npm link        # 在本仓库执行 —— 把 `ccmodel` 命令软链到全局
```

之后在任意项目目录：

```bash
cd ~/some/other/project
ccmodel          # 在当前目录启动代理并打开 Claude Code，用的是本仓库的 config.jsonc
```

`ccmodel --version` 显示版本和所链接的仓库路径；`ccmodel --help` 列出选项；其余参数会
透传给 `claude`。用 `npm rm -g ccmodel` 解除全局链接。（`npm i -g .` 也可以，但 `npm link`
让全局命令始终指向本仓库，配置和代码改动即时生效。）

## 配置

整个配置就是 `config.jsonc` 里的一个模型列表（JSONC，允许注释与尾逗号；该文件已 gitignore）。
常见情况下，一条目只需三个字段：

```jsonc
{
  "models": [
    { "model": "deepseek-v4-pro",  "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" },
    { "model": "MiniMax-M3[1m]",   "url": "https://api.minimax.io/v1",          "key": "${MINIMAX_API_KEY}" }
  ]
}
```

- **`model`**（必填）—— 后端模型 id。结尾的 `[1m]` 标记它为 1M 上下文模型；该后缀会在 id 发往
  后端前被剥掉。
- **`url`** —— 决定后端类型：`…/anthropic` 的 URL 视为 Anthropic 直通，其他 URL 视为 OpenAI
  兼容。真·Claude 则省略不写。
- **`key`** —— API key（支持 `${ENV}` 展开）。登录型（Codex）或无需 key 的（本地）后端可省略。

其余一切——后端 id、`/model` id、鉴权头——都会自动推断。完整参考（后端类型、每模型选项、
1M 保证、环境变量、架构、排错）见 **[系统手册](docs/MANUAL.zh-CN.md)**。

## 开发

```bash
npm run build           # 编译 TypeScript 到 dist/
npm test                # 构建并运行离线测试套件（无需网络或密钥）
npm run test:coverage   # 附带 V8 覆盖率
npm run lint            # ESLint
npm run format:check    # Prettier
```

测试套件（139 个用例）完全离线，针对进程内 mock 后端运行。CI 在 Node 20/22/24 ×
Linux/Windows 上运行 lint、格式检查与测试套件。

## 文档

| 文档 | 中文 | English |
|------|------|---------|
| 系统手册——安装、配置、1M 保证、环境变量、架构、排错 | [手册](docs/MANUAL.zh-CN.md) | [MANUAL.md](docs/MANUAL.md) |
| 贡献指南 | [贡献指南](CONTRIBUTING.zh-CN.md) | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 安全策略 | [安全策略](SECURITY.zh-CN.md) | [SECURITY.md](SECURITY.md) |
| 更新日志 | — | [CHANGELOG.md](CHANGELOG.md) |

## 许可

MIT —— 见 [LICENSE](LICENSE)。这是一个非官方的社区项目，与 Anthropic、OpenAI、DeepSeek 或
任何提供商均无关联。你需自行遵守你所路由的各账号的条款。
