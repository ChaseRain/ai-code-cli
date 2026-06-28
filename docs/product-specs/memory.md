# Spec: 记忆增强（Memory）

> 状态：**partial（resume + 命令 + Session 级压缩已实现并测试；自动接入实时 loop 未做）** · 最后更新：2026-06-28
> 模块：`src/session/`（resumeFrom / findLatestLog / maybeCompact / Summarizer）、`src/tui/`（`/resume` `/memory`）
> 评审定位：**扩展/加分项**（L2 第五节「上下文压缩等」）。不替代、不弱化基础会话能力（见 [`session-context.md`](session-context.md)）。

## 实现状态（如实，不夸大）

| 能力 | 状态 | 证据 |
|---|---|---|
| 会话恢复 resume（jsonl→Message[]，含 summary 状态恢复） | ✅ 已实现 + 测试 | `Session.resumeFrom` / `findLatestLog`；tests/memory.test.ts（A5、A8） |
| `/resume` `/memory` 命令 | ✅ 已实现 + 测试 | command.ts；tests/tui-command.test.ts（A6） |
| 上下文压缩 maybeCompact（Mock summarizer） | ✅ Session 级已实现 + 测试 | tests/memory.test.ts（A1–A4、A7） |
| 压缩**自动接入实时 Agent Loop** | ⛔ 未实现（future） | —（避免引入真实摘要模型依赖与 loop 行为变更，留作后续） |

## 目标
在不破坏现有会话语义的前提下，给 Agent 加「记忆」：
1. **会话恢复（Resume）**：从 `.ai_history/logs/*.jsonl` 恢复最近一次（或指定）会话上下文。
2. **上下文压缩（Compaction / Summary）**：历史超阈值时，把较旧轮次摘要为一条 summary 消息，保留近窗 + 关键事实，控制 token 膨胀。
3. **内置命令**：`/resume`（恢复最近会话）、`/memory`（**仅查看**记忆状态：消息数 / system 数 / 是否含摘要 hasSummary / 当前日志；不触发压缩）。

## 设计契约（接口草案，最小集）

```ts
// 摘要器：可注入，测试用 Mock，真实模型可选
interface Summarizer {
  summarize(olderMessages: Message[], signal: AbortSignal): Promise<string>;
}

// Session 增强（在现有 Session 上扩展，不改既有 append/clear/messages 语义）
interface MemoryCapableSession {
  resumeFrom(logPath: string): void;          // 从 jsonl 重建消息历史
  latestLogPath(): string | null;             // 最近一次会话日志
  maybeCompact(opts: {                         // 超阈值时压缩；否则 no-op
    thresholdMsgs: number;                     // 触发压缩的消息数阈值
    keepRecent: number;                        // 保留的近窗消息数
    summarizer: Summarizer;
  }): Promise<{ compacted: boolean; summary?: string }>;
}
```

### 压缩规则（不变量，必须满足）
1. **不破坏 tool 配对**：summary 的切割点不得落在 `assistant(tool_calls)` 与其对应 `tool` 结果之间——
   每个 `tool_call` 的 `tool_result` 必须与其 assistant 调用同处压缩边界的同一侧。
2. **system 永不被压缩**：系统提示始终保留在历史首部。
3. **summary 以一条独立消息注入**：插在被压缩区段位置，标记可识别（如 `role:'system'` 或带 `kind:'summary'`），后续轮次照常追加。
4. **近窗保真**：最近 `keepRecent` 条消息原样保留，不进 summary。
5. **可观测**：压缩动作落 `.ai_history/logs`（`kind:'summary'`），可复盘。

### Resume 规则
0. 遇到 `summary` 记录：用 `payload.replaced` 把「前导 system 之后的旧消息段」替换为
   `SUMMARY_PREFIX + payload.summary` 的 system 消息，使 resume 能还原压缩后的状态（不丢摘要）。
1. 从 jsonl 逐条重建为 `Message[]`，保持原始顺序与 tool 配对。
2. 恢复后可继续对话；新消息写入**新日志文件**（不污染旧日志），或在原日志续写——二选一，实现时定并记录决策。
3. 找不到日志 → 友好提示，不崩溃。

## 验收项（Round-2 实现时必须满足）

| # | 验收 | 测试方式 |
|---|---|---|
| A1 | 压缩后 tool_call ↔ tool_result 配对不被破坏 | 单测：构造跨边界的工具轮次，断言压缩后每个 tool_result 仍紧随其 assistant 调用 |
| A2 | system 消息始终保留在首部 | 单测 |
| A3 | summary 作为独立消息注入，近 `keepRecent` 条原样保留 | 单测 |
| A4 | 用 Mock Summarizer 即可验证全流程，不依赖真实网络 | 单测（沿用 MockProvider 思路） |
| A5 | resume 从 jsonl 重建历史，顺序与配对正确 | 单测：写一段含工具轮次的 jsonl → resume → 断言 messages 等价 |
| A6 | `/resume` `/memory` 命令解析正确 | 命令解析单测（沿用 tui-command 测试） |
| A7 | 阈值未到时 `maybeCompact` 为 no-op | 单测 |
| A8 | append→maybeCompact→新 Session `resumeFrom` 后，messages 与压缩后 history 等价、hasSummary=true | 单测 |

## 不做（即便 Round-2）
- 跨项目/全局长期记忆库、向量检索 RAG。
- 多会话并行管理 UI。
- 真实模型摘要作为**默认**（默认 Mock/可选真实，避免测试依赖网络）。

## 关联
- 基础会话 → [`session-context.md`](session-context.md)
- 技术债 → [`../exec-plans/tech-debt-tracker.md`](../exec-plans/tech-debt-tracker.md)（T1 压缩 / T3 resume）
- 计划 → [`../exec-plans/active/phase-1.md`](../exec-plans/active/phase-1.md) Round-2
