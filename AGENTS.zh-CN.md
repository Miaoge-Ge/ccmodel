# 给 AI 助手的操作手册

[English](AGENTS.md) · **简体中文**

你正在帮用户搭建 **ccmodel**:它让 Claude Code 的 UltraCode 模式 —— 以及一个可靠的 `[1m]`
100 万 token 上下文 —— 跑在用户已经付费的任意模型上,并能在 `/model` 菜单里选择。

按顺序执行各阶段。不要跳过 doctor。

## 阶段 0 —— 理解目标

终态:用户启动 **CCModel (All Models)**,Claude Code 打开,输入 `/model`,就能选到任何已配置的
后端 —— 包括每个模型的 `<模型>[1m]` 变体,且它真的以 1,000,000 token 运行。机制
(没有魔法):一个本地回环代理(`dist/src/main.js`)位于 `ANTHROPIC_BASE_URL`,在
`GET /v1/models` 上广告用户的模型(及 `[1m]` 兄弟),给每个请求加 UltraCode 信封,在 `[1m]`
请求上保证 `context-1m-2025-08-07` beta,并把每个选择路由到其后端。见
`docs/HOW_IT_WORKS.zh-CN.md` 和 `docs/ONE_MILLION_CONTEXT.zh-CN.md`。

## 阶段 1 —— 前置条件

1. `node --version` → 必须 ≥ 18。
2. `claude --version` → 缺失则 `npm i -g @anthropic-ai/claude-code`。
3. 确认用户有 UltraCode 权限(他们用过 `/effort ultracode`)。

## 阶段 2 —— 构建 + 基线检查

```
npm install      # 安装开发依赖并构建 dist/
npm run doctor
```

doctor 会跑一个**离线自测**(无网络/密钥),证明代理、发现、`[1m]` 变体广告、UltraCode 信封、
1M beta 头部保证、以及工具翻译都正常。若失败,**停下并报告输出** —— 是安装坏了,不是用户配置。

## 阶段 3 —— 问用户有什么,然后配置

问用户拥有以下哪些(只配置这些):

- 某个兼容 OpenAI 服务的 **API key**(MiniMax-M3、MiMo、DeepSeek、OpenRouter、OpenAI、本地服务……)
  → `openai_compat`。
- 用于 GPT-5.5 的 **ChatGPT/Codex 登录** → `codex_oauth`(`codex login`)。
- 只有 **Claude** → 仍然有用:带 UltraCode 信封的真·Claude,而且 `[1m]` 给你一个有保证的 1M 窗口。

把 `config.example.jsonc` 复制成 `config.jsonc` 并编辑:

- `models` —— 每个要在 `/model` 显示的模型一条。**每个 `id` 必须以 `claude` 或 `anthropic` 开头。**
- `routes` —— 每个 id 一条路由(key == id,或 `[1m]` 选择对应的基础 id)。
- key 写在文件里(已 gitignore)或用 `${VAR}`(导出,或写进被 gitignore 的 `ccmodel.env`)。
- **1M:** 设 `"proxy": { "advertise_1m_variants": true }` 给每个模型提供一个 `[1m]` 兄弟,或单个
  模型 `"context_1m": true`,或某路由 `"context_1m": "force"` 始终启用。见
  `docs/ONE_MILLION_CONTEXT.zh-CN.md`。
- **内联 `<think>` 的推理模型(MiniMax-M3):** 加 `"body": { "reasoning_split": true }`。

## 阶段 4 —— 校验

```
npm run doctor
```

校验 id 可被发现+已路由、每个 `${VAR}` 已存在(或已内联)、`codex_oauth`/`cursor_agent` 路由有其
登录/CLI。修复每个 `[FAIL]` 直到退出码 0。

## 阶段 5 —— 启动

一个跨平台启动器(Windows / macOS / Linux / WSL):

```
npm run launch          # 等价于 node bin/ccmodel.mjs
```

可选桌面项:`npm run icons`(创建 **CCModel (All Models)** 和 **Claude Code (Normal)**)。
只起代理:`npm run launch -- --proxy-only`。

## 阶段 6 —— 端到端验证

1. 在 `/model` 里确认用户的自定义模型**及其** `[1m]` 变体都出现。
2. 选一个,发 "say OK",确认有回复。
3. 选一个用工具的,确认工具触发(代理双向翻译)。
4. 选一个 `[1m]` 变体;用 `UC_VERBOSE=1` 确认日志显示 `want1m=true`,且(直通时)beta
   头部被加上。

按 `docs/TROUBLESHOOTING.zh-CN.md` 匹配现象。常见的:
- 模型不在 `/model` → id 没以 `claude`/`anthropic` 开头,或没设发现环境变量。
- "回了文本却从不调工具" → 该路由必须是 `openai_compat`。
- 401/空 → key 错/空,或 `codex login` 过期。
- `[1m]` 仍被限制 → 通常是套餐资格或退役 beta 的模型,而非头部(代理总会发它)。见
  `docs/ONE_MILLION_CONTEXT.zh-CN.md`。

## 硬性规则

- 绝不提交 `config.jsonc`/`config.json` 或 `ccmodel.env`(已 gitignore;含用户的 key)。
- 不要修改用户全局 `~/.claude` 配置;本工具是会话级的。
- 若离线自测(`npm test`)失败,问题在代码/克隆,不在用户 —— 报告它,别糊弄过去。
