# Product Spec — Task Plan / Todo 可观测

> 状态：**implemented** · 最后更新：2026-06-28
> 模块：`src/plan/`、`src/tools/update-plan.ts`、`src/tui/command.ts`、`src/tui/App.tsx`、`src/cli.tsx`。

## 验收记录
- 2026-06-28：`npm run build` exit 0；`npm test` = **131/131** 通过。
- 手工 TUI 验收通过（2026-06-28）：`/plan` → `当前没有任务计划。`；`/plan clear` → `已清空当前任务计划。`。
- 覆盖 TP1–TP6：`tests/task-plan.test.ts`（PlanStore 校验/version/拷贝隔离 + `update_plan` 工具）、
  `tests/tools.test.ts`（默认注册表含 `update_plan`、原 7 工具不退化、readOnly 5/敏感 3）、
  `tests/tui-command.test.ts`（`/plan` `/plan clear` 解析 + HELP_TEXT 含 `/plan`）、
  `tests/tui-render.test.ts`（`/plan` 计划展示渲染）。

## 职责

Task Plan 让 Agent 在复杂任务中显式维护步骤状态，用户可以在 TUI 中查看当前计划。它是 harness 状态，不是项目文件；用于提升可观测性、验收性和长任务协作质量。

## DDD 边界

| 层 | 边界 | 说明 |
|---|---|---|
| use-case | 更新计划、查看计划、清空计划 | 面向模型工具与 TUI |
| domain | `PlanItem`、`PlanSnapshot`、`PlanStore` | 只管理计划状态，不执行任务 |
| system | `src/plan/` | 校验、存储、格式化 |
| code | `update_plan` 工具、`/plan` 命令、App 注入 | 工具更新状态，TUI 展示状态 |

## 工具接口

工具名：`update_plan`

```ts
{
  explanation?: string,
  items: Array<{
    step: string,
    status: "pending" | "in_progress" | "completed" | "blocked" | "canceled"
  }>
}
```

行为：
- `items` 必须是 1–20 项。
- `step` 非空，最多 200 字符。
- 同一时刻最多一个 `in_progress`。
- 工具为 `readOnly=true`：它只更新 harness 内部计划，不改仓库文件，不需要权限弹窗。
- 更新结果进入工具结果上下文，也在 TUI 中可见。

## TUI 命令

| 命令 | 行为 |
|---|---|
| `/plan` | 查看当前计划 |
| `/plan clear` | 清空当前计划 |

## 验收测试

| # | 用例 | 断言 |
|---|---|---|
| TP1 | `PlanStore.update` 正常更新 | version 递增，snapshot 含 explanation/items |
| TP2 | 多个 `in_progress` | 拒绝，错误清晰 |
| TP3 | 空列表/过长列表/空 step/过长 step/非法 status | 拒绝，状态不被污染 |
| TP4 | `update_plan` 工具 | readOnly=true，更新 store，返回格式化结果 |
| TP5 | `/plan` `/plan clear` | 命令解析正确；TUI 能展示当前计划与清空结果 |
| TP6 | 工具注册与回归 | `createDefaultRegistry` 包含 `update_plan`；原 7 个文件/Shell 工具不退化 |

## 非目标

- 不实现多 Agent 调度。
- 不让计划自动执行工具。
- 不把计划写入项目文件。
- 不做跨会话持久计划；会话恢复仍以 `.ai_history/logs` 为主。
