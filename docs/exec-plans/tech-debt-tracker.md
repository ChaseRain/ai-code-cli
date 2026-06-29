# Tech Debt Tracker

> 状态：active · 最后更新：2026-06-28
> 首期主动延后的能力登记于此。扩展能力不替代、不弱化基础功能。

| # | 项 | 类型 | 说明 | 触发条件 |
|---|---|---|---|---|
| T1 | 上下文压缩 / 历史摘要 | 扩展（加分） | **Memory 已实现 + 测试**（[`memory.md`](../product-specs/memory.md)）：resume、Session 级压缩、实时 Loop 自动压缩、TUI 可观测 | 完成 |
| T2 | 多 Provider（OpenAI Responses 等） | 扩展 | Provider 接口协议无关；Anthropic 已实现，其余未做 | 有需求时 |
| T3 | 会话 resume / 多会话切换 | 扩展 | **resume 从 jsonl 恢复（含摘要状态）+ Session Browser 已实现 + 测试**（[`session-browser.md`](../product-specs/session-browser.md)） | 完成 |
| T4 | Diff 可视化确认 / Git 感知 | 扩展 | **M8 + Phase-4 已实现 + 测试**（[`diff-git.md`](../product-specs/diff-git.md)）：`/changes`、`/diff [path]`、未跟踪文件预览、写前 preview、`/undo-last` | 完成 |
| T5 | MCP 工具接入 | 扩展 | 外部工具协议 | 有需求时 |
| T6 | doc-gardening 校验（CI lint 文档新鲜度/交叉链接） | 工程 | 当前靠人工遵守 doc hygiene | 仓库变大后 |
| T7 | Checkpoint / Restore | 扩展（第一梯队） | **M6 已实现 + 测试**（[`checkpoint.md`](../product-specs/checkpoint.md)）：手动/自动 checkpoint、restore 确认、session event | 完成 |
| T8 | Task Plan / Todo 可观测 | 扩展（加分） | **Phase-5 已实现 + 测试**（[`task-plan.md`](../product-specs/task-plan.md)）：`PlanStore` 强校验、`update_plan`（readOnly）、`/plan` `/plan clear`；纯内存、不写文件 | 完成 |
| T9 | 稳定性 / 压测硬化 | 可靠性（Phase-6） | **LH1-LH8 全部完成 + 测试 + 压测**（[`load-hardening.md`](../product-specs/load-hardening.md)）：原子 checkpoint id、run_shell 内存上限、Session/Checkpoint list limit、资源预算、git timeout/输出上限、resume 大日志上限 | 完成 |
| T10 | Guardrails / 边界硬化 | 安全·可靠性（Phase-7） | **P7-A~E 完成 + 测试**（[`guardrails-hardening.md`](../product-specs/guardrails-hardening.md)）：symlink 逃逸防护(realpath)、工具文件大小上限、config 硬上限、run_shell 进程树清理、glob/grep pattern 逃逸（含 symlink literal-prefix） | 完成 |
| T11 | grep 资源与正则安全硬化 | 安全·可靠性（Phase-8） | **P8-A/B 完成 + 测试**：grep stat-before-read（复用 `MAX_TOOL_FILE_BYTES`）+ **nested quantifier / 歧义 alternation ReDoS guard**（捕获/非捕获/命名/一层包装；轻量 guard，非 RE2）（[`guardrails-hardening.md`](../product-specs/guardrails-hardening.md) P8-A/B、[`../exec-plans/active/phase-8.md`](active/phase-8.md)） | 完成 |
