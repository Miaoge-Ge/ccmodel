# `[1m]` 100 万上下文保证

[English](ONE_MILLION_CONTEXT.md) · **简体中文**

这是 ccmodel 的招牌能力:**给模型加上 `[1m]`,它就能可靠地用上 1,000,000 token 的
上下文窗口** —— 而不是悄悄被限制在 20 万。

## 背景:`[1m]` 是什么,为什么会失效

`[1m]` 是 Claude Code 自己的约定,表示某个模型的「100 万上下文」变体(`opus[1m]`、
`sonnet[1m]`、`claude-opus-4-8[1m]`)。当你选中它时,Claude Code 本应:

1. 按 **1,000,000 token** 来记账(这样它不会在约 20 万就触发自动压缩),并且
2. 发送真正在 Anthropic Messages API 上解锁 1M 的「开关」——头部
   **`anthropic-beta: context-1m-2025-08-07`**。
   (在 Opus 4.6+ / Sonnet 4.6 上这个头部是「冗余但被接受」的,1M 是默认;在其他符合条件
   的模型上它是必需的。)

> 「Claude Code 在把模型 ID 发给你的 provider 之前会去掉 `[1m]` 后缀。」
> —— Claude Code 模型配置文档

问题在于:这个 beta 头部**会在好几条真实代码路径里被丢掉** —— 子代理的模型解析、
`--model` 参数、以及部分网关 / `ANTHROPIC_BASE_URL` 路由(在多个上游 issue 里都有记录)。
一旦头部丢失,请求就会悄悄退回到 **20 万** 窗口,大提示词开始报错 —— 恰恰是在你需要 1M
的时候。

## ccmodel 是怎么解决的

代理位于 `ANTHROPIC_BASE_URL` 上,因此它能看到**每一个**请求,是发往 Anthropic 前的
最后一跳。在每个 `POST /v1/messages` 上它会:

1. **检测 1M 意图**,以下任一信号即可(逻辑或):
   - 传入的 `model` ID 以 `[1m]` 结尾,**或**
   - 请求里已经带了 `anthropic-beta: context-1m-2025-08-07`(Claude Code 加上了 ——
     我们尊重它),**或**
   - 命中的路由设置了 `"context_1m": true | "force"`,**或**
   - 全局 `proxy.force_1m`(环境变量 `UC_FORCE_1M=1`)开启。
2. **去掉 `[1m]` 后缀**再发往上游(后端不认识它 —— 与 Claude Code 自身行为一致)。
3. 在 Anthropic 直通路径上**保证 beta 头部存在**:把 `context-1m-2025-08-07` 加进
   `anthropic-beta`,并与已有的 beta(如 `prompt-caching-…`)**合并**去重。幂等。

所以即便 Claude Code 把头部丢了,ccmodel 也会把它补回去。`[1m]` 就是 1M。

对于**兼容 OpenAI** 的后端(MiniMax-M3 等),1M 窗口是后端**自身**的属性,而不是某个
Anthropic beta —— 因此代理只是转发去掉后缀后的干净模型 ID,并且绝不裁剪输入。`[1m]` 变体
在那里仍然有意义:它让 Claude Code 按 1M 窗口来做自己的压缩记账。

## 怎么开启

### 1. 按选择启用(影响范围最小)

在 `/model` 里广告出一个 `[1m]` 伴生条目,需要 1M 时选它:

```jsonc
{
  "proxy": { "advertise_1m_variants": true },   // 给每个模型加一个 "<id>[1m]" 兄弟
  "models": [ { "id": "claude-opus-4-8", "display_name": "Opus 4.8" } ],
  "routes": { "claude-opus-4-8": { "model": "claude-opus-4-8", "auth": "passthrough" } }
}
```

`/model` 里你会同时看到 **Opus 4.8** 和 **Opus 4.8[1m]**,后者就是 1M 会话。

只想按单个模型启用?去掉 `advertise_1m_variants`,在该 `models` 条目上设
`"context_1m": true`。

### 2. 某条路由始终启用

```jsonc
"claude-minimax-m3": {
  "type": "openai_compat",
  "upstream": "https://api.minimax.io/v1",
  "model": "MiniMax-M3",
  "auth": "Bearer ${MINIMAX_API_KEY}",
  "context_1m": "force"        // 这条路由的每个请求都用 1M
}
```

用 `"force"` 时,ccmodel **只**广告该模型的 `[1m]` 变体(因为裸 ID 行为完全一样,两个都显示
反而令人困惑)。

### 3. 全部、始终启用

```jsonc
"proxy": { "force_1m": true }
```

或用 `UC_FORCE_1M=1` 运行。**仅当**你路由的**每一个**后端都支持 1M 时才这样做 —— 否则不
支持的后端会拒绝超大输入。

## 怎么验证它在生效

离线自测断言了整条链路(`npm test`):

- 选了 `[1m]` → 上游看到的是**去掉后缀**的 ID,*并且*带有 `context-1m-2025-08-07` 头部;
- 传入已带 beta 头部 → 与其他 beta **一起保留并去重**;
- 在 `openai_compat` 后端上选 `[1m]` → 后端拿到的是**干净**的模型 ID(原生 1M,无 Anthropic beta);
- 发现接口给 `[1m]` 变体带上 `context_window: 1000000` 提示。

对运行中的代理做实时检查:

```bash
# [1m] 变体已被广告
curl -s localhost:8141/v1/models | grep '\[1m\]'

# 健康检查里能看到 1M 策略
curl -s localhost:8141/healthz
```

想观察真实请求上的头部,用 `UC_VERBOSE=1` 启动代理,查看日志(Windows:
`%LOCALAPPDATA%\ccmodel\proxy.log`;其他系统:`~/.local/state/ccmodel/proxy.log`)。

## 注意事项

- **资格与计费由 provider 决定。** ccmodel 负责发送正确的头部;你的套餐是否给 1M(以及超过
  20 万后如何计费)是你和 provider 之间的事。在 Max/Team/Enterprise 上 Opus 1M 通常包含在内,
  Sonnet 1M 往往需要用量额度。参见 Anthropic 的上下文窗口文档。
- **已退役的 beta。** Anthropic 在 2026-04-30 为 Sonnet 4 / 4.5 退役了
  `context-1m-2025-08-07` beta;在这些模型上该头部不再起作用。请用当前支持 1M 的模型
  (Opus 4.6+/Sonnet 4.6)—— 在那里头部最多是「冗余但无害」。
- **`[1m]` 不是魔法。** 它无法给一个本就不支持的后端变出 1M;对 `openai_compat`,你仍然需要
  一个上下文确实那么大的模型。
