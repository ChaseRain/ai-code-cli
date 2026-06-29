# Product Spec — Session Browser

> 状态：implemented（M7 已实现并测试；Phase-6 容量硬化中） · 最后更新：2026-06-28
> 模块：`src/session/browser.ts`、`src/tui/command.ts`、`src/tui/App.tsx`。
> **Phase-6 硬化**（见 [`load-hardening.md`](load-hardening.md)）：`listSessions(root, cur, {limit})` 先按文件名时间序选候选再读取，`/sessions` 默认 50（LH3）；`summarizeLog` 先 stat、超 2MiB 不全量读（warning）、`/resume` 超 8MiB 明确报错、`resolveSessionLog` 走文件名快速路径不全量 summarize（LH7）。

## 职责

Session Browser 从 `.ai_history/logs/*.jsonl` 读取历史会话摘要，让用户在 TUI 中查看本地会话并选择恢复。它复用 Round-2 已实现的 `Session.resumeFrom(logPath)`，不改变基础会话持久化格式。

## DDD 边界

| 层 | 边界 | 说明 |
|---|---|---|
| use-case | 列出会话、恢复指定会话、恢复 latest | 面向 TUI 命令 |
| domain | `SessionSummary`、`SessionIndex`、`SessionSelector` | 只处理日志摘要与选择 |
| system | `src/session/` | jsonl 解析、排序、过滤 system prompt |
| code | `src/tui/command.ts`、`src/tui/App.tsx`、`src/cli.tsx` | 命令与展示；`src/cli.tsx` 仍只做依赖装配 |

## 命令接口

| 命令 | 行为 | 输出字段 |
|---|---|---|
| `/sessions` | 列出本地会话摘要，默认按最近更新时间倒序 | id、startedAt、updatedAt、title、messages、toolCalls、logPath、current |
| `/resume latest` | 恢复最新非当前日志 | restoredLog、messagesRestored、systemCountHidden |
| `/resume <id>` | 恢复指定会话 | restoredLog、messagesRestored、systemCountHidden |

`/resume` 无参数继续保持 Round-2 行为：恢复最近一次可用会话。

## 数据结构

```ts
interface SessionSummary {
  id: string;
  logPath: string;
  startedAt: string;
  updatedAt: string;
  title: string;
  messages: number;
  toolCalls: number;
  current: boolean;
}
```

`title` 来自第一条 user 消息的前若干字符；若无 user 消息则使用文件名时间戳。system prompt 只计数，不展示内容。

## 行为流程

1. `/sessions` 扫描 `.ai_history/logs/*.jsonl`。
2. 对每个 jsonl 做容错解析：坏行跳过并计入 warning，不阻断列表。
3. 生成摘要：时间、首条用户意图、消息数、tool_call 次数、当前日志标记。
4. `/resume <id|latest>` 解析目标日志，调用 `Session.resumeFrom(logPath)`。
5. 恢复后 TUI 输出短摘要，不 dump system prompt，不展开工具原始结果。

## 验收测试

| # | 用例 | 断言 |
|---|---|---|
| S1 | `/sessions` 解析多个 jsonl | 返回按 updatedAt 倒序的 `SessionSummary[]` |
| S2 | 首条用户意图 | title 来自第一条 user，长度受限 |
| S3 | system prompt 隐藏 | 输出不含 system prompt 文本 |
| S4 | `/resume latest` | 定位最新非当前日志并恢复 |
| S5 | `/resume <id>` | 指定 id 可恢复，未知 id 报错 |
| S6 | 坏 jsonl 行 | 不崩溃，产生 warning |

当前覆盖：`tests/session-browser.test.ts`（摘要 / latest / id / 坏行）、`tests/tui-command.test.ts`（`/sessions`、`/resume latest`）。

## 非目标

- 不做多会话并发运行。
- 不做跨设备同步。
- 不做会话全文搜索。
- 不改变 `.ai_history/logs/*.jsonl` 现有写入格式。

## 下一步代码阶段建议

- 在 `src/session/` 新增 `session-browser.ts` 或等价读侧模块。
- 扩展 `src/tui/command.ts` 支持 `/sessions` 与 `/resume <id|latest>`。
- 扩展 `src/tui/App.tsx` 展示会话列表和恢复结果。
- 新增 `tests/session-browser.test.ts`，扩展 `tests/tui-command.test.ts`。
