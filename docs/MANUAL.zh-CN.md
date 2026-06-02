# ccmodel — 系统手册

[English](MANUAL.md) · **简体中文**

这是 ccmodel 的完整参考：安装、配置、后端范例、`[1m]` 100 万上下文保证、环境变量、架构、排错与开发测试。想先快速了解，可以看 [README.zh-CN.md](../README.zh-CN.md)。

## 目录

- [1. ccmodel 是什么](#1-ccmodel-是什么)
- [2. 运行要求](#2-运行要求)
- [3. 安装与启动](#3-安装与启动)
- [4. 配置模型](#4-配置模型)
- [5. 后端范例](#5-后端范例)
- [6. `[1m]` 100 万上下文保证](#6-1m-100-万上下文保证)
- [7. 工作机制](#7-工作机制)
- [8. 环境变量](#8-环境变量)
- [9. 权限与安全](#9-权限与安全)
- [10. 架构与文件地图](#10-架构与文件地图)
- [11. 排错](#11-排错)
- [12. 开发与测试](#12-开发与测试)
- [13. 给 AI 助手的执行清单](#13-给-ai-助手的执行清单)
- [14. 卸载](#14-卸载)

---

## 1. ccmodel 是什么

ccmodel 是一个本地回环代理，挂在 Claude Code 的 `ANTHROPIC_BASE_URL` 上。它不修改你的全局 Claude Code 配置，只在本次会话里做两件事：

1. **让任意模型用上 UltraCode 信封。** 在 API 层面，UltraCode 主要是 `output_config.effort = "xhigh"`、自适应 `thinking`、较大的 `max_tokens`，以及一条系统提醒。ccmodel 会把这组信封按后端类型精准注入（只发后端用得上的字段，见 [§7](#7-工作机制)），再转发给你选的后端。
2. **让 `[1m]` 不再悄悄退回 20 万。** Claude Code 的 `[1m]` 后缀需要配套的 `anthropic-beta: context-1m-2025-08-07` 头部才能真正打开 100 万上下文。某些路径会丢掉这个头部，ccmodel 会在需要时补回。

它支持四类后端：Anthropic 直通、OpenAI 兼容接口、Codex 登录、Cursor Agent。

你现有的 Claude Code 安装完全不受影响：ccmodel 只为它启动的进程设环境变量，并传入一个会话级 `--settings` 文件（启动器也在这里设置 [`bypassPermissions`](#9-权限与安全)），绝不修改 `~/.claude`。

## 2. 运行要求

| 项目 | 要求 |
|------|------|
| Node.js | 20+ |
| Claude Code CLI | `npm i -g @anthropic-ai/claude-code`，并具备你要使用的权限 |
| 后端凭证 | API key、`codex login`，或本地 OpenAI 兼容服务 |
| 操作系统 | Windows、macOS、Linux、WSL |

运行时只依赖 Node 内置模块；TypeScript 只用于构建和测试。

## 3. 安装与启动

```bash
npm install
npm run doctor
copy config.example.jsonc config.jsonc   # Windows
# cp config.example.jsonc config.jsonc   # macOS / Linux / WSL
npm run launch
```

常用命令：

| 命令 | 作用 |
|------|------|
| `npm run launch` | 构建、启动代理、写入本次会话 settings、打开 Claude Code |
| `npm run launch -- --proxy-only` | 只启动代理并让它常驻 |
| `npm run proxy` | 直接运行已构建的 `dist/src/main.js` |
| `npm run doctor` | 校验环境、配置、构建产物，并跑离线自测 |
| `npm run icons` | 安装桌面启动图标 |
| `npm run uninstall` | 停止代理并移除会话状态/启动图标 |

启动后，在 Claude Code 中输入 `/model` 选择模型。`model` id 结尾带 `[1m]` 的那一项以 100 万上下文运行。

### 在任意目录下使用

`npm run launch` 必须在本仓库执行。想在别的项目里用而不必如此，把 `ccmodel` 命令装到 `PATH` 上一次：

```bash
npm link        # 在本仓库执行 —— 把 `ccmodel` 软链到全局（npm rm -g ccmodel 解除）
```

之后 `cd` 进任意项目执行 `ccmodel`：它会启动代理、在**当前目录**打开 Claude Code，并使用本仓库的
`config.jsonc`（经软链解析，配置和代码改动即时生效）。`ccmodel --version` 打印版本和所链接的仓库路径，
`ccmodel --help` 列出选项，其余参数透传给 `claude`。`npm i -g .` 也能装，但 `npm link` 让命令始终指向
你的工作副本。

## 4. 配置模型

配置文件是 `config.jsonc`，从 `config.example.jsonc` 复制。它支持 `//`、`/* */` 注释和尾逗号，且 `config.jsonc` 已被 `.gitignore` 排除。

常见情况下，一条模型只要三个字段 —— `{ "model": …, "url": …, "key": … }`。只有 `model` 必填：

```jsonc
{
  "models": [
    { "model": "claude-opus-4-8[1m]", "name": "Claude Opus 4.8 (1M)" },
    { "model": "your-local-model", "url": "http://127.0.0.1:11434/v1" }
  ]
}
```

**1M 只差一个后缀：`[1m]`。** `"model": "MiniMax-M3"` 是标准 20 万选项；`"model": "MiniMax-M3[1m]"` 是「保证」1M 的选项。后缀会在 id 发往后端前被剥掉，所以只给真正支持 1M 的模型加。一条 = 一个 `/model` 选项（见 [§6](#6-1m-100-万上下文保证)）。

顶层选项：

| 选项 | 默认 | 说明 |
|------|------|------|
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `8141` | 监听端口 |
| `upstream` | `https://api.anthropic.com` | Anthropic 直通默认上游 |
| `max_tokens` | `64000` | 全局 `max_tokens` 下限 |
| `force_1m` | `false` | 对所有请求强制 1M，仅在所有后端都支持时使用 |

每个模型的选项（`model` 必填，其余可选）：

| 选项 | 说明 |
|------|------|
| `model` | **必填。** 发给后端的真实模型 id，并据此自动生成 `/model` id `claude-<slug(model)>`。结尾带 `[1m]` 即标记为 1M 模型。 |
| `url` | 后端地址；省略表示真 Claude 直通 |
| `key` | API key，支持 `${ENV_VAR}`；普通 key 会自动包装成 `Authorization: Bearer ...` |
| `name` | `/model` 里更好看的显示名（默认就是 `model`） |
| `api` | 强制后端类型：`anthropic` / `openai` / `codex` / `cursor`；codex/cursor 必填（没有 url 可推断） |
| `effort` | 覆盖 UltraCode effort，或设为 `false` 关闭强制 effort |
| `max_output_tokens` | OpenAI 兼容后端的补全上限；默认 8192 |
| `body` | 合并到 OpenAI 兼容请求体的额外参数 |
| `headers` | 合并到后端请求的额外请求头 |
| `workspace` | Cursor Agent 工作目录 |

> **1M 不是单独的字段**，而是 `model` 上的 `[1m]` 后缀。见 [§6](#6-1m-100-万上下文保证)。

后端类型推断：

| 类型 | 触发方式 |
|------|----------|
| Anthropic 直通 | 无 `url`、`.../anthropic` 地址，或 `"api": "anthropic"` |
| OpenAI 兼容 | 其他 `url`，或 `"api": "openai"` |
| Codex 登录 | `"api": "codex"` |
| Cursor Agent | `"api": "cursor"` |

## 5. 后端范例

Anthropic / 真 Claude（Opus 4.8 支持 1M，加 `[1m]` 即得保证 1M 选项）：

```jsonc
{ "model": "claude-opus-4-8[1m]", "name": "Claude Opus 4.8 (1M)" }
```

DeepSeek Anthropic-native：

```jsonc
{ "model": "deepseek-v4-pro", "url": "https://api.deepseek.com/anthropic", "key": "${DEEPSEEK_API_KEY}" }
```

MiniMax-M3 OpenAI-compatible（原生约 1M，注意 `[1m]` 后缀）：

```jsonc
{
  "model": "MiniMax-M3[1m]",
  "url": "https://api.minimax.io/v1",
  "key": "${MINIMAX_API_KEY}",
  "max_output_tokens": 64000,
  "body": { "reasoning_split": true }
}
```

- `[1m]` 后缀把 M3 广告为 1M 选项；发往后端前会被剥成 `MiniMax-M3`。
- `"body": { "reasoning_split": true }` 让 M3 的 `<think>` 思维链不混入可见回答。

Codex 登录：

```jsonc
{ "model": "gpt-5.5", "api": "codex" }
```

本地 OpenAI 兼容服务：

```jsonc
{ "model": "your-local-model", "url": "http://127.0.0.1:11434/v1" }
```

## 6. `[1m]` 100 万上下文保证

`[1m]` 是 Claude Code 对 100 万上下文模型变体的约定，例如 `claude-opus-4-8[1m]`。真正让 Anthropic Messages API 打开 1M 的是：

```text
anthropic-beta: context-1m-2025-08-07
```

ccmodel 会：

1. 从以下任一判断 1M 意图：模型 id 结尾是 `[1m]`；传入请求已带 `context-1m-2025-08-07` beta；所选模型来自一条 `[1m]` 配置项（即便 Claude Code 在传输途中剥掉了后缀也照样保证 1M）；或全局 `force_1m` 开启。
2. 发给后端前移除 `[1m]` 后缀。
3. 对 Anthropic 直通请求补上 `context-1m-2025-08-07` beta（与已有 beta 合并去重，幂等）。

OpenAI 兼容后端的 1M 是后端的*原生*属性、不是 Anthropic beta —— 代理只是转发干净的 id 并且不截断输入。

通过 `[1m]` 后缀 opt-in（每条 = 一个 `/model` 选项）：

| `model` 值 | `/model` 显示 | 行为 |
|-----------|---------------|------|
| `"X"` | `claude-x` | 标准 20 万；不会自动 1M |
| `"X[1m]"` | `claude-x[1m]` | 每个请求都「保证」1M |

同一后端模型想同时要 200K 和 1M 两个选项？写两条 —— 一条 `"X"`、一条 `"X[1m]"`（它们会拿到不同的 id）。标准条目仍会**尊重传入的显式 `[1m]`**，所以即便你没预先广告，保证依然生效。全局常开：顶层 `"force_1m": true`（或 `UC_FORCE_1M=1`），仅当所有后端都支持时。

不要给不支持 1M 的后端加 `[1m]`。`[1m]` 能保证头部和路由正确，但不能让不支持 1M 的模型变成 1M 模型。

## 7. 工作机制

请求路径：

```text
Claude Code -> ccmodel server -> envelope/[1m] transform -> Provider -> backend
```

主要行为：

- `/healthz` 返回版本、provider、模型、1M 策略、Codex 登录状态，以及一份 `metrics` 快照。
- `GET /metrics` 以 Prometheus 文本格式暴露同样的计数（按类型/状态码的请求数、错误数、1M 计数、平均/最大延迟、运行时长）。
- `GET /v1/models` 合并上游模型与本地配置模型。
- `POST /v1/messages` 会先注入 UltraCode 信封，再按模型路由到 provider。
- `POST /v1/messages/count_tokens`（`/context`、`/compact` 会调用）按 `/v1/messages` 同样的方式路由（换后端 id、剥 `[1m]`），但**不注入信封**。真·Claude 仍转发给 Anthropic 拿精确值；第三方后端（OpenAI 兼容/Codex/Cursor）没有这个接口，ccmodel **本地用快速估算**（约 4 字符/token）直接返回，因此 `/context` 秒回、`/compact` 不再对自定义模型报错。
- OpenAI 兼容后端会做 Anthropic <-> OpenAI 消息和工具调用转换。
- 空回合会有有限重试；下游断开时会中止上游请求。

**信封按后端类型精准投放**，后端绝不会收到它用不上的字段：

| 后端 | effort | thinking | Workflow 提醒 | max_tokens 下限 |
|------|:------:|:--------:|:-------------:|:---------------:|
| Anthropic 直通（真·Claude、`…/anthropic`） | ✅ | ✅ | ✅ | ✅ |
| Codex（GPT-5.5） | ✅（映射成推理强度） | — | — | ✅ |
| OpenAI 兼容 / cursor | — | — | — | ✅¹ |

¹ OpenAI provider 会用自己的默认值/slot 上限重新封顶 `max_tokens`，所以下限在那里实际是
空操作。重点是：OpenAI 兼容和 cursor 后端**不会**收到 Claude 专属的 `output_config`/
`thinking` 字段或 Workflow 提醒——那只会徒增 token、并引用模型用不上的工具。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `UC_CONFIG` | 自动查找 | 配置文件路径 |
| `UC_LISTEN_HOST` | `127.0.0.1` | 监听地址 |
| `UC_LISTEN_PORT` | `8141` | 监听端口 |
| `UC_UPSTREAM` | `https://api.anthropic.com` | 默认 Anthropic 上游 |
| `UC_MAX_TOKENS` | `64000` | `max_tokens` 下限 |
| `UC_MAX_BODY_BYTES` | `67108864` | 入站 `/v1/messages` 请求体上限（字节，0 关闭）；超限返回 `413` |
| `UC_SHUTDOWN_GRACE_MS` | `10000` | 收到 SIGINT/SIGTERM 后，强制关闭连接前用于排空在途请求的宽限期（毫秒） |
| `UC_FORCE_EFFORT` | `xhigh` | 强制 effort；空字符串表示关闭 |
| `UC_FORCE_THINKING` | `1` | 是否强制 adaptive thinking |
| `UC_INJECT_REMINDER` | `1` | 是否注入 UltraCode 系统提醒 |
| `UC_FORCE_1M` | `0` | 是否对所有请求强制 1M |
| `UC_EMPTY_RETRY_ATTEMPTS` | `2` | 空回合重试次数 |
| `UC_EMPTY_RETRY_BACKOFF` | `0.75` | 空回合重试退避秒数 |
| `UC_MODEL_MAP` | `{}` | 额外的 `id → 后端模型` 覆盖（JSON 映射） |
| `UC_VERBOSE` | `0` | 输出更详细日志 |
| `UC_LOG` | 空 | 追加日志文件路径 |

优先级：显式环境变量 **高于** `config.jsonc` 里对应的键，后者 **高于** 内置默认值。启动器还会在启动代理前加载仓库根目录下被 gitignore 的 `ccmodel.env`，里面的内容可用于 `${VAR}` 展开，也作为普通环境变量生效。

**Codex（登录方式的 GPT-5.5）：**

| 变量 | 默认 | 说明 |
|------|------|------|
| `CODEX_HOME` | `~/.codex` | 存放 `auth.json` 的目录（由 `codex login` 写入） |
| `UC_CODEX_BASE_URL` | `https://chatgpt.com/backend-api/codex` | Codex Responses API 地址 |
| `UC_CODEX_EFFORT` | `medium` | 请求未指定时的默认推理强度 |
| `UC_CODEX_SERVICE_TIER` | 空 | 可选服务档位（如 `priority`） |
| `UC_CODEX_REFRESH_CMD` | `codex login status` | 尽力而为的 token 刷新命令 |
| `UC_CODEX_STREAM_IDLE_TIMEOUT` | `150` | 单次读取空闲超时（秒） |

**Cursor（Composer，实验性）：**

| 变量 | 默认 | 说明 |
|------|------|------|
| `CURSOR_AGENT_BIN` | PATH / `~/.local/bin` | `cursor-agent` 二进制路径 |
| `CURSOR_AGENT_WORKSPACE` | 当前目录 | 传给 cursor-agent 的工作目录 |
| `CURSOR_AGENT_TIMEOUT` | `240` | 单回合放弃前的秒数 |
| `CURSOR_AGENT_NO_PROXY` | `0` | 设 `1` 从子进程剥掉 `HTTP(S)_PROXY`（修复 TLS 拦截代理下的卡死） |

`ccmodel.env` 会被启动器和 doctor 加载，适合放 `${ENV_VAR}` 所需的密钥。

## 9. 权限与安全

### `bypassPermissions` 默认

`ccmodel` / `npm run launch` 启动器会让 Claude Code 以 **`bypassPermissions`** 模式启动，因此本次会话**不会逐个动作弹权限确认**——编辑、shell 命令、工具调用都直接执行，不再询问。这是有意为之：UltraCode 高度依赖 Workflow 工具和长时间自主运行，每个动作都弹窗会不断打断。

它设在启动器通过 `--settings` 传入的**会话级**设置文件里（Windows 为 `%LOCALAPPDATA%\ccmodel\ccmodel_settings.json`，其他系统为 `~/.local/state/ccmodel/ccmodel_settings.json`）：

```jsonc
{
  "ultracode": true,
  "permissions": { "defaultMode": "bypassPermissions" },
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8141", "CLAUDE_CODE_WORKFLOWS": "1", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1" }
}
```

你的**全局** Claude Code 配置（`~/.claude`）及其权限模式不受影响——这只对通过 ccmodel 启动的会话生效。

**单次启动覆盖**：把想要的模式透传给 `claude` 即可：

```bash
ccmodel --permission-mode default     # 恢复正常的逐动作确认
ccmodel --permission-mode acceptEdits # 自动接受编辑，其余仍确认
ccmodel --permission-mode plan        # 只做计划、不执行
```

会话中也可以用 **Shift+Tab** 随时切换模式。

> **注意。** `bypassPermissions` 意味着 Claude 可以**不经确认**执行任何工具——包括 shell 命令和写文件。只在你信任的目录下使用。想逐动作确认，就用 `ccmodel --permission-mode default` 启动。

### 凭证处理

- **密钥放在 `config.jsonc` / `ccmodel.env`**，两者都已 gitignore。绝不提交；优先用 `${ENV}` 引用而非内联明文。
- **仅回环。** 代理默认绑定 `127.0.0.1`。不要暴露到公网接口——它不做任何客户端鉴权。
- **不交叉转发。** ccmodel 只发所匹配后端配置的 `key`，并在与第三方（OpenAI 兼容）后端通信前剥掉 Claude Code 自带的入站凭证。
- **日志脱敏。** `Bearer` 令牌、`authorization`/`x-api-key` 的值，以及 `sk-…` 形态的 key，写入日志/stderr 前都会被掩码。但日志仍含提示词/回复内容——请把日志文件当敏感数据。完整策略见 [SECURITY.zh-CN.md](../SECURITY.zh-CN.md)。

## 10. 架构与文件地图

| 文件/目录 | 作用 |
|-----------|------|
| `bin/ccmodel.mjs` | 跨平台启动器（`--version` / `--help`） |
| `scripts/doctor.ts` | 环境、配置与离线自测检查 |
| `scripts/test.mjs` | 可移植测试运行器（显式枚举文件，跨 Node 版本稳定） |
| `src/main.ts` | CLI 入口、配置解析、HTTP 服务启动、优雅停机 |
| `src/server.ts` | HTTP 路由、请求上下文、count_tokens、metrics、provider 分发 |
| `src/config/` | 配置加载、JSONC 解析、归一化、校验、类型 |
| `src/core/` | 环境变量、脱敏日志、id、运行时类型、PATH 查找、metrics、停机排空 |
| `src/net/` | HTTP 客户端（keep-alive 连接池）、请求头处理、SSE 解析、Anthropic 输出 |
| `src/pipeline/` | UltraCode 信封、`[1m]`、模型发现、翻译、重试 |
| `src/providers/` | Anthropic、OpenAI 兼容、Codex、Cursor provider |
| `test/unit/*.test.ts` | 各模块单测 | 
| `test/integration.test.ts` | 全离线端到端自测（共享 `test/helpers/harness.ts`） |

## 11. 排错

| 现象 | 处理 |
|------|------|
| `/model` 看不到模型 | 运行 `npm run doctor`；确认 `config.jsonc` 可解析；重启 Claude Code |
| `[1m]` 选项不存在 | 该模型的 `model` id 结尾必须带 `[1m]`，如 `"MiniMax-M3[1m]"` |
| `[1m]` 仍像 20 万 | 用 `UC_VERBOSE=1` 确认日志中 `want1m=true`；再确认账号/模型本身具备 1M 权限 |
| OpenAI 后端 401 | 检查 `key` / `${ENV_VAR}` / `ccmodel.env` |
| OpenAI 后端拒绝 `max_tokens` | 给该模型设置较小的 `max_output_tokens` |
| Codex 不可用 | 先运行 `codex login`；再用 `npm run doctor` 检查 |
| Cursor 超时 | 确认 `cursor-agent` 已安装并登录；代理环境异常时可尝试 `CURSOR_AGENT_NO_PROXY=1` |
| 端口被占用 | 修改 `port` 或 `UC_LISTEN_PORT`，或停止旧的代理进程 |
| `/context` 慢或 `/compact` 报"模型不存在" | 还在跑修复前的旧代理。退出 Claude Code 再重启（`ccmodel` / `npm run launch` 会按改动重新构建）；用 `curl -s localhost:8141/healthz` 看 `version` 是否最新 |
| `ccmodel: command not found` | 全局命令未链接。在仓库执行一次 `npm link`，并确认 npm 全局 bin 目录（`npm config get prefix`）在 `PATH` 上 |
| 权限弹窗太多/没有弹窗 | 启动器默认 `bypassPermissions`（不弹窗）。想恢复弹窗：用 `ccmodel --permission-mode default` 启动，或会话中按 **Shift+Tab**。见 [§9](#9-权限与安全) |

## 12. 开发与测试

```bash
npm run build
npm run typecheck
npm test
npm run test:coverage
npm run lint
npm run format:check
npm run doctor -- --ci
```

测试是全离线的（144 个用例，内置 mock backend），不需要真实 API key 或网络。按关注点拆分在
`test/unit/*`（配置、`[1m]`、信封、翻译、SSE 解析、Anthropic 输出、HTTP 客户端、重试、Provider、
Codex、count_tokens、metrics、停机、日志脱敏、`${ENV}`），外加端到端的
`test/integration.test.ts`（count_tokens、413、并发等；共享装置在 `test/helpers/harness.ts`）。
`npm run test:coverage` 可附带 V8 覆盖率（约 90% 行覆盖）；`npm run lint` / `npm run format:check` 做静态检查。
CI 在 Node 20/22/24 × Linux/Windows 上运行 lint、格式检查与测试套件。

## 13. 给 AI 助手的执行清单

当你代用户安装或配置 ccmodel：

1. 确认 `node` 与 `claude` 可用。
2. 运行 `npm install`、`npm run build`、`npm test`。
3. 复制 `config.example.jsonc` 到 `config.jsonc`。
4. 删除用户不需要的示例模型。每条至少要有 `model`；常见情况是 `{ model, url, key }`。
5. 只给真正支持 1M 的模型在 `model` 结尾加 `[1m]` 后缀；codex/cursor 需要 `"api"`。
6. 不要提交 `config.jsonc` 或 `ccmodel.env`。
7. 修改后运行 `npm run doctor`。

## 14. 卸载

- `npm run uninstall` 停止运行中的代理，并移除桌面启动器和会话状态（跨平台）。你的配置和 Claude Code 都不动。
- `npm rm -g ccmodel` 移除全局 `ccmodel` 命令（如果你执行过 `npm link` 或 `npm i -g .`）。
- 想彻底删除：直接删掉仓库文件夹。本项目从不修改你的 `~/.claude` 和凭证。
