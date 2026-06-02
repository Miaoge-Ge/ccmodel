# 为 ccmodel 贡献

[English](CONTRIBUTING.md) · **简体中文**

感谢你帮助改进 ccmodel。它是一个轻量、几乎零依赖的 TypeScript/Node 代理；我们追求的是
高信噪比、且能保持这种轻量的改动。

## 环境准备

```bash
npm install        # 安装开发依赖并构建 dist/
npm run doctor     # 校验环境与配置，并运行离线自测
```

需要 **Node.js 20+**。运行时只用 Node 内置模块；开发工具链是 TypeScript、ESLint、
Prettier 和 `node:test`。

## 开发循环

```bash
npm run build         # tsc -> dist/
npm test              # 构建并运行离线自测（无需网络/密钥）
npm run test:coverage # 同上，附带 V8 覆盖率
npm run lint          # eslint .
npm run format        # prettier --write .   （format:check 用于校验）
```

构建、测试、lint、格式检查四项都必须通过才能提交 PR。CI 会在 Node 20/22/24 ×
Linux/Windows 上运行。

## 项目结构

源码分层（见 [docs/MANUAL.zh-CN.md §9](docs/MANUAL.zh-CN.md#9-架构与文件地图)）：

- `src/config/` —— 配置的加载、归一化与校验。
- `src/core/` —— 环境变量/`${VAR}`、id、日志、运行时类型、`which`。
- `src/net/` —— HTTP 客户端 + 请求头/SSE/Anthropic 输出。
- `src/pipeline/` —— UltraCode 信封、`[1m]`、模型发现、翻译、重试。
- `src/providers/` —— 每个后端一个模块，通过注册表解析。

新增一个后端 = 一个实现 `Provider` 的模块 + 在 `src/providers/registry.ts` 注册。

## 测试

测试位于 `test/`：

- `test/unit/*.test.ts` —— 每个模块一个文件。
- `test/integration.test.ts` —— 针对进程内 mock 后端的端到端测试。
- `test/helpers/harness.ts` —— 共享的 mock + 代理装置（本身不是测试）。

改哪个模块就在旁边补单测；若行为在端到端可观测，再补一条 integration 断言。整套测试
必须保持**离线** —— 不引入真实密钥或网络。

## 约定

- TypeScript `strict` 已开启；保持零错误（`npm run build` 即类型检查）。
- 与周围代码风格保持一致；Prettier（printWidth 140）是格式的唯一来源。
- 注释解释**为什么**，而非做了什么。放在现有代码放注释的地方。
- 绝不提交 `config.jsonc` 或 `ccmodel.env`（都已 gitignore —— 它们含密钥）。绝不记录
  凭证；日志会对常见形态做脱敏，但不要以此为借口去记录密钥。

## Pull Request

- PR 保持聚焦；一个 PR 只做一件事。
- 当行为或配置变化时，更新 `CHANGELOG.md`（Unreleased 部分）以及文档（中英文都要 ——
  项目保持两者同步）。
- 说明你验证了什么（跑了哪些 `npm` 脚本、是否做过实跑）。
