// src/core/types.ts
// 全部共享契约 —— 本文件是地基层的「唯一真相来源」，其余模块只依赖这里。
// 与 docs/design-docs/domain-model.md、docs/product-specs/{session-context,tools,provider,config}.md 保持一致。

// ============================================================================
// JSON Schema —— 暴露给模型的工具参数描述（最小够用子集）
// ============================================================================

/**
 * 工具参数用的极简 JSON Schema。
 * 首期只需 object 顶层 + 常见基础类型；保持宽松（[k:string]:unknown）以容纳 enum/items 等扩展字段。
 */
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  /** type=object 时的属性表 */
  properties?: Record<string, JSONSchema>;
  /** type=object 时的必填字段 */
  required?: string[];
  /** type=array 时的元素 schema */
  items?: JSONSchema;
  /** 枚举可选值 */
  enum?: unknown[];
  /** 允许携带其它 JSON Schema 关键字（如 default、minimum 等），不强约束 */
  [k: string]: unknown;
}

/**
 * 序列化给 Provider 的工具 schema（Anthropic：{name, description, input_schema}）。
 * 由 ToolRegistry 从 Tool 派生，Provider 不认识 Tool 本身。
 */
export interface ToolSchema {
  name: string;
  description: string;
  /** 对应 Anthropic 的 input_schema */
  parameters: JSONSchema;
}

// ============================================================================
// 会话消息模型 —— 见 product-specs/session-context.md
// 全要素入历史：user / assistant / tool_call / tool_result / 权限拒绝 / 错误
// 统一归一为下述四种 role。
// ============================================================================

/** 模型发起的一次工具调用（值随历史持久化）。 */
export interface ToolCall {
  id: string;
  name: string;
  /** 解析后的参数；执行前由工具自行用 zod/JSONSchema 校验 */
  args: unknown;
}

/**
 * 会话历史的最小单元。判别联合，按 role 区分形态：
 * - system：顶层系统提示（Provider 转换时提取为顶层 system 字段）
 * - user：用户输入，或工具结果回传的载体（由 Provider 包装为 tool_result）
 * - assistant：模型回复，可能携带 toolCalls
 * - tool：工具执行结果（含成功/失败标志，错误同样入上下文）
 */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; ok: boolean };

// ============================================================================
// 工具系统 —— 见 product-specs/tools.md
// ============================================================================

/**
 * 工具执行结果（值对象）。判别联合：
 * - 成功：{ ok:true, content }
 * - 失败：{ ok:false, error } —— 错误即数据，回喂模型而非抛异常
 */
export type ToolResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/**
 * 工具执行的运行时上下文。
 * - rootDir：项目根，一切文件/Shell 作用对象必须落在其内（路径沙箱）
 * - signal：用于超时/用户中断的取消信号
 */
export interface ToolContext {
  rootDir: string;
  signal: AbortSignal;
}

/**
 * 原子工具接口。统一输入(parameters)/输出(ToolResult)/错误结构。
 * - readOnly=true：只读工具，自动执行，无需权限确认
 * - readOnly=false：敏感工具（写/编辑/Shell），执行前必须经授权
 * 工具之间互不依赖，也不认识 Provider。
 */
export interface Tool {
  name: string;
  description: string;
  /** 暴露给模型的参数 schema */
  parameters: JSONSchema;
  /** true=自动执行；false=敏感，需权限 */
  readOnly: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ============================================================================
// 配置 —— 见 product-specs/config.md
// apiKey 不在此结构中：优先环境变量 ANTHROPIC_AUTH_TOKEN。
// ============================================================================

export interface Config {
  /** 首期固定 'anthropic'（平台工具调用走 Anthropic 协议） */
  provider: 'anthropic';
  model: string;
  baseURL: string;
  /** 单请求超时（毫秒），默认 60000 */
  timeoutMs: number;
  /** Agent Loop 最大轮次，默认 25 */
  maxTurns: number;
  /** Provider 请求最大重试次数，默认 2 */
  maxRetries: number;
  /** 记忆 / 上下文压缩配置（Phase-9 M3，见 config.md / memory.md），始终有默认值。 */
  memory: MemoryConfig;
}

/** 记忆 / 上下文压缩配置（Phase-9 M3）。各字段均有默认值，合并后必填齐。 */
export interface MemoryConfig {
  /** 是否启用自动压缩，默认 true。 */
  enabled: boolean;
  /** 消息数触发阈值（向后兼容），默认 40。 */
  thresholdMsgs: number;
  /** 近窗保留条数（向后兼容），默认 16。 */
  keepRecent: number;
  /** token 预算触发阈值，默认 24000。 */
  thresholdTokens: number;
  /** 近窗保留 token 预算，默认 8000。 */
  keepRecentTokens: number;
  /** 摘要器类型：'heuristic'（默认）| 'llm' | 'auto'（失败降级 heuristic）。 */
  summarizer: 'heuristic' | 'llm' | 'auto';
}

// ============================================================================
// Provider / 模型网关 —— 见 product-specs/provider.md
// 协议无关的统一流式接口；首期实现 Anthropic + Mock。
// ============================================================================

/** 一次推理请求的入参（协议无关）。 */
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: ToolSchema[];
  signal: AbortSignal;
}

/**
 * Provider 产出的统一流式事件（五种）。
 * Anthropic SSE → 此事件的映射见 provider.md。
 * - text：文本增量
 * - tool_call：工具调用块开始或其参数增量（argsDelta 跨多个 chunk 由 Loop 累积拼接）
 * - tool_call_done：某个工具调用块结束（参数已拼接完整）
 * - usage：token 用量统计
 * - done：本次响应结束，附终止原因
 */
export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; argsDelta: string }
  | { type: 'tool_call_done'; id: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls' | 'length' };

/** 模型网关：把一次 ChatRequest 转成统一事件流。 */
export interface Provider {
  chat(req: ChatRequest): AsyncIterable<ProviderEvent>;
}
