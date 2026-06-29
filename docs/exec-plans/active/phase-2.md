# Exec Plan: Phase 2 — Round-3 第一梯队增强

> 状态：implemented（M6 Checkpoint/Restore、M7 Session Browser、M8 Diff/Git-aware 已实现） · 最后更新：2026-06-28
> 承接 Phase-1 + Round-2 现状：`npm run build && npm test` = **91/91** 通过、`build` exit 0、截图 4/4；Round-3 第一梯队当前 **112/112** 通过。
> 纪律：docs-first（本计划 + 三篇 spec 评审通过后再进入代码阶段）；`src/cli.tsx` 仍只做 composition root。

## 目标（Round-3 第一梯队）

| 能力 | 一句话 | Spec | 归属限界上下文（DDD） |
|---|---|---|---|
| Checkpoint / Restore | 写类操作前自动快照 + 手动检查点，可回滚工作区 | [`../../product-specs/checkpoint.md`](../../product-specs/checkpoint.md) | 新增**支撑域 Checkpoint（工作区快照）** |
| Session Browser | 列出/切换历史会话，从 jsonl 解析摘要 | [`../../product-specs/session-browser.md`](../../product-specs/session-browser.md) | 归属**核心域 Conversation/Session**（表现层 + Session 读侧） |
| Diff / Git-aware | 变更概览、写前 diff 预览、git 感知与降级、undo-last | [`../../product-specs/diff-git.md`](../../product-specs/diff-git.md) | 新增**支撑域 Workspace/VCS 感知** |

## 范围（In Scope）
- 三项能力的领域契约 + 命令 + 数据结构 + 行为流程 + 测试矩阵（本批）。
- 代码阶段：纯本地实现（Node fs / `git` CLI 探测），Mock 可测，不依赖网络。

## 非目标（Out of Scope）
- 远端/云端快照、跨机同步。
- 完整 VCS 实现（不自研 diff 算法核心；git 在场则委托 `git`，否则降级到基于 checkpoint 的快照对比）。
- 多会话**并发**运行（Session Browser 仅「选择并恢复一个」，非并行）。
- 压缩自动接入实时 loop 不在本梯队；后续已由 Phase-3 完成。

## 里程碑

- [x] **M6 Checkpoint/Restore**：`src/checkpoint/`（manifest + 文件快照 + 排除项 + restore）；loop 写前自动 checkpoint 钩子；`/checkpoint` `/checkpoints` `/restore`；测试。✅ 2026-06-28：`npm run build && npm test` = 99/99。
- [x] **M7 Session Browser**：Session 读侧索引（解析 `.ai_history/logs/*.jsonl` 摘要）；`/sessions` `/resume <id|latest>`；不展示 system prompt；测试。✅ 2026-06-28：`npm run build && npm test` = 103/103。
- [x] **M8 Diff/Git-aware**：`src/workspace/`（git 探测 + diff 提供者 + 降级）；`/changes` `/diff [path]`；写前 preview event；`/undo-last`；测试。✅ 2026-06-28：`npm run build && npm test` = 112/112。

## 验收矩阵

| # | 验收点 | 验证方式 |
|---|---|---|
| P2-A1 | 写类工具执行前自动生成 checkpoint，且排除项不入快照 | checkpoint.test：mock 工作区 → 触发写 → 断言 manifest + 排除 `.git/node_modules/dist/.env/.ai_history/checkpoints` |
| P2-A2 | `/restore <id>` 恢复前必确认；恢复后写 session 事件 | checkpoint.test + tui-render RestorePrompt + session restore event |
| P2-A3 | `/checkpoints` 列出 id/label/time/文件数 | checkpoint.test |
| P2-A4 | `/sessions` 解析出 id/time/首条意图/msg数/tool数/日志路径，且不含 system prompt 文本 | session-browser.test |
| P2-A5 | `/resume latest` 与 `/resume <id>` 均能定位并恢复（复用 Round-2 resumeFrom） | session-browser.test |
| P2-A6 | `/diff` 在 git repo 用 git；非 git repo 降级到本地摘要；都不崩溃 | diff-git.test（真实临时 git repo + 非 git 目录） |
| P2-A7 | `/undo-last` = 恢复到「最近一次自动 checkpoint」，语义与 restore 对齐 | diff-git.test / checkpoint.test |
| P2-A8 | 全部命令解析（含新命令）单测；`build && test` 仍全绿 | tui-command.test + CI |

## Round-3 M6 验收记录

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| Checkpoint 领域 | `tests/checkpoint.test.ts` | create/list/restore、排除项、路径越界、pre-restore checkpoint 通过 |
| Agent Loop 自动 checkpoint | `tests/agent-loop.test.ts` | 敏感工具 allow 后、执行前创建 `trigger=auto` checkpoint，并写 session event |
| TUI 命令与确认提示 | `tests/tui-command.test.ts` / `tests/tui-render.test.ts` | `/checkpoint` `/checkpoints` `/restore <id>` 解析；restore prompt 渲染 |
| Session Browser | `tests/session-browser.test.ts` / `tests/tui-command.test.ts` | 多 jsonl 摘要、system prompt 隐藏、latest/id/path resolve、坏行容错、`/sessions` 解析通过 |
| 全量构建测试 | `npm run build && npm test` | build exit 0；**103/103** 通过 |

## Round-3 M8 验收记录

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| Workspace/Git 状态 | `tests/diff-git.test.ts` | Git repo branch/changed/untracked、非 Git checkpoint 降级摘要通过 |
| Diff provider | `tests/diff-git.test.ts` | 指定路径 unified diff、增删统计、path guard、长 diff 截断通过 |
| Undo-last | `tests/diff-git.test.ts` | 最近 `trigger=auto` checkpoint 查询通过；TUI 复用 restore 确认流 |
| 写前 preview | `tests/agent-loop.test.ts` | 敏感工具授权前发出 preview event，且不阻断授权和执行 |
| TUI 命令 | `tests/tui-command.test.ts` | `/changes` `/diff [path]` `/undo-last` 解析通过 |
| 全量构建测试 | `npm run build && npm test` | build exit 0；**112/112** 通过 |

## 风险
- 文件快照成本：大仓库全量拷贝慢 → 用排除项 + 仅快照「将被写/编辑的文件 + 受影响目录」的策略上限；manifest 记录范围。
- git CLI 不在场或非 repo：必须降级不报错（A6）。
- restore 误删用户新文件：restore 语义需在 spec 明确（仅恢复 manifest 内记录的文件，不删除 manifest 外的新文件，或明确标注）——见 checkpoint.md「恢复语义」。
- 安全边界：快照/恢复一律限项目根内；密钥与 `.env` 永不快照。

## 后续增强候选
- `/diff` 未跟踪文件受控预览、大小限制与二进制识别已由 Phase-4 完成。
- 写前 preview 当前是摘要级事件；后续可按工具类型生成更细的 patch preview，但仍应保持 `agent/loop` 不直接做 git 细节。
