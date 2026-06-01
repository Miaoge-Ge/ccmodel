# 排错

[English](TROUBLESHOOTING.md) · **简体中文**

先跑 doctor —— 它能抓住大多数问题并打印修复方法:

```
npm run doctor
```

代理日志:
- Windows:`%LOCALAPPDATA%\ccmodel\proxy.log`
- mac/linux/WSL:`~/.local/state/ccmodel/proxy.log`

想实时观察,前台运行代理:`UC_VERBOSE=1 node dist/src/main.js`。

---

### 我的 `[1m]` 选择没拿到 1M 上下文(仍然约 20 万)

这正是 ccmodel 要解决的问题 —— 按顺序排查:

- **确认变体被广告了。** `curl -s localhost:8141/v1/models | grep '\[1m\]'` 应列出
  `<id>[1m]`。若没有,设 `"advertise_1m_variants": true`(或该模型的 `"context_1m": true`)
  并重启。
- **确认 beta 头部正在离开代理。** 用 `UC_VERBOSE=1`,一个 `[1m]` 请求会打印 `want1m=true`。
  在 Anthropic 直通路径上代理会加 `anthropic-beta: context-1m-2025-08-07`。如果你仍被限制在
  20 万,原因通常是**资格**而非头部:
  - 你的套餐可能没给该模型 1M(Sonnet 1M 常需用量额度;Opus 1M 在 Max/Team/Enterprise 上包含),或
  - 你用的是**已退役 beta** 的模型(Sonnet 4 / 4.5 在 2026-04-30 失去了该 beta)—— 换成
    Opus 4.6+/Sonnet 4.6。
- **是 openai_compat 后端?** 那里的 1M 是后端原生上限,不是 Anthropic beta。代理转发去掉后缀的
  干净 ID;请确认后端模型确实支持你期望的上下文长度。

完整说明见 [ONE_MILLION_CONTEXT.zh-CN.md](ONE_MILLION_CONTEXT.zh-CN.md)。

### 我的模型没出现在 `/model`

- **ID 没以 `claude`/`anthropic` 开头。** Claude Code 用 `/^(claude|anthropic)/i` 过滤发现到的
  ID。改名(例如 `claude-mimo`)。
- **没开发现。** 启动器会设 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`;若你自己起的
  `claude`,请设置它(和 `ANTHROPIC_BASE_URL`),或直接用启动器。
- **首次打开时机。** 关掉 `/model` 再打开,或重启 —— 启动器会预先播种缓存,通常立即可见。
- **你不是 OAuth 登录。** 网关发现只在第一方(OAuth)登录下触发,裸 `ANTHROPIC_API_KEY` 不行。

### 模型列出来了,但回答报错/为空

- 查代理日志里的上游状态行。
- **401 / "invalid api key":** 路由的 `auth`(或它引用的 `${VAR}`)错了或为空。重跑 doctor。
- **404 / "model not found":** 路由的 `model` 对该后端无效(它是后端的 id,不是 `claude-…`
  别名),或 `upstream` 错了。
- **Codex 401 / "run codex login":** 你的 ChatGPT/Codex token 过期了 —— 重跑 `codex login`。
- **偶发空回复:** 某些上游(高 effort 的 GPT-5.5、或不稳定的 OpenAI 兼容后端)偶尔会返回没有
  文本也没有工具调用的一回合。代理会自动重试一个新回合(默认 2 次)再放弃。用
  `UC_EMPTY_RETRY_ATTEMPTS` / `UC_EMPTY_RETRY_BACKOFF` 调整。
- **某回合卡住几分钟(codex):** codex 上游有时开了流之后中途沉默。读取器用一个有界空闲超时
  (`UC_CODEX_STREAM_IDLE_TIMEOUT`,默认 150s),让停顿变成可重试错误而不是一直阻塞。

### 它只回文本,从不调用工具

该路由八成是**直通**(或指向了一个会丢工具的 chat 端点)。设 `"type": "openai_compat"`,这样
代理会双向翻译 Anthropic 的 `tool_use`/`tool_result` ⇄ OpenAI 的 `tool_calls`。真·Claude(直通)
原生处理工具。

### 拒绝工具调用时报 "insufficient tool messages following tool_calls message"

在严格后端(DeepSeek)上会看到。当你拒绝/跳过一个工具调用时,Claude Code 可能把你的评论和工具
结果放在同一回合 —— 有时甚至完全不发结果。OpenAI 要求每条带 `tool_calls` 的 assistant 消息**紧接着**
每个 id 对应一条 `tool` 消息。代理会先按序发出工具回复,**为任何未回答的调用合成一个占位回复**,
再放你的评论 —— 无需改配置。

### 回答里出现 `<think>…</think>`(MiniMax-M3 等推理模型)

给该 `openai_compat` 路由加 `"body": { "reasoning_split": true }`,让思维链单独返回而不是内联。
其他推理后端可能用不同名字暴露类似开关;通用的 `body` 字典能传 provider 文档里写的任意参数。

### "Proxy did not become healthy"

- 端口被别的进程占了。设 `proxy.listen_port`(或 `UC_LISTEN_PORT`)再启动,或停掉残留的
  `node … main.js`。
- 没找到 Node,或构建缺失 —— 跑 `npm install && npm run build`。
- 前台运行看错误:`node dist/src/main.js`(Ctrl-C 停止)。

### 启动器起不来 / "claude not found"

启动器是纯 Node(`node bin/ccmodel.mjs` / `npm run launch`),在 Windows、macOS、Linux 上行为一致。
如果它找不到 Claude Code,安装它(`npm i -g @anthropic-ai/claude-code`)并确认 `claude --version`
能用。

### 我把日常的 Claude Code 弄坏了吗?

没有 —— 本项目从不修改你全局的 `~/.claude` 配置或凭证;它只为被启动的进程设置环境变量,并用一个
会话级 `--settings` 文件。用 **Claude Code (Normal)** 图标,或 `npm run uninstall` 移除启动项 +
会话状态。

### 证明安装本身没问题

```
npm test
```

离线自测通过,就说明代码没问题,问题出在配置/凭证。若失败,重新克隆并报告输出。
