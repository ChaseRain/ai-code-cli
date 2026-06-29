# Exec Plan: Phase 5 — Task Plan / Todo 可观测

> 状态：**implemented** · 最后更新：2026-06-28
> 目标：补齐成熟 Coding Agent 的任务计划可观测能力，同时保持实现小而稳。

## 验收记录
- 2026-06-28：`npm run build` exit 0；`npm test` = **131/131** 通过；`git diff --check` 干净。
- P5-A1 PlanStore 校验（TP1–TP3）、P5-A2 `update_plan` 工具 readOnly + 执行（TP4/TP6）、
  P5-A3 `/plan` `/plan clear` 解析与展示（TP5）、P5-A4 历史回归（131/131）、**P5-A5 人工 TUI 验收已通过**。
- **P5-A5 人工 TUI 验收（2026-06-28）**：`npm run dev` 正常进入空闲态；
  输入 `/plan` → `当前没有任务计划。`；输入 `/plan clear` → `已清空当前任务计划。`；退出后清理本次临时日志。
- **历史回归硬化**：修复 `Session.newLogPath` 同毫秒冲突——`/clear` / `Session.clear()` 每次生成唯一日志路径
  （同毫秒用进程内单调序号兜底），旧日志保留。契约见 [`../../product-specs/session-context.md`](../../product-specs/session-context.md)「日志路径唯一性」；
  确定性测试：`tests/session.test.ts`（fake timer 固定同毫秒，连续 clear 两次 → 3 个 logPath 全不同 + 旧日志不丢）。

## 目标

提供一个模型可调用的 `update_plan` 工具和用户可查看的 `/plan` 命令，让长任务的步骤、当前进行项和完成情况可追踪。

## 范围

| 能力 | 说明 | Spec |
|---|---|---|
| PlanStore | 内存计划状态、校验、格式化 | [`../../product-specs/task-plan.md`](../../product-specs/task-plan.md) |
| update_plan 工具 | 模型更新计划，readOnly，无权限弹窗 | [`../../product-specs/task-plan.md`](../../product-specs/task-plan.md) |
| /plan 命令 | 用户查看/清空计划 | [`../../product-specs/task-plan.md`](../../product-specs/task-plan.md) |

## 验收矩阵

| # | 验收点 | 验证方式 |
|---|---|---|
| P5-A1 | plan 校验覆盖正常和异常输入 | `tests/task-plan.test.ts` |
| P5-A2 | update_plan 工具注册、readOnly、执行结果正确 | `tests/tools.test.ts` / `tests/task-plan.test.ts` |
| P5-A3 | `/plan` `/plan clear` 命令解析与 TUI 展示 | `tests/tui-command.test.ts` / `tests/tui-render.test.ts` |
| P5-A4 | 历史功能回归 | `npm run build && npm test` |
| P5-A5 | 启动 TUI 手工验收 `/plan` | 手工（已通过，见上方验收记录） |

## 风险控制

- 工具只更新内存 harness 状态，不落项目文件，避免污染仓库。
- `PlanStore` 做强校验，避免模型输出异常结构导致 TUI 崩溃。
- 不改变文件/Shell 工具权限语义。
