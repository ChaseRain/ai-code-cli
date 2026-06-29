# ai-code-cli

> 从零自研的最小可用 **TUI 终端编码 Agent**（对标 Claude Code / Codex CLI / Gemini CLI）。
> TypeScript + Node.js 22 + [Ink](https://github.com/vadimdemedes/ink)，走平台 **Anthropic Messages** 协议。
> 核心四件套（Agent Loop / 工具系统 / 权限 / 会话）全部自研，不依赖任何 Agent SDK / Framework。

第一原则：**less is more**。设计哲学与边界见 [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)。

---

## 设计哲学：Harness 工程 + DDD

本项目不是「写一个能跑的脚本」，而是按 **Harness（脚手架）工程**的思路构建——这套方法借鉴自 OpenAI《在智能体优先的世界中利用 Codex》（原文存档见 [`docs/references/harness-engineering.md`](docs/references/harness-engineering.md)），并贯穿整个仓库。

> **Harness = 模型之外的一切**：Agent 循环、工具、上下文管理、解析、错误处理、可观测性。
> 模型负责**决策**，harness 负责**执行与守护栏**（权限确认、最大轮次、超时重试、路径沙箱）。

它落在三个层面：

### 1) 代码仓库即「记录系统」，AGENTS.md 是地图而非手册

不把规则堆进一个巨大的说明文件，而是把知识结构化进 `docs/`，用一份精简的 [`AGENTS.md`](AGENTS.md)（≈100 行）作**地图**，指向更深的真相来源，实现**渐进式披露**：

```
AGENTS.md            ← 入口地图（读这个先）
ARCHITECTURE.md      ← 系统分层与依赖规则
docs/design-docs/    ← 操作原则 + DDD 设计（用例/领域/时序）
docs/product-specs/  ← 各功能域规格（每篇带状态/测试覆盖）
docs/exec-plans/     ← 计划与决策日志（一等工件）
docs/references/     ← 外部事实唯一来源（理念原文/命题/平台 API）
```

凡是运行时进不了上下文的知识（聊天记录、脑子里的约定）对 Agent 都不存在——所以一切都版本化进仓库、交叉链接、单一真相来源。

### 2) DDD 分层抽象：上层不清晰，不进下层

设计严格遵循 **用例 → 领域 → 系统 → 编码** 的分层（详见 [`docs/design-docs/index.md`](docs/design-docs/index.md)），先定**限界上下文与统一语言**，再谈实现：

| 抽象层 | 产物 |
|---|---|
| ① 用例 | [`use-cases.md`](docs/design-docs/use-cases.md)（谁、想达成什么 + 用例图） |
| ② 领域 | [`domain-model.md`](docs/design-docs/domain-model.md)（限界上下文 / 聚合 / 不变量 + 上下文映射、类图） |
| ③ 系统 | [`ARCHITECTURE.md`](ARCHITECTURE.md)（分层 → 代码目录的落地映射） |
| ④ 编码 | `src/` + [`docs/product-specs/`](docs/product-specs/index.md) |

六个限界上下文：核心域 **Agent 编排（Conversation）**，支撑域 **Tooling / Authorization**，通用域 **Model Gateway / Configuration**，表现层 **TUI**。

> **关于启动/入口文件的特别说明（DDD 组合根）**
> `src/cli.tsx` 是整个应用唯一的 **Composition Root（组合根）**：它本身**不含任何业务逻辑**，
> 只做一件事——把各限界上下文按依赖方向**装配并注入**起来：
> `dotenv 加载 .env → loadConfig（Configuration）→ 构造 Provider（Model Gateway）→ 注册 Tools（Tooling）→ Permission（Authorization）→ Session（会话）→ 交给 runAgent（核心域 Agent 编排）→ render TUI（表现层）`。
> 这样领域逻辑与「如何启动、依赖从哪来」彻底解耦：换 Provider、换工具集、改权限策略，都只动组合根的装配，不动核心域。
> 依赖规则（见 ARCHITECTURE.md）由结构强制：`agent/loop` 只编排不做 IO；`provider` 不认识 `tools`；`tui` 不内嵌业务。

### 3) 任何改动都依托这套 harness——也因此极易扩展、可由 AI 直接托管

- **改动的入口是规格，不是代码**：要加一个工具 / 换协议 / 调权限，先在对应 `product-specs/*.md` 改契约，再落到对应限界上下文。结构本身在引导「该改哪、不该碰哪」，把改动半径锁死在一个上下文内。
- **错误即数据 / 守护栏内建**：工具错误、权限拒绝、超时都转成结构化结果回喂模型；权限、轮次上限、路径沙箱由 harness 强制，不靠模型自觉——这让自动化改动是**安全**的。
- **扩展性强**：`Provider` 是协议无关抽象（已实测从 OpenAI 切到 Anthropic 只是换具体实现）；工具是统一 `Tool` 接口；新增能力是「加一个文件 + 一篇 spec + 一组测试」，不牵动全局。
- **AI 托管可行性高**：因为全部知识都在仓库内、版本化、Agent 可读，边界清晰、不变量可机械校验、测试矩阵齐全——一个编码 Agent 能**直接从仓库推理出完整业务域**并自主扩展，无需外部上下文。本项目本身就是范例：它的代码就是由多 Agent 工作流按这套 `docs/` 规格自动生成的。

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
| `/model` / `/model <id>` | 查看 / 切换当前模型 |
| `/status` | 显示模型 / baseURL / 最大轮次 / Key 是否已配置 |
| `/resume` | 从最近一次会话日志恢复上下文 |
| `/sessions` | 列出本地历史会话（最近 50） |
| `/memory` | 查看记忆状态（消息数 / 是否含摘要 / 当前日志） |
| `/checkpoint [label]` | 创建本地可恢复快照 |
| `/checkpoints` | 列出本地 checkpoint（最近 50） |
| `/restore <id>` | 确认后恢复指定 checkpoint |
| `/changes` | 查看 Git / 工作区变更概览 |
| `/diff [path]` | 查看全部或指定路径 diff |
| `/undo-last` | 确认后恢复最近一次自动 checkpoint |
| `/plan` / `/plan clear` | 查看 / 清空当前任务计划 |
| `/exit`、`/quit` | 退出 |

命令名大小写不敏感。命令清单的唯一真相来源是 `src/tui/command.ts` 的 `HELP_TEXT`。

## 测试

```bash
npm test           # vitest run（当前 213/213，以 npm test 输出为准）
```

覆盖 config/provider/tools/permission/agent-loop/session/tui + memory/checkpoint/session-browser/diff-git/task-plan/guardrails。
覆盖矩阵与各阶段验收计数见 [`docs/product-specs/index.md`](docs/product-specs/index.md)。

## 架构

| 目录 | 职责 |
|---|---|
| `src/cli.tsx` | 入口（组合根）：装配 config/provider/tools/permission/session/checkpoint/plan，启动 TUI |
| `src/config/` | 配置加载·合并·校验·密钥脱敏（含硬上限） |
| `src/provider/` | Anthropic Messages（SSE/超时/重试）+ Mock |
| `src/tools/` | 注册表 + 7 原子工具 + `update_plan` + 路径沙箱(realpath)/大小限制(`limits.ts`)/glob 逃逸守护 |
| `src/permission/` | 权限策略 + 会话级 allowlist |
| `src/agent/` | Agent Loop 编排（守护栏：maxTurns / abort；记忆自动压缩触发） |
| `src/session/` | 内存历史 + `.ai_history/logs/*.jsonl` 持久化 + resume/压缩 + Session Browser（`browser.ts`） |
| `src/checkpoint/` | 本地 checkpoint/restore 快照（原子 id / 资源预算 / list limit） |
| `src/workspace/` | Git 探测、status、diff、降级摘要、写前 preview（git timeout/输出上限） |
| `src/plan/` | 任务计划内存状态（`PlanStore`，供 `update_plan` 与 `/plan` 共享） |
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
