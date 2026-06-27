# Product Specs — 目录

> 各功能域规格编目。每篇 spec 结构统一：**职责 / 接口 / 行为 / 验收(测试) / 不做**。
> 表中「评审维度」与「测试覆盖」对应 L2 命题的强制评分项。

| Spec | 功能域 | 评审维度 | 测试覆盖 | 状态 |
|---|---|---|---|---|
| [agent-loop.md](agent-loop.md) | Agent 主循环 | Agent Loop | ✅ 主循环 / maxTurns 终止 | draft |
| [tools.md](tools.md) | 工具系统（7 原子工具） | 工具系统 | ✅ 结果回传 / 路径越界 / edit 唯一性 / shell 退出码 | draft |
| [permissions.md](permissions.md) | 权限控制 | 权限控制 | ✅ 只读自动 / 写类确认 / 拒绝入上下文 | draft |
| [provider.md](provider.md) | LLM Provider（OpenAI + Mock） | LLM Provider | ✅ Mock Provider / 解析 / 超时·重试 | draft |
| [config.md](config.md) | 配置（用户级 + 项目级） | 配置管理 | ✅ 项目级优先 / 深合并 / 缺省回落 | draft |
| [session-context.md](session-context.md) | 会话上下文 + 持久化 | 会话上下文 | ✅ 全要素入历史 / jsonl 落盘 | draft |
| [tui.md](tui.md) | TUI + 内置命令 | TUI 交互体验 | ⛳ 手测 + 关键单元（命令解析） | draft |

## 测试矩阵（对应交付强制项）

| 评审强制测试 | 落在哪 |
|---|---|
| Agent 主循环 | agent-loop.md |
| 工具调用与结果回传 | tools.md + agent-loop.md |
| 权限确认与拒绝 | permissions.md |
| 配置优先级 | config.md |
| Mock LLM Provider | provider.md（贯穿全部用例的驱动） |
