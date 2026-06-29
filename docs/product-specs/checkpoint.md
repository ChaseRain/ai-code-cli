# Product Spec — Checkpoint / Restore

> 状态：implemented（M6 已实现并测试；Phase-6 稳定性硬化中） · 最后更新：2026-06-28
> 模块：`src/checkpoint/`、`src/tui/command.ts`、`src/tui/App.tsx`、Agent Loop 写类工具前置钩子。
> **Phase-6 硬化**（见 [`load-hardening.md`](load-hardening.md)）：id 用 `randomUUID` + 原子目录占位（LH1）；资源预算（单文件/总量/最大文件数，超限写入 `excluded` 带原因，LH4）；`list({limit})` 按目录名倒序逐个读 manifest、凑满 limit 个**有效**项即停（坏目录跳过且不挤占结果数量）、`/checkpoints` 默认 50（LH6）。

## 职责

Checkpoint 提供本地可回退快照，用于写文件、编辑文件、执行可能改动工作区的命令之前保存可恢复状态。它服务于 Agent 编码过程的可审计和可回滚，不替代 Git，也不创建 Git commit。

## DDD 边界

| 层 | 边界 | 说明 |
|---|---|---|
| use-case | 创建检查点、列出检查点、恢复检查点、写类工具前自动检查点 | 面向用户命令与 Agent Loop 场景 |
| domain | `CheckpointManifest`、`CheckpointFile`、`CheckpointStore`、`RestorePlan` | 只表达快照与恢复语义，不做 TUI 渲染 |
| system | `src/checkpoint/` | 文件快照、manifest、排除项、restore 事务 |
| code | `src/tui/command.ts`、`src/agent/loop.ts`、`src/cli.tsx` | 命令解析与注入；`src/cli.tsx` 仍只做 composition root |

## 命令接口

| 命令 | 行为 | 输出字段 |
|---|---|---|
| `/checkpoint [label]` | 手动创建 checkpoint | id、label、createdAt、filesCount、excludedCount |
| `/checkpoints` | 按时间倒序列出 checkpoint | id、label、createdAt、trigger、filesCount、gitHead |
| `/restore <id>` | 恢复指定 checkpoint，执行前必须确认 | restore id、filesRestored、filesSkipped、preRestoreCheckpoint |

写类工具自动触发 checkpoint：
- `write_file`、`edit_file` 执行前必须创建 `trigger=auto` 的 checkpoint。
- `run_shell` 若通过权限层判定为写类/敏感命令，也必须先创建 checkpoint。
- 只读工具不创建 checkpoint。

## 数据结构

存储路径：

```text
.ai_history/checkpoints/<id>/
  manifest.json
  files/
    <relative-project-path>
```

`manifest.json`：

```ts
interface CheckpointManifest {
  id: string;
  label?: string;
  createdAt: string;
  trigger: "manual" | "auto";
  root: string;
  sessionLog?: string;
  gitHead?: string;
  gitStatusSummary?: string;
  files: Array<{
    path: string;
    sha256: string;
    size: number;
    existed: boolean;
  }>;
  excluded: string[];
}
```

## 快照边界

所有路径必须解析在 project root 内。快照默认排除：
- `.git`
- `node_modules`
- `dist`
- `.env`、`.env.*`、密钥类文件
- `.ai_history/checkpoints`
- 运行时缓存和大体积构建产物

自动 checkpoint 优先快照将被写入/编辑的文件；手动 checkpoint 可覆盖当前项目内可快照文件集合。manifest 必须记录实际包含与排除的路径摘要。

## 行为流程

1. 手动 checkpoint：解析 label → 扫描快照范围 → 写入 files → 写入 manifest → session 追加 checkpoint 事件。
2. 写类工具前自动 checkpoint：Agent Loop 在权限通过后、工具执行前创建 `trigger=auto` 的 checkpoint；失败则中止写类工具并把错误写入 session。
3. restore：加载 manifest → 生成 restore plan → TUI 要求用户确认 → 创建 pre-restore checkpoint → 覆盖恢复 manifest 中记录的文件 → session 追加 restore 事件。
4. 失败处理：restore 不允许静默半恢复；若恢复中途失败，必须报告失败文件，并保留 pre-restore checkpoint 供用户回退。

恢复语义：默认只恢复 manifest 中记录的文件，不删除 manifest 外新文件；后续若支持“严格恢复”必须另行设计并二次确认。

## 权限与安全

- `/restore <id>` 是破坏性操作，必须走确认。
- 不得恢复 project root 外路径。
- 不得快照 `.env` 和密钥内容。
- checkpoint manifest 只能记录脱敏摘要，不记录 secret 原文。

## 验收测试

| # | 用例 | 断言 |
|---|---|---|
| C1 | create/list | 创建 checkpoint 后可按时间倒序列出 |
| C2 | restore | 修改文件后 restore 可恢复 manifest 内文件 |
| C3 | 排除项 | `.git/node_modules/dist/.env/.ai_history/checkpoints` 不入快照 |
| C4 | 路径越界 | root 外路径创建或恢复被拒绝 |
| C5 | restore 确认 | 未确认不执行恢复 |
| C6 | 自动 checkpoint | 写类工具执行前创建 `trigger=auto` |
| C7 | session event | checkpoint/restore 事件写入 jsonl，且不喂 secret |

当前覆盖：`tests/checkpoint.test.ts`、`tests/agent-loop.test.ts`（自动 checkpoint hook）、`tests/tui-command.test.ts`（命令解析）、`tests/tui-render.test.ts`（restore 确认提示）。

## 非目标

- 不做远端云同步。
- 不做 Git commit 或 branch 操作。
- 不做跨仓库恢复。
- 不做二进制大文件优化。

## 下一步代码阶段建议

- 新增 `src/checkpoint/`：manifest、store、snapshot、restore。
- 扩展 `src/agent/loop.ts`：写类工具前置 checkpoint hook。
- 扩展 `src/tui/command.ts` 与 `src/tui/App.tsx`：新增命令和 restore 确认流。
- 新增 `tests/checkpoint.test.ts`，扩展 `tests/agent-loop.test.ts` 与 `tests/tui-command.test.ts`。
