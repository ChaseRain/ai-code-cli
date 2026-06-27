# Spec: 会话上下文 + 持久化

> 状态：draft · 最后更新：2026-06-27 · 模块：`src/session/`

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
- 每个会话一个 `.ai_history/logs/<timestamp>-<id>.jsonl`，逐条 append。
- 内容覆盖：user / assistant / tool_call / tool_result / permission / error。
- 用途：复盘 + 作为「AI 协作过程记录」交付物。

## 上下文管理（首期）
全量历史 + 系统提示，不压缩。压缩属扩展项（见 tech-debt-tracker）。

## 验收（测试）
- 各类消息正确入历史且顺序正确。
- `/clear` 清空内存上下文并开新日志文件。
- jsonl 落盘内容可被重新读取解析。

## 不做（首期）
跨会话 resume、多会话切换、按 token 预算裁剪。
