# Spec: 记忆增强（Memory）

> 状态：**implemented（resume + Session 压缩 + 实时 Loop 自动压缩已实现并测试）；Phase-9 升级契约：LLM 摘要可选链 / Token 预算压缩 / 摘要增强防堆叠 / 配置化（M1-M4，docs-first 现行契约，实现进行中）** · 最后更新：2026-06-29
> 模块：`src/session/`（resumeFrom / findLatestLog / maybeCompact / Summarizer / 新增 estimateTokens、`llm-summarizer.ts`）、`src/agent/loop.ts`（自动压缩触发）、`src/tui/`（`/resume` `/memory` + 压缩事件展示）
> 评审定位：**扩展/加分项 → 头号加分（优异上下文压缩）**（L2 第五节「上下文压缩等」）。不替代、不弱化基础会话能力（见 [`session-context.md`](session-context.md)）。

## 实现状态（如实，不夸大）

| 能力 | 状态 | 证据 |
|---|---|---|
| 会话恢复 resume（jsonl→Message[]，含 summary 状态恢复） | ✅ 已实现 + 测试 | `Session.resumeFrom` / `findLatestLog`；tests/memory.test.ts（A5、A8） |
| `/resume` `/memory` 命令 | ✅ 已实现 + 测试 | command.ts；tests/tui-command.test.ts（A6） |
| 上下文压缩 maybeCompact（Mock summarizer） | ✅ Session 级已实现 + 测试 | tests/memory.test.ts（A1–A4、A7） |
| 压缩**自动接入实时 Agent Loop** | ✅ 已实现 + 测试 | 默认本地 `HeuristicSummarizer`；Agent Loop 每轮请求模型前检查阈值；tests/agent-loop.test.ts（M9） |

## 目标
在不破坏现有会话语义的前提下，给 Agent 加「记忆」：
1. **会话恢复（Resume）**：从 `.ai_history/logs/*.jsonl` 恢复最近一次（或指定）会话上下文。
2. **上下文压缩（Compaction / Summary）**：历史超阈值时，把较旧轮次摘要为一条 summary 消息，保留近窗 + 关键事实，控制 token 膨胀。
3. **实时自动压缩**：Agent Loop 在每轮发起 `provider.chat` 前执行阈值检查，超限则压缩旧上下文，并发出 UI 事件。
4. **内置命令**：`/resume`（无参打开会话选择器恢复；`/resume latest` 直接恢复最近会话，见 session-browser.md）、`/memory`（**仅查看**记忆状态：消息数 / system 数 / 是否含摘要 hasSummary / 当前日志；不触发压缩）。

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

Agent Loop 接入：

```ts
interface MemoryCompactionOptions {
  thresholdMsgs: number;
  keepRecent: number;
  summarizer: Summarizer;
}
```

默认摘要器为本地确定性实现，只做结构化摘要，不访问网络；真实模型摘要可作为未来可选扩展。

### 压缩规则（不变量，必须满足）
1. **不破坏 tool 配对**：summary 的切割点不得落在 `assistant(tool_calls)` 与其对应 `tool` 结果之间——
   每个 `tool_call` 的 `tool_result` 必须与其 assistant 调用同处压缩边界的同一侧。
2. **system 永不被压缩**：系统提示始终保留在历史首部。
3. **summary 以一条独立消息注入**：插在被压缩区段位置，标记可识别（如 `role:'system'` 或带 `kind:'summary'`），后续轮次照常追加。
4. **近窗保真**：最近 `keepRecent` 条消息原样保留，不进 summary。
5. **可观测**：压缩动作落 `.ai_history/logs`（`kind:'summary'`），可复盘。
6. **错误不阻断**：摘要失败只记录 `error` 并向 UI 发提示，不阻断本轮模型请求。

### Resume 规则
0. 遇到 `summary` 记录：用 `payload.replaced` 把「前导 system 之后的旧消息段」替换为
   `SUMMARY_PREFIX + payload.summary` 的 system 消息，使 resume 能还原压缩后的状态（不丢摘要）。
1. 从 jsonl 逐条重建为 `Message[]`，保持原始顺序与 tool 配对。
2. 恢复后可继续对话；新消息写入**新日志文件**（不污染旧日志），或在原日志续写——二选一，实现时定并记录决策。
3. 找不到日志 → 友好提示，不崩溃。

---

## Phase-9 升级契约：优异上下文压缩（M1-M4）

> 以下为 Phase-9（[`../exec-plans/active/phase-9.md`](../exec-plans/active/phase-9.md) Tier 2）现行契约。所有增强均在**不破坏既有不变量**（系统保留 / tool 配对 / 近窗保真 / 错误不阻断）前提下进行。

### M1 · LLM 摘要可选链（Summarizer 注入 + 优雅降级）
- `Summarizer` 接口不变；新增可注入实现 `LLMSummarizer`（`src/session/llm-summarizer.ts`），用现有 **Provider 调一个轻量模型**生成**层次化摘要**（用户目标 / 已完成 / 阻碍 / 关键变更 / 错误）。
- **优雅降级（硬约束）**：`LLMSummarizer` 受独立超时约束；**超时或失败时降级回 `HeuristicSummarizer`**（本地确定性摘要），**绝不阻断主循环**。降级是「拿到一条可用摘要」，不是「放弃压缩」。
- 默认仍为本地 `HeuristicSummarizer`（不依赖网络，保证测试可离线驱动）；`LLMSummarizer` 由 config 显式开启（见 M5/config.md）。
- 与既有「错误不阻断」不变量一致：LLM 调用异常只记录、降级，不向上抛断主循环。

### M2 · Token 预算驱动压缩
- 新增 `estimateTokens(msg)` 估算单条 / 一组消息的 token 量（确定性近似，无需真实 tokenizer）。
- 新增触发与保留参数：`thresholdTokens`（累计 token 超过即触发压缩）、`keepRecentTokens`（按 token 预算保留近窗，而非固定条数）。
- **向后兼容**：消息数阈值（`thresholdMsgs` / `keepRecent`）作为**降级判据**保留——未配置 token 预算或估算不可用时回落到消息数阈值；两套判据可叠加（任一触发即压缩）。
- 既有不变量全部保留：system 永不压缩、tool_call↔tool_result 不跨边界切割、近窗保真（无论按条数还是按 token 保留）。

### M3 · 摘要增强与防堆叠
- **HeuristicSummarizer 增强**：摘要须保留——**错误片段**（失败的工具结果 / 报错文案）、**关键工具结果**（如写文件 / 命令产出的要点）、**最后 2 条 assistant 推理**，避免压缩丢失代码变更 / 决策 / 错误这类高价值信息。
- **二次压缩融合（防无限堆叠）**：再次压缩时，**把旧摘要融合进新摘要**（重写为一条），而非在历史里叠加多条摘要消息。
- **不变量**：历史中**摘要 system 消息数 ≤ 2**（融合后通常收敛为 1；过渡态最多 2）。该不变量随多轮压缩保持，不得随轮次线性增长。

### M4 · 与 `/clear`、`/resume` 的关系
- **`/clear`**：开启新会话，**重置压缩计数 / 状态**（与权限 allowlist 重置同属「新会话从零」语义，见 [`permissions.md`](permissions.md)）。
- **`/resume`**：恢复的历史**含摘要**时，给出**桥接提示**（引导用户「查看 `/diff`、清晰描述续作目标」），帮助模型在摘要语境下顺畅续作。

### M5 · 配置化（详见 [`config.md`](config.md) 记忆配置）
- 以下参数由 `config.memory` 读取，并提供默认值：
  - `enabled`：是否启用自动压缩（默认 true）。
  - `thresholdMsgs` / `keepRecent`：消息数阈值与近窗条数（向后兼容默认值不变）。
  - `thresholdTokens` / `keepRecentTokens`：token 预算阈值与近窗预算（默认值见 config.md）。
  - `summarizer`：`'heuristic'`（默认）| `'llm'`（启用 `LLMSummarizer`，失败降级 heuristic）。
- 配置遵循「项目级覆盖用户级」深合并 + 环境变量 `AI_CODE_MEMORY_*` 覆盖；`/memory` 展示**生效配置**。

## 验收项

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
| A9 | Agent Loop 自动压缩：历史超过阈值时，请求 Provider 前完成压缩，Provider 收到压缩后的 messages | agent-loop 单测 |
| A10 | 压缩失败不中断：Summarizer 抛错时，记录 error，Provider 仍被调用，任务可完成 | agent-loop 单测 |
| A11 | TUI 可观测：压缩成功事件渲染为 system 消息，`/memory` 可看到 hasSummary=true | tui-render + memory 单测 |
| A12（M1） | `LLMSummarizer` 用 mock Provider 产出层次化摘要；超时/失败时**降级回 HeuristicSummarizer**，主循环不被阻断 | 单测（mock provider 摘要 / mock 超时触发降级） |
| A13（M2） | Token 预算压缩：多消息但 token 少→不压；少消息但 token 多→压；估算不可用时回落消息数阈值 | 单测（estimateTokens + 两种触发路径） |
| A14（M3） | 摘要保留错误片段 / 关键工具结果 / 最后 2 条 assistant 推理；多轮压缩后**摘要 system 消息数 ≤ 2**（融合不叠加） | 单测（多轮 compact 断言摘要数 ≤ 2 且含关键片段） |
| A15（M4） | `/clear` 重置压缩计数；`/resume` 含摘要时输出桥接提示 | tui-command / memory 单测 |
| A16（M5） | `config.memory` 字段读取与默认值；项目级覆盖用户级 + `AI_CODE_MEMORY_*` 覆盖；`/memory` 展示生效配置 | config + memory 单测（见 config.md） |

## 不做
- 跨项目/全局长期记忆库、向量检索 RAG。
- 多会话并行管理 UI。
- 真实模型摘要作为**默认**（默认本地确定性摘要，避免测试依赖网络）。
- 长期向量记忆、跨仓库个人知识库。

## 验收记录

2026-06-28：`npm run build && npm test` = **116/116** 通过；新增覆盖：
- `tests/memory.test.ts`：默认本地摘要器输出旧消息数量、用户意图和工具信息。
- `tests/agent-loop.test.ts`：Loop 请求 Provider 前自动压缩；摘要失败不阻断任务。
- `tests/tui-render.test.ts`：压缩事件可作为 system 消息渲染。

## 关联
- 基础会话 → [`session-context.md`](session-context.md)
- 技术债 → [`../exec-plans/tech-debt-tracker.md`](../exec-plans/tech-debt-tracker.md)（T1 压缩 / T3 resume）
- 计划 → [`../exec-plans/active/phase-1.md`](../exec-plans/active/phase-1.md) Round-2
