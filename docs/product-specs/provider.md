# Spec: LLM Provider

> 状态：draft · 最后更新：2026-06-27 · 模块：`src/provider/`
> 外部 API 事实来源：[`docs/references/coding-plan-platform.md`](../references/coding-plan-platform.md)
> ⚠️ **协议=Anthropic Messages**（经实测，平台 OpenAI `/v1/chat/completions` 会**静默丢弃工具调用**；
> Anthropic 端点原生支持 `tool_use` + 流式。见决策日志 D2 修订）。

## 职责
把 LLM 协议封装成统一**协议无关**的流式接口；首期实现 Anthropic + Mock。接口抽象不变，方便日后扩别的协议。

## 接口（协议无关，保持不变）
```ts
interface ChatRequest { model: string; messages: Message[]; tools: ToolSchema[]; signal: AbortSignal; }
type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; argsDelta: string }
  | { type: 'tool_call_done'; id: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls' | 'length' };
interface Provider { chat(req: ChatRequest): AsyncIterable<ProviderEvent>; }
```

## AnthropicProvider 行为
- `POST {baseURL}/v1/messages`，`baseURL = https://ai-kas.kso.net/codeplan/anthropic`。
- Headers：`Authorization: Bearer <ANTHROPIC_AUTH_TOKEN>`、`anthropic-version: 2023-06-01`、`Content-Type: application/json`。
- 请求体（Anthropic Messages 格式）：
  - `model`、`max_tokens`、`messages`、`tools`（`{name, description, input_schema}`）、`stream:true`。
  - `system` 作为顶层字段（不是 message role）。
  - **工具结果**回传：以 `role:"user"` 的 `content:[{type:"tool_result", tool_use_id, content}]`；
    工具调用在 `role:"assistant"` 的 `content:[{type:"tool_use", id, name, input}]`。
- **SSE 事件 → ProviderEvent 映射**（实测）：
  | Anthropic SSE | 处理 |
  |---|---|
  | `message_start` | 开始 |
  | `content_block_start`(text) | 文本块开始 |
  | `content_block_start`(tool_use) | `tool_call`{id,name}（input 待拼） |
  | `content_block_delta`(text_delta) | `text`{delta} |
  | `content_block_delta`(input_json_delta) | `tool_call`{argsDelta}（累积 partial_json） |
  | `content_block_stop` | `tool_call_done` |
  | `message_delta`(stop_reason) | 记录 finishReason（`tool_use`→`tool_calls`，`end_turn`→`stop`） |
  | `message_stop` | `done` |
- **超时**：单请求 `timeoutMs`（默认 60s）→ abort。
- **重试**：网络错误 / 5xx / 429 指数退避，最多 `maxRetries`（默认 2）；鉴权类 4xx 不重试。
- 内部把统一 `Message[]` 转成 Anthropic 形态（system 提取、tool_result 包装），对 Loop 透明。

## MockProvider 行为
按脚本返回预设 `ProviderEvent` 序列（含 tool_call 场景），不依赖网络——是所有测试的驱动核心。

## 验收（测试）
- SSE 分片拼接出完整工具参数（`input_json_delta.partial_json` 跨多个 chunk）。
- 统一 Message[] ↔ Anthropic 体的转换正确（system 提取、tool_use/tool_result 配对）。
- 超时触发 abort；5xx/429 触发退避重试；4xx 不重试。
- MockProvider 能脚本化驱动主循环全链路。

## 不做（首期）
OpenAI Chat Completions（该网关不支持工具）、OpenAI Responses（需 cc-switch 本地路由）。登记在 tech-debt-tracker。
