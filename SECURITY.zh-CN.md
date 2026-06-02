# 安全策略

[English](SECURITY.md) · **简体中文**

## 报告漏洞

ccmodel 是一个非官方的社区项目。若你发现安全问题，请**私下**报告 —— 开一个 GitHub
Security Advisory（首选）或直接联系维护者 —— 而不要发公开 issue。请附上描述、复现步骤
和你观察到的影响，并在修复前留出合理的时间窗口再做公开披露。

## ccmodel 如何处理凭证

ccmodel 是一个你自己运行的本地回环代理；理解它的信任模型尤为重要：

- **你的密钥存放在 `config.jsonc` / `ccmodel.env`**，两者都已 gitignore。请保持如此 ——
  绝不提交。优先用 `${ENV_VAR}` 引用，而非内联明文 key。
- **默认绑定 `127.0.0.1`。** 不要把代理暴露到公网接口；它不做任何客户端鉴权，会把你的
  上游凭证转发给任何能访问到它的人。
- **凭证绝不交叉转发。** ccmodel 只发送所匹配后端配置的 `key`，并在与第三方（OpenAI
  兼容）后端通信前剥掉 Claude Code 自带的入站凭证。
- **日志已脱敏。** `Bearer` 令牌、`authorization`/`x-api-key` 的值，以及 `sk-…` 形态的
  key，在写入日志文件或 stderr 前都会被掩码。但日志仍可能包含提示词/回复内容 ——
  请把日志文件（`%LOCALAPPDATA%\ccmodel\proxy.log` /
  `~/.local/state/ccmodel/proxy.log`）当作敏感数据对待。
- **不影响你的全局 Claude Code。** ccmodel 只为它启动的进程设置环境变量并传入会话级
  `--settings` 文件；绝不修改 `~/.claude`。

## 范围与责任

你需要自行遵守你通过 ccmodel 路由的各账号与提供商的条款。把某个提供商路由进来，可能涉及
计费与权限问题，这些都在你与该提供商之间。

## 受支持的版本

只有最新发布线会收到修复。请使用最新版本，以及当前受支持的 Node.js（20+）。
