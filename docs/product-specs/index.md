# Product Specs — 目录

> 各功能域规格编目。每篇 spec 结构统一：**职责 / 接口 / 行为 / 验收(测试) / 不做**。
> 表中「评审维度」与「测试覆盖」对应 L2 命题的强制评分项。
> 状态取值：`implemented`（已实现并测试）/ `active`（契约现行）/ `draft`（草稿，未实现）。

| Spec | 功能域 | 评审维度 | 测试覆盖 | 状态 |
|---|---|---|---|---|
| [agent-loop.md](agent-loop.md) | Agent 主循环 | Agent Loop | ✅ 主循环 / maxTurns 终止 / 拒绝入上下文 | implemented |
| [tools.md](tools.md) | 工具系统（7 原子工具） | 工具系统 | ✅ 结果回传 / 路径越界 / edit 唯一性 / shell 退出码 | implemented |
| [permissions.md](permissions.md) | 权限控制 | 权限控制 | ✅ 只读自动 / 写类确认 / 拒绝入上下文 | implemented |
| [provider.md](provider.md) | LLM Provider（**Anthropic Messages** + Mock） | LLM Provider | ✅ Mock Provider / SSE 解析 / 超时·重试 | implemented |
| [config.md](config.md) | 配置（用户级 + 项目级） | 配置管理 | ✅ 项目级优先 / 深合并 / 缺省回落 | implemented |
| [session-context.md](session-context.md) | 会话上下文 + 持久化 | 会话上下文 | ✅ 全要素入历史 / jsonl 落盘 | implemented |
| [tui.md](tui.md) | TUI + 内置命令 | TUI 交互体验 | ✅ 命令解析 + Ink render 冒烟（tests/tui-render.test.ts） | implemented |
| [memory.md](memory.md) | 记忆增强（resume / 压缩 / summary） | 扩展（加分） | ✅ resume + 命令 + Session 级压缩（tests/memory.test.ts）；自动接入 loop 未做 | partial |

## 测试矩阵（对应交付强制项）

| 评审强制测试 | 落在哪 | 状态 |
|---|---|---|
| Agent 主循环 | agent-loop.md | ✅ tests/agent-loop.test.ts |
| 工具调用与结果回传 | tools.md + agent-loop.md | ✅ tests/tools.test.ts |
| 权限确认与拒绝 | permissions.md | ✅ tests/permission.test.ts |
| 配置优先级 | config.md | ✅ tests/config.test.ts |
| Mock LLM Provider | provider.md（贯穿全部用例的驱动） | ✅ tests/provider.test.ts |

> 实测：基线 `npm test` 73/73；Round-2（2026-06-28）当前 `npm run build && npm test` = **91/91** 通过、`build` exit 0。完整验收记录见 [`../exec-plans/active/phase-1.md`](../exec-plans/active/phase-1.md)。
