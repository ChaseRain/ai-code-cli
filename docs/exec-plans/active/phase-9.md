# Exec Plan: Phase 9 — 评审 Loop Round-1（可靠性补强 + 优异上下文压缩加分）

> 状态：implemented（代码 + 测试已落地，243/243 通过，build exit 0） · 最后更新：2026-06-29
> 来源：作为 L2 评委的多维度评审（workflow `l2-eval-round1`，9 位专家并行审阅 + 评委独立复核验证）。
> 纪律：**docs-first**。本计划 + 受影响 spec 评审通过后再进入代码阶段。所有改动在当前分支，`src/cli.tsx` 仍只做 composition root。

## 评委裁决（已独立验证，剔除误报）

评审共识：基线七维度均已 implemented，工程质量高。以下是**经评委逐条复核源码确认为真**的缺口；
两条 major 误报已剔除（resumeFrom 不会污染被恢复的旧日志——它从不改 `logPath`，新 append 落当前会话独立日志；
SSE 多行 `data:` 用 `\n` 拼接对 Anthropic 单 data 行无副作用）。

### Tier 1 — 基线可靠性缺口（不补会扣"LLM Provider/超时重试"分）

| 编号 | 缺口 | 证据（已复核） | 归属 spec |
|---|---|---|---|
| P1 | **SSE 流读取无超时**：`send()` 的超时计时器在拿到响应头后即 `clearTimeout`，`readSSE` 的 `await reader.read()` 无任何超时；半开连接会让 Agent Loop 永久挂起。 | `src/provider/anthropic.ts` `readSSE` 360-397；`send` 337-356 finally 清 timer | provider.md |
| P2 | **网络层错误不重试**：`chat()` 仅对 `!res.ok` 的 HTTP 状态重试；`send()` 抛出的网络错误（ECONNREFUSED/ETIMEDOUT/ENOTFOUND/`fetch failed`）直接逃出重试循环。 | `src/provider/anthropic.ts` 299-324（`send()` 在 try 外） | provider.md |
| P3 | **`/clear` 不重置会话级 allowlist**：`Permission` 是 App 生命周期内稳定的 `useMemo` 实例，`session.clear()` 不重置 allowlist；上一会话"始终允许"的工具在 `/clear` 后新会话仍直过，违背"会话级 allowlist"。 | `src/tui/App.tsx` 147 `useMemo`、209 `session.clear()`；`src/permission/index.ts` 37 实例级 Set，无 reset | permissions.md |

### Tier 2 — 头号加分项：优异的上下文压缩（L2 第五节点名的扩展方向）

当前仅 `HeuristicSummarizer`（固定模板，丢失代码变更/错误/决策）+ 消息数阈值（硬编码 40/16）。要拿到"优异"加分：

| 编号 | 增强 | 归属 spec |
|---|---|---|
| M1 | **可注入 LLM 摘要器** `LLMSummarizer`：用现有 Provider 调用轻量模型生成层次化摘要（用户目标/已完成/阻碍/关键变更/错误）；超时+失败时**优雅降级**回 `HeuristicSummarizer`，绝不阻断主循环。 | memory.md |
| M2 | **Token 预算驱动压缩**：引入 `estimateTokens(msg)` 与 `thresholdTokens`/`keepRecentTokens`，按 token 触发与保留近窗；消息数阈值作为向后兼容降级。 | memory.md |
| M3 | **记忆配置化**：`config.json` 新增 `memory:{ enabled?, thresholdMsgs?, keepRecent?, thresholdTokens?, keepRecentTokens?, summarizer? }`（项目级覆盖用户级，沿用既有深合并）+ 环境变量 `AI_CODE_MEMORY_*` 覆盖。`/memory` 展示生效配置。 | config.md / memory.md |
| M4 | **摘要更优 + 防无限堆叠 + resume 桥接**：HeuristicSummarizer 保留错误片段/关键工具结果/最后 2 条 assistant 推理；二次压缩**融合**旧摘要而非叠加（摘要数 ≤ 2 不变量）；`/resume` 含摘要时给出"查看 /diff、清晰描述续作"的桥接提示。 | memory.md |

## 里程碑

- [x] **D（docs-first）**：本计划评审通过；更新 provider.md（P1/P2 超时与错误分类）、permissions.md（P3 allowlist 生命周期）、memory.md（M1-M4 契约）、config.md（M3 记忆配置）。
- [x] **P1** provider 流读取超时（idle/read timeout 关联外部 signal）+ 单测（极慢 stream 触发 abort；外部 signal abort 终止读取）。
- [x] **P2** provider 网络错误重试（包裹 send，按 code/cause 判定可重试）+ 单测（ECONNREFUSED 首次失败、二次成功；超 maxRetries 抛错；用户 abort 不重试）。
- [x] **P3** permission `reset()` + `/clear` 调用 + 更新 spec + 单测（/clear 后同工具重新提确认）。
- [x] **M1** `src/session/llm-summarizer.ts`（`LLMSummarizer` + `FallbackSummarizer` + `createSummarizer` 工厂）+ Summarizer 注入链 + 失败降级 + 单测（mock provider 摘要 / 超时·失败·空结果降级）。
- [x] **M2** `estimateTokens` + token 预算 compaction（向后兼容消息数）+ 单测（多消息少 token 不压、少消息多 token 压、未配置回落消息数）。
- [x] **M3** config schema（`memory` 子对象深合并 + `.max()`/枚举校验）+ loadConfig `AI_CODE_MEMORY_*` 覆盖 + cli/App 注入 + `/memory` 展示生效配置（`formatMemoryStatus`）+ 单测（配置优先级 / env 覆盖 / 非法值）。
- [x] **M4** 摘要增强（错误片段/关键工具结果/末 2 条 assistant 推理）+ 融合不变量（摘要数 ≤ 2）+ resume 桥接提示（`RESUME_SUMMARY_BRIDGE`）+ 单测（多轮压缩摘要数 ≤ 2、增强摘要含错误）。
- [x] **回归**：`npm run build` exit 0；`npm test` 全绿 = **243/243**（基线 213 + 新增 30）。

## 不做（本轮，留待后续 Round）
- App.tsx CommandExecutor 抽取（Q1，重写 App.tsx，单列一轮避免与本轮 App 改动冲突）。
- delete_file/move_file（Round-2 评估）。
- 投机性 future-proofing（version 字段/快照迁移/baseURL 脱敏）——与 less is more 冲突，不做。
