# ai-code-cli

> 从零自研的最小可用 **TUI 终端编码 Agent**（对标 Claude Code / Codex CLI / Gemini CLI）。
> TypeScript + Node.js 22 + [Ink](https://github.com/vadimdemedes/ink)，走平台 **Anthropic Messages** 协议。
> 核心四件套（Agent Loop / 工具系统 / 权限 / 会话）全部自研，不依赖任何 Agent SDK / Framework。

第一原则：**less is more**。设计哲学与边界见 [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)。

---

## 安装

需要 Node.js 22（LTS）。

```bash
npm install
```

> 依赖（含构建工具链）已固定在 `package-lock.json`，`npm install` 即装齐。

## 配置

密钥与端点从环境变量读取，由 gitignored 的 `.env` 加载（**密钥绝不入库、不打印、日志脱敏**）。
复制示例并填入你的 Coding Plan API Key：

```bash
cp .env.example .env
# 编辑 .env：
# ANTHROPIC_AUTH_TOKEN=<你的 key>
# ANTHROPIC_BASE_URL=https://ai-kas.kso.net/codeplan/anthropic
# ANTHROPIC_MODEL=deepseek/deepseek-v4-pro
```

配置加载优先级（深合并）：内置默认值 ← 用户级 `~/.config/ai-code-cli/config.json` ← 项目级 `<cwd>/.ai-code-cli/config.json`。
密钥解析顺序：`ANTHROPIC_AUTH_TOKEN` → `CODEPLAN_API_KEY` → 配置文件 `apiKey`。
字段说明见 [`docs/product-specs/config.md`](docs/product-specs/config.md)。

未配置 Key 时仍可进入 TUI，本地命令（`/help` `/status` `/model` `/clear` `/exit`）可用。

## 运行

```bash
npm run dev        # tsx 直跑 src/cli.tsx（开发）
# 或先构建再跑：
npm run build      # tsc → dist/
npm start          # node dist/cli.js
```

启动后在输入框直接描述任务，Agent 会按「决策 → 工具 → 结果 → 再决策」推进；
敏感操作（写 / 编辑 / Shell）会弹出权限确认。

## 内置命令

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/clear` | 清空当前会话上下文（开新日志文件） |
| `/model` | 查看当前模型 |
| `/model <id>` | 切换模型 |
| `/status` | 显示模型 / baseURL / 最大轮次 / Key 是否已配置 |
| `/exit`、`/quit` | 退出 |

命令名大小写不敏感。

## 测试

```bash
npm test           # vitest run（73 个用例，覆盖 config/provider/tools/permission/loop/session/tui）
```

覆盖矩阵见 [`docs/product-specs/index.md`](docs/product-specs/index.md)。

## 架构

| 目录 | 职责 |
|---|---|
| `src/cli.tsx` | 入口：装配 config/provider/tools/permission/session，启动 TUI |
| `src/config/` | 配置加载·合并·校验·密钥脱敏 |
| `src/provider/` | Anthropic Messages（SSE/超时/重试）+ Mock |
| `src/tools/` | 工具注册表 + 7 原子工具 + 路径沙箱守护 |
| `src/permission/` | 权限策略 + 会话级 allowlist |
| `src/agent/` | Agent Loop 编排（守护栏：maxTurns / abort） |
| `src/session/` | 内存历史 + `.ai_history/logs/*.jsonl` 持久化 |
| `src/tui/` | Ink 组件 + 内置命令解析 |

设计文档（渐进式披露，从 `AGENTS.md` 入口）：

- 操作原则 → [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)
- 用例 / 领域 / 时序 → [`docs/design-docs/`](docs/design-docs/)
- 系统分层与依赖规则 → [`ARCHITECTURE.md`](ARCHITECTURE.md)
- 各功能域规格 → [`docs/product-specs/`](docs/product-specs/)

## 安全边界

- 所有文件与 Shell 操作被限制在项目根（cwd）内，越界失败。
- 只读工具自动执行；写 / 编辑 / Shell 必须用户确认，拒绝结果作为数据回喂模型。
- API Key 永不入库、不打印；日志脱敏。对话过程沉淀到 `.ai_history/logs/`。
