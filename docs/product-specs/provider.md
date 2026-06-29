# Spec: LLM Provider

> 状态：implemented（Phase-9 补：流读取超时 + 网络错误分类重试 契约） · 最后更新：2026-06-29 · 模块：`src/provider/`（tests/provider.test.ts 覆盖）
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
  - **`model` 来自每次 `ChatRequest.model`，Provider 不缓存**：模型由 Loop 经 RunOpts 注入、源头是 App 的 `model` state（`config.model` 初值，`/model <id>` 运行时改）。故切模型无需重建 Provider、无需重启——下一次 `chat()` 即用新 model。可切换的模型组见 `AVAILABLE_MODELS`（config.md）。
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
- **超时**：
  - **首字节超时**：单请求 `timeoutMs`（默认 60s）覆盖「发起请求 → 拿到响应头」阶段，超时 → abort。
  - **流读取超时（read/idle timeout，Phase-9 P1）**：响应头到手后不得清掉超时保护。`readSSE` 的**每一次** `reader.read()` 必须在 `timeoutMs` 内完成；任一次读取在窗口内无任何字节到达，视为半开连接，须 **abort reader 并抛超时错误**，而非永久挂起。该超时与外部 `signal` 关联（外部 abort 或内部 idle 超时任一触发都终止读取，并清理计时器），保证 Agent Loop 不会因半开连接永久阻塞。计时器在每次成功读取后重置（idle 语义：计的是「相邻两次字节到达的间隔」，不是整条流的总时长）。
- **重试**：网络错误 / 5xx / 429 指数退避（+ 抖动 jitter），最多 `maxRetries`（默认 2）。退避策略、抖动、上限不变；新增**错误分类**作为重试判据：
  - **可重试**：
    - HTTP `429` 与 `5xx`；
    - 网络层错误：`ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / `EAI_AGAIN` / 文案为 `"fetch failed"` 的错误；
    - **非用户触发的 `AbortError`**（即由上述流读取 idle 超时内部触发的 abort，等价于一次超时，应重试）。
  - **不可重试**：其他 `4xx`（鉴权 `401/403`、请求格式 `400/422` 等）——立即抛出，不浪费退避预算。
  - 判定依据错误的 `code` / `cause` / 文案，而非字符串硬匹配单点；`send()` 抛出的网络错误必须被包进重试循环（不得在 try 外逃逸）。
- 内部把统一 `Message[]` 转成 Anthropic 形态（system 提取、tool_result 包装），对 Loop 透明。

## MockProvider 行为
按脚本返回预设 `ProviderEvent` 序列（含 tool_call 场景），不依赖网络——是所有测试的驱动核心。

## 验收（测试）
- SSE 分片拼接出完整工具参数（`input_json_delta.partial_json` 跨多个 chunk）。
- 统一 Message[] ↔ Anthropic 体的转换正确（system 提取、tool_use/tool_result 配对）。
- 首字节超时触发 abort；5xx/429 触发退避重试；鉴权类 4xx 不重试。
- **流读取超时（Phase-9 P1）**：构造极慢/半开 stream（响应头已到、后续无字节），断言 `reader.read()` 在 `timeoutMs` 内被 abort 并抛超时错误，Loop 不挂起；外部 signal abort 同样能终止读取。
- **网络错误重试（Phase-9 P2）**：mock `send()` 首次抛 `ECONNREFUSED`（或内部 idle 超时 AbortError）、二次成功，断言整体重试后成功；mock 抛 `401`，断言不重试、立即抛出。
- MockProvider 能脚本化驱动主循环全链路。

## 不做（首期）
OpenAI Chat Completions（该网关不支持工具）、OpenAI Responses（需 cc-switch 本地路由）。登记在 tech-debt-tracker。
