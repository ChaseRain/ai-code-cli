# Exec Plan: Phase 3 — Memory 自动压缩接入

> 状态：implemented · 最后更新：2026-06-28
> 承接 Phase-2：Round-3 第一梯队已实现，`npm run build && npm test` = **112/112**。
> 纪律：Spec-driven；先收敛 `memory.md` 的自动接入契约，再改 Loop。

## 目标

把记忆增强从 Session 级能力推进到实时 Agent Loop 能力：当上下文历史超过阈值时，Loop 在请求 Provider 前自动压缩旧消息，保留前导 system、摘要 system、近窗消息，并把压缩动作写入 `.ai_history/logs`。

## 范围

| 能力 | 说明 | Spec |
|---|---|---|
| 默认本地摘要器 | 确定性 `HeuristicSummarizer`，不依赖网络，不调用真实模型 | [`../../product-specs/memory.md`](../../product-specs/memory.md) |
| Loop 自动触发 | 每轮 `provider.chat` 前检查 `session.maybeCompact` | [`../../product-specs/agent-loop.md`](../../product-specs/agent-loop.md) |
| TUI 可观测 | 压缩成功/失败以 system 消息展示；`/memory` 继续只读 | [`../../product-specs/tui.md`](../../product-specs/tui.md) |

## 非目标

- 不做长期向量记忆或跨项目知识库。
- 不默认调用真实模型做摘要。
- 不改变已有 `Session.append` / `resumeFrom` 的日志语义。
- 不让 `/memory` 触发压缩；它仍只是状态查看。

## 里程碑

- [x] **M9 Default Summarizer**：新增本地确定性摘要器；覆盖 user/assistant/tool/tool_call 的关键信息。
- [x] **M10 Loop Auto Compaction**：`runAgent` 注入 memory options；每轮 provider 前自动压缩；成功/失败均可观测。
- [x] **M11 TUI/Docs/Regression**：App/CLI 装配默认 memory options；测试与文档更新；真实 TUI 验收。

## 验收矩阵

| # | 验收点 | 验证方式 |
|---|---|---|
| P3-A1 | 超阈值时 Provider 收到压缩后的 messages，且 hasSummary=true | `tests/agent-loop.test.ts` |
| P3-A2 | Summarizer 失败不阻断任务；错误落日志，最终回复仍完成 | `tests/agent-loop.test.ts` |
| P3-A3 | 默认摘要器不依赖网络，输出包含旧消息数量和关键用户/工具信息 | `tests/memory.test.ts` |
| P3-A4 | 压缩事件能在 TUI 消息流中显示 | `tests/tui-render.test.ts` |
| P3-A5 | `npm run build && npm test` 全绿；启动 `npm run dev` 验收 `/memory` | 手工 + 自动回归 |

## 评分预期

- 基础题目分不受影响：Agent Loop、工具、权限、配置、Provider、TUI 均不改破。
- 扩展加分：把题目明确提到的“上下文压缩”从单元能力变成运行时能力，可作为记忆增强完整闭环证据。

## 验收记录

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| 默认摘要器 | `tests/memory.test.ts` | 输出旧消息数量、用户意图、工具信息；不依赖网络 |
| Loop 自动压缩 | `tests/agent-loop.test.ts` | Provider 请求前压缩，`hasSummary=true` |
| 失败不中断 | `tests/agent-loop.test.ts` | Summarizer 抛错时记录 error，最终回复仍完成 |
| TUI 可观测 | `tests/tui-render.test.ts` | memory 压缩事件作为 system 消息可见 |
| 全量回归 | `npm run build && npm test` | build exit 0；**116/116** 通过 |
