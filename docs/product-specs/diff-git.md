# Product Spec — Diff / Git-aware

> 状态：implemented（代码已实现并测试；Phase-6 第二批容量硬化） · 最后更新：2026-06-28
> 目标模块：`src/workspace/`、`src/checkpoint/`、`src/tui/command.ts`、`src/tui/App.tsx`、`src/agent/loop.ts`。
> **Phase-6 LH5**（见 [`load-hardening.md`](load-hardening.md)）：所有 git 调用带 `timeout`(10s)+`maxBuffer`(16MiB)；`/changes` 变更/未跟踪文件各 cap 500 并标注「已截断」；**`formatWorkspaceStatus` 对 raw status 也只打印前 500 行预览 + 截断提示，不泄漏 cap 外文件名**；**`/changes` 的 git status 超时/溢出/错误经 `WorkspaceStatus.statusWarning` 展示诊断，不静默显示成「无变更」**；`/diff` 超时/溢出返回用户可见诊断，不静默变「干净」。

## 职责

Diff / Git-aware 提供当前工作区变更概览、文件 diff、写前变更摘要，以及基于最近自动 checkpoint 的 undo-last。它优先委托 Git；非 Git 仓库必须降级为可理解的本地摘要，不得崩溃。

## DDD 边界

| 层 | 边界 | 说明 |
|---|---|---|
| use-case | 查看状态、查看 diff、写前预览、撤销最近一次自动改动 | 面向 TUI 与 Agent Loop |
| domain | `WorkspaceStatus`、`DiffResult`、`GitState`、`UndoTarget` | 不关心渲染细节 |
| system | `src/workspace/`、`src/checkpoint/` | git 探测、diff 获取、checkpoint fallback |
| code | `src/tui/command.ts`、`src/tui/App.tsx`、`src/agent/loop.ts`、`src/cli.tsx` | 命令、展示与写前钩子；`src/cli.tsx` 仍只做 composition root |

## 命令接口

| 命令 | 行为 | 输出字段 |
|---|---|---|
| `/changes` | 展示工作区变更概览 | isGitRepo、branch、changedFiles、untrackedFiles、checkpointCount |
| `/diff [path]` | 展示全部或指定路径的 unified diff | path、additions、deletions、truncated、source |
| `/undo-last` | 恢复最近一次 `trigger=auto` checkpoint | checkpointId、createdAt、filesRestored |

`/status` 继续保留为运行时状态（模型、baseURL、Key、日志路径），不与工作区状态混用；这能避免用户在调试模型配置时被 Git 信息淹没。

## 行为流程

1. Git 探测：在 project root 内执行只读 git 命令，判断是否为 Git repo。
2. `/changes`：Git repo 用 `git status --short --branch`；非 Git repo 展示 checkpoint 摘要。
3. `/diff [path]`：Git repo 用 `git diff -- <path>`；非 Git repo 降级到目标文件/目录摘要，不生成伪 diff。
4. 写前 preview：写类工具在权限确认前向 UI 发出预计变更摘要；无法生成 diff 时展示原因，但不得阻断用户选择。
5. `/undo-last`：定位最近自动 checkpoint，复用 checkpoint restore 语义和确认流。

## Git 与降级策略

- Git 可用：优先展示 branch、staged/unstaged/untracked、unified diff。
- Git 不可用或非 repo：返回 `isGitRepo=false`，展示 checkpoint 数、最近 checkpoint、目标文件存在性与大小变化。
- diff 过长时截断，输出必须标记 `truncated=true`。
- 所有 path 参数必须通过 root guard；`../` 或绝对路径逃逸一律拒绝。

## 与 Checkpoint 的关系

`/undo-last` 不是独立恢复系统；它等价于“恢复最近一次自动 checkpoint”。因此权限确认、路径边界、密钥排除和 session event 都沿用 `checkpoint.md`。

## 验收测试

| # | 用例 | 断言 |
|---|---|---|
| D1 | Git repo `/changes` | 返回 branch、changedFiles、untrackedFiles 与 raw status |
| D2 | 非 Git repo `/changes` | 不崩溃，返回 `isGitRepo=false` 与 checkpointCount |
| D3 | `/diff [path]` | 指定路径 diff 正确，新增/删除行统计正确 |
| D4 | path guard | `/diff ../x` 或绝对路径逃逸拒绝 |
| D5 | diff 截断 | 长 diff 标记 `truncated=true` |
| D6 | 写前 preview | 写类工具权限确认前发出变更摘要事件，不阻断后续授权 |
| D7 | `/undo-last` | 找到最近自动 checkpoint，复用 restore 确认流；无目标时给出清晰提示 |
| D8 | TUI 回归 | 启动 `npm run dev`，手工验证 `/changes`、`/diff`、`/sessions`、`/checkpoints` 本地命令可用 |
| D9 | 未跟踪文件 diff | `/diff <untracked-file>` 展示受控 new file 预览；`/diff` 总览列出未跟踪文件 |
| D10 | 写前 shell preview | `run_shell` 预览使用真实工具参数 `command`，不能显示“未知命令” |
| D11 | 二进制/大文件保护 | 未跟踪二进制文件不展开内容；长文本仍截断并标记 |

## 非目标

- 不实现完整 Git 客户端。
- 不做 merge/rebase/stage/commit。
- 不替代 checkpoint 的恢复语义。
- 不做大型二进制 diff。

## 实现落点

- 已新增 `src/workspace/`：git probe、status、diff provider、fallback 摘要、写前 preview、latest auto checkpoint 查询。
- 已扩展 `src/agent/loop.ts`：写类工具前发出 preview event，再进入 permission + checkpoint hook。
- 已扩展 `src/tui/command.ts` 与 `src/tui/App.tsx`：`/changes`、`/diff`、`/undo-last`。
- 已新增 `tests/diff-git.test.ts`，扩展 `tests/agent-loop.test.ts` 与 `tests/tui-command.test.ts`。
- 不新增复杂 Git 客户端抽象；所有 Git 调用集中在 `src/workspace/`，TUI 不直接执行 git。

## 验收记录

2026-06-28：`npm run build` exit 0；`npm test` = **112/112** 通过。
2026-06-28 Phase-4 质量硬化：补齐未跟踪文件 diff、run_shell preview 参数、二进制保护与相关测试；`npm run build && npm test` = **120/120** 通过。
