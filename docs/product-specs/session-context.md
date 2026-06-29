# Spec: 会话上下文 + 持久化

> 状态：implemented · 最后更新：2026-06-28 · 模块：`src/session/`（tests/session.test.ts 覆盖）。记忆增强契约见 [`memory.md`](memory.md)

## 职责
维护多轮消息历史；把关键对话内容沉淀到磁盘。

## 消息模型
```ts
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; ok: boolean };
interface ToolCall { id: string; name: string; args: unknown; }
```
**全要素入历史**：用户输入、模型回复、工具调用、工具结果、权限拒绝、错误，统一归一为上述消息。

## 持久化
- 每个会话一个 `.ai_history/logs/<timestamp>-<id>[-<seq>].jsonl`，逐条 append。
- 内容覆盖：user / assistant / tool_call / tool_result / permission / error。
- 用途：复盘 + 作为「AI 协作过程记录」交付物。

## 日志路径唯一性（不变量，历史回归硬化）
- **每次生成日志路径必须唯一**：`Session.clear()`（对应 `/clear`）每次都开一个**新的、唯一**的日志文件路径，
  **即使同一 session id 在同一毫秒内连续 clear**（时间戳分辨率不足以区分时，用进程内单调序号兜底）。
- **旧日志必须保留**：clear 不删除旧日志，旧文件原样留在磁盘作为交付记录。
- **不破坏读取/恢复**：文件名保持「时间戳在前」可排序（`findLatestLog` 仍按文件名时间序），历史日志无需迁移。

## 上下文管理（首期）
全量历史 + 系统提示。基础会话不压缩；**记忆增强（resume / 压缩 / summary）见 [`memory.md`](memory.md)**（Round-2，已部分实现）。

## 会话恢复（resume，R2 已实现）
- `Session.resumeFrom(logPath)`：读取 jsonl，重建内存 `Message[]`——`tool_call` 记录挂回前一条 assistant 的 `toolCalls`，`tool_result` 还原为 tool 消息，`permission`/`error` 跳过（不进喂模型上下文）。保持顺序与 tool 配对。
  - `summary` 记录：用 `payload.replaced` 把前导 system 后的旧消息段替换为 `SUMMARY_PREFIX + summary` 的 system 消息，**恢复压缩后的状态、不丢摘要**。
- `Session.findLatestLog(rootDir, exclude?)`：返回最近一次会话日志路径（按文件名时间戳），供 `/resume latest` 解析目标。
- 恢复后新消息写入**当前（新）日志文件**，不污染被恢复的旧日志。

## 验收（测试）
- 各类消息正确入历史且顺序正确。
- `/clear` 清空内存上下文并开新日志文件。
- jsonl 落盘内容可被重新读取解析。
- **日志唯一性（回归硬化）**：固定 `Date` 到同一毫秒，连续 `clear()` 两次，初始 + 两次 clear 共 3 个 logPath 全不同；旧日志不丢。

## 不做（首期）
跨会话 resume、多会话切换、按 token 预算裁剪。
