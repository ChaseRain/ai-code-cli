# ARCHITECTURE — 顶层地图（系统设计层）

> 顶层结构、目录边界、依赖规则、数据流。模块内部细节见 `docs/product-specs/`。
> 状态：active（基线 + Phase-2 第一梯队 + Phase-3 Memory 自动压缩已落地） · 最后更新：2026-06-28
> **抽象层定位：③ 系统设计**。上承领域模型（[`docs/design-docs/domain-model.md`](docs/design-docs/domain-model.md)），
> 下接功能规格与编码。本文是「限界上下文 → 代码目录/分层」的落地映射。

## 分层

```
┌──────────────────────────────────────────────┐
│                   TUI (Ink)                    │  输入 / 消息流 / 状态栏 / 权限弹窗 / 内置命令
└───────────────┬───────────────────▲───────────┘
                │ 用户输入·确认       │ 事件流(文本增量/工具事件/状态)
                ▼                    │
┌──────────────────────────────────────────────┐
│                 Agent Loop                     │  决策→工具→结果→再决策；守护栏(maxTurns/abort/memory)
└──┬──────────┬───────────┬──────────┬──────────┘
   ▼          ▼           ▼          ▼
┌──────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
│Prov- │ │  Tool   │ │Permission│ │ Session  │
│ider  │ │ Registry│ │  Policy  │ │ +Context │
└──────┘ └─────────┘ └──────────┘ └────┬─────┘
   ▲                                    ▼
┌──────┐                       .ai_history/logs/*.jsonl
│Config│  默认 ← 用户级 ← 项目级(优先) → 注入各层
└──────┘
        Phase-2 支撑域：Checkpoint(.ai_history/checkpoints) + Workspace/Git-aware
```

## 目录边界（`src/`）

| 目录 | 职责 | 对应 spec |
|---|---|---|
| `cli.tsx` | 入口（组合根）：装配 config/provider/tools/permission/session，启动 TUI | — |
| `config/` | 加载·合并·校验·脱敏 | product-specs/config.md |
| `provider/` | **Anthropic Messages** + Mock；SSE/超时/重试 | product-specs/provider.md |
| `tools/` | 工具注册表 + 7 文件/Shell 工具 + `update_plan` + 路径守护 | product-specs/tools.md |
| `plan/` | PlanStore：任务计划内存状态、校验、格式化（harness 状态，不写文件） | product-specs/task-plan.md |
| `permission/` | 策略 + 会话级 allowlist | product-specs/permissions.md |
| `agent/` | Agent Loop 编排 | product-specs/agent-loop.md |
| `session/` | 历史 + jsonl 持久化 + resume + memory compaction | product-specs/session-context.md / product-specs/memory.md |
| `tui/` | Ink 组件 + 内置命令 | product-specs/tui.md |
| `checkpoint/` | 本地 checkpoint/restore 快照 | product-specs/checkpoint.md |
| `workspace/` | Git 探测、status、diff、降级摘要、写前 preview | product-specs/diff-git.md |

## 依赖规则（关键，CI 应能机械校验方向）

- `agent/loop` **只编排**，不直接做 HTTP / 文件 IO / 渲染。
- `provider` 不认识 `tools`；`tools` 不认识 `provider`；两者经 `loop` 串联。
- `tui` 通过事件流消费 `loop`，不内嵌业务逻辑。
- `config` 单向注入各层；secrets 不下沉到任何可日志路径。
- `checkpoint/` 和 `workspace/` 是支撑域；`agent/loop` 只调用其接口，不内嵌快照或 git 细节。
- memory compaction 由 `session` 提供能力，`agent/loop` 只在 Provider 请求前触发；摘要失败不阻断主循环。
- `plan/` 是纯内存 harness 状态：`update_plan` 工具与 `/plan` 命令共享 cli 注入的**同一个 PlanStore**；不写项目文件、不执行步骤。

## 数据流（一轮）

用户输入 → `session` 追加 user → memory compaction（可选，超阈值才执行）→ `provider`(流式) → 解析 `tool_calls` → `permission`(只读直过 / 写类弹确认) → 执行或生成「拒绝」结果 → `tool` 结果回 `session` → 循环，直到无 `tool_call`（最终回复）或触顶 `maxTurns`。

Phase-2 写类工具流：写类工具 → preview 摘要 → permission 确认 → 自动 checkpoint → 执行工具 → session 记录工具结果与 checkpoint/restore 事件。
