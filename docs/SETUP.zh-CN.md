# 安装指南

[English](SETUP.md) · **简体中文**

可在 **Windows 11**(无需 WSL)以及 **macOS / Linux / WSL** 上运行。

## 1. 前置条件

| 需要 | 检查 | 获取 |
|------|------|------|
| Node.js 18+ | `node --version` | https://nodejs.org(Windows 勾选 **Add to PATH**) |
| Claude Code CLI | `claude --version` | `npm i -g @anthropic-ai/claude-code` |
| UltraCode 权限 | 你以前用过 `/effort ultracode` | 属于你的 Claude 套餐 |
| ≥1 个后端凭证 | — | 一个 API key,和/或 `codex login` |

只安装**开发**依赖(TypeScript、类型声明);代理本身只跑在 Node 内置模块上。

## 2. 克隆、构建、检查

```bash
git clone <本仓库> ccmodel
cd ccmodel
npm install        # 安装开发依赖并构建(dist/)
npm run doctor     # 校验环境 + 配置,跑离线自测
```

doctor 显示 `self-test passed` 就说明安装没问题。(随时都可以跑 doctor。)

## 3. 配置你的模型

```bash
copy config.example.jsonc config.jsonc   # Windows
cp   config.example.jsonc config.jsonc   # mac/linux
```

`config.jsonc` 已被 gitignore。保留你要的 `models` + `routes` 条目,删掉其余,key 直接写在
文件里或用 `${VAR}`。各后端模板见 [ADD_A_MODEL.zh-CN.md](ADD_A_MODEL.zh-CN.md);开启 `[1m]`
1M 变体见 [ONE_MILLION_CONTEXT.zh-CN.md](ONE_MILLION_CONTEXT.zh-CN.md)。

### 用 ChatGPT/Codex 登录跑 GPT-5.5(可选)

1. 安装 Codex CLI 并跑一次 `codex login` → 生成 `~/.codex/auth.json`。
2. 保留 `claude-gpt-5.5-codex` 条目。无需 API key。

## 4. 再跑一次 doctor

```bash
npm run doctor
```

逐条解决 `[FAIL]`(每条都打印修复方法),直到干净退出。

## 5. 启动(跨平台)

一个启动器,Windows / macOS / Linux / WSL 通用:

```bash
npm run launch          # 等价于 node bin/ccmodel.mjs
```

它会在首次运行时构建、启动代理、开启网关发现、播种模型缓存,然后打开 Claude Code。
`npm run launch -- --proxy-only` 只启动代理并让它常驻。

可选的桌面启动项(Windows `.lnk` / macOS `.command` / Linux `.desktop`):

```bash
npm run icons
```

会创建 **CCModel (All Models)**(代理 + Claude Code,已开发现)和 **Claude Code (Normal)**
(你日常的安装,原封不动)。

## 6. 开始使用

启动,输入 `/model`,选一个后端。一切都跑在完整 UltraCode 下。标着 **`[1m]`** 后缀的选项以 1,000,000 token 窗口运行。

## 卸载

- `npm run uninstall` 会停止运行中的代理,并移除桌面启动项 + 会话状态(跨平台)。你的配置和
  Claude Code 不受影响。
- 要彻底移除,删掉仓库目录即可。本项目从不修改你的 `~/.claude` 和凭证。
