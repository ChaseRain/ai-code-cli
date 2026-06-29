# Product Specs — 目录

> 各功能域规格编目。每篇 spec 结构统一：**职责 / 接口 / 行为 / 验收(测试) / 不做**。
> 表中「评审维度」与「测试覆盖」对应 L2 命题的强制评分项。
> 状态取值：`implemented`（已实现并测试）/ `active`（契约现行）/ `draft/spec`（规格已定，代码未实现）/ `partial`（部分实现）。

| Spec | 功能域 | 评审维度 | 测试覆盖 | 状态 |
|---|---|---|---|---|
| [agent-loop.md](agent-loop.md) | Agent 主循环 | Agent Loop | ✅ 主循环 / maxTurns 终止 / 拒绝入上下文 | implemented |
| [tools.md](tools.md) | 工具系统（7 文件/Shell + `update_plan`） | 工具系统 | ✅ 结果回传 / 路径越界 / edit 唯一性 / shell 退出码 | implemented |
| [permissions.md](permissions.md) | 权限控制 | 权限控制 | ✅ 只读自动 / 写类确认 / 拒绝入上下文 | implemented |
| [provider.md](provider.md) | LLM Provider（**Anthropic Messages** + Mock） | LLM Provider | ✅ Mock Provider / SSE 解析 / 超时·重试 | implemented |
| [config.md](config.md) | 配置（用户级 + 项目级） | 配置管理 | ✅ 项目级优先 / 深合并 / 缺省回落 | implemented |
| [session-context.md](session-context.md) | 会话上下文 + 持久化 | 会话上下文 | ✅ 全要素入历史 / jsonl 落盘 | implemented |
| [tui.md](tui.md) | TUI + 内置命令 | TUI 交互体验 | ✅ 命令解析 + Ink render 冒烟（tests/tui-render.test.ts） | implemented |
| [memory.md](memory.md) | 记忆增强（resume / 压缩 / summary） | 扩展（加分） | ✅ resume + 命令 + Session 级压缩 + Loop 自动压缩（tests/memory.test.ts + tests/agent-loop.test.ts） | implemented |
| [checkpoint.md](checkpoint.md) | Checkpoint / Restore | 扩展（第一梯队） | ✅ tests/checkpoint.test.ts + agent-loop auto hook + 命令解析/确认提示 | implemented |
| [session-browser.md](session-browser.md) | Session Browser | 扩展（第一梯队） | ✅ tests/session-browser.test.ts + `/sessions` `/resume <id|latest>` 命令扩展 | implemented |
| [diff-git.md](diff-git.md) | Diff / Git-aware | 扩展（第一梯队） | ✅ tests/diff-git.test.ts + 未跟踪文件 diff + 写前 preview event + `/changes` `/diff` `/undo-last` | implemented |
| [task-plan.md](task-plan.md) | Task Plan / Todo 可观测（`update_plan` + `/plan`） | 扩展（加分） | ✅ tests/task-plan.test.ts + tools/tui-command/tui-render | implemented |
| [load-hardening.md](load-hardening.md) | 稳定性 / 压测硬化（LH1-LH8） | 可靠性 | ✅ LH1-LH8 全部（checkpoint/session/workspace/tools + 压测 C1-C3/D1-D3） | implemented |
| [guardrails-hardening.md](guardrails-hardening.md) | 边界硬化（P7-A~E：symlink/文件大小/配置上限/进程树/glob·grep 逃逸；P8-A/B：grep 资源·正则安全） | 安全·可靠性 | ✅ P7-A~E + P8-A/B（tests/guardrails.test.ts） | implemented |

## 测试矩阵（对应交付强制项）

| 评审强制测试 | 落在哪 | 状态 |
|---|---|---|
| Agent 主循环 | agent-loop.md | ✅ tests/agent-loop.test.ts |
| 工具调用与结果回传 | tools.md + agent-loop.md | ✅ tests/tools.test.ts |
| 权限确认与拒绝 | permissions.md | ✅ tests/permission.test.ts |
| 配置优先级 | config.md | ✅ tests/config.test.ts |
| Mock LLM Provider | provider.md（贯穿全部用例的驱动） | ✅ tests/provider.test.ts |

> 实测：基线 `npm test` 73/73；Round-2（2026-06-28）当前 `npm run build && npm test` = **91/91** 通过、`build` exit 0。完整验收记录见 [`../exec-plans/active/phase-1.md`](../exec-plans/active/phase-1.md)。
> Round-3 第一梯队（Checkpoint/Restore + Session Browser + Diff/Git-aware，2026-06-28）当前 `npm run build && npm test` = **112/112** 通过、`build` exit 0。计划见 [`../exec-plans/active/phase-2.md`](../exec-plans/active/phase-2.md)。
> Phase-3 Memory 自动压缩接入（2026-06-28）当前 `npm run build && npm test` = **116/116** 通过、`build` exit 0。计划见 [`../exec-plans/active/phase-3.md`](../exec-plans/active/phase-3.md)。
> Phase-4 质量硬化（2026-06-28）当前 `npm run build && npm test` = **120/120** 通过、`build` exit 0。计划见 [`../exec-plans/active/phase-4.md`](../exec-plans/active/phase-4.md)。
> Phase-5 Task Plan / Todo 可观测（2026-06-28）当前 `npm run build && npm test` = **131/131** 通过、`build` exit 0（含 `/clear` 日志唯一性回归硬化）。计划见 [`../exec-plans/active/phase-5.md`](../exec-plans/active/phase-5.md)。
> Phase-6 稳定性/压测硬化（2026-06-28）第一批 LH1-LH4 + 第二批 LH5-LH7 全部完成，当前 `npm run build && npm test` = **148/148** 通过、`build` exit 0；压测 C1-C3 + D1-D3 达标。计划见 [`../exec-plans/active/phase-6.md`](../exec-plans/active/phase-6.md)。
> Phase-7 Guardrails / 边界硬化（2026-06-28）P7-A~E（symlink 逃逸 / 文件大小上限 / 配置硬上限 / 进程树清理 / glob·grep pattern 逃逸）全部完成，当前 `npm run build && npm test` = **174/174** 通过、`build` exit 0；复现 P7-A~E 达标。计划见 [`../exec-plans/active/phase-7.md`](../exec-plans/active/phase-7.md)。
> Phase-8 grep 资源与正则安全（2026-06-28）P8-A（stat-before-read 跳过过大文件）+ P8-B（拒绝 nested quantifier / 歧义 alternation ReDoS，含非捕获/命名捕获/一层包装/可选分支/字符类首 token 补洞）+ P8-C（语义原子 `\d`/`\w`/`\s`/`.`/否定类 + 一层分支 unwrap）完成，当前 `npm run build && npm test` = **213/213** 通过、`build` exit 0；复现 P8-A/B/C 达标。计划见 [`../exec-plans/active/phase-8.md`](../exec-plans/active/phase-8.md)。
