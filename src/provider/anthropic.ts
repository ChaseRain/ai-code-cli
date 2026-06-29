// src/provider/anthropic.ts
// AnthropicProvider —— 用原生 fetch 对接平台 Anthropic Messages 端点（SSE 流式 + 工具调用）。
// 协议事实来源：docs/product-specs/provider.md、docs/references/coding-plan-platform.md。
// 职责单一：把统一 ChatRequest 转成 Anthropic 请求体，解析 SSE，吐出协议无关的 ProviderEvent。

import type {
  ChatRequest,
  Message,
  Provider,
  ProviderEvent,
  ToolSchema,
} from '../core/types.js';

/** AnthropicProvider 构造参数（从 Config + 环境派生，Provider 自身不读 env/Config）。 */
export interface AnthropicProviderOptions {
  /** 形如 https://ai-kas.kso.net/codeplan/anthropic（末尾不带 /v1/messages） */
  baseURL: string;
  /** ANTHROPIC_AUTH_TOKEN；用于 Authorization: Bearer */
  apiKey: string;
  /** 单请求超时（毫秒），默认 60000 */
  timeoutMs?: number;
  /** 网络错误 / 5xx / 429 的最大重试次数，默认 2 */
  maxRetries?: number;
  /** 上限 token，对应 Anthropic max_tokens，默认 4096 */
  maxTokens?: number;
  /** 可注入的 fetch（测试用）；默认全局 fetch */
  fetchImpl?: typeof fetch;
}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 4096;

// ── Anthropic 请求体形态（仅声明本模块用到的字段） ──────────────────────────

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ToolSchema['parameters'];
}

interface AnthropicTextContent {
  type: 'text';
  text: string;
}
interface AnthropicToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type AnthropicContent =
  | AnthropicTextContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream: true;
}

/**
 * 把统一 Message[] 转成 Anthropic 请求体。
 * - system：所有 system 消息提取拼接为顶层 system 字段（不进 messages）。
 * - assistant：text 块 + toolCalls 映射为 tool_use 块。
 * - tool：映射为下一条 user 消息里的 tool_result 块；连续 tool 结果合并进同一条 user。
 * - user：普通 text 块。
 * 导出供单测直接校验转换正确性（system 提取、tool_use/tool_result 配对）。
 */
export function toAnthropicBody(
  req: ChatRequest,
  maxTokens: number,
): AnthropicRequestBody {
  const systems: string[] = [];
  const messages: AnthropicMessage[] = [];

  // 把相邻 tool 结果聚合到同一条 user 消息，符合 Anthropic「一条 user 携带多个 tool_result」的惯例。
  const pushToolResult = (c: AnthropicToolResultContent): void => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && isAllToolResult(last.content)) {
      last.content.push(c);
    } else {
      messages.push({ role: 'user', content: [c] });
    }
  };

  for (const m of req.messages) {
    switch (m.role) {
      case 'system':
        if (m.content) systems.push(m.content);
        break;
      case 'user':
        messages.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
        break;
      case 'assistant': {
        const content: AnthropicContent[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const call of m.toolCalls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.args ?? {},
          });
        }
        // 即便空也保留一条 assistant，维持回合配对；至少给一个空 text 占位。
        messages.push({
          role: 'assistant',
          content: content.length ? content : [{ type: 'text', text: '' }],
        });
        break;
      }
      case 'tool':
        pushToolResult({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
          // 错误即数据：失败结果也回传，但标注 is_error 让模型据此恢复。
          is_error: m.ok ? undefined : true,
        });
        break;
    }
  }

  const body: AnthropicRequestBody = {
    model: req.model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };
  if (systems.length) body.system = systems.join('\n\n');
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  return body;
}

function isAllToolResult(
  content: AnthropicContent[],
): content is AnthropicToolResultContent[] {
  return content.every((c) => c.type === 'tool_result');
}

// ── SSE 解析：纯函数式拆帧 + 有状态事件映射 ────────────────────────────────

type FinishReason = 'stop' | 'tool_calls' | 'length';

/** Anthropic stop_reason → 统一 finishReason。 */
function mapFinishReason(stop: string | null | undefined): FinishReason {
  switch (stop) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'stop';
  }
}

/**
 * 把一段已组装好的 SSE `data:` JSON 对象转成 0..N 个 ProviderEvent。
 * 有状态：依赖 finishReason 的闭包记录在调用处；这里只处理单个事件对象。
 * 导出供单测直接喂入分片事件、校验拼接逻辑。
 */
export function mapSSEEvent(
  evt: any,
  state: { finishReason: FinishReason },
): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  switch (evt?.type) {
    case 'message_start': {
      const u = evt.message?.usage;
      if (u && typeof u.input_tokens === 'number') {
        out.push({
          type: 'usage',
          promptTokens: u.input_tokens ?? 0,
          completionTokens: u.output_tokens ?? 0,
        });
      }
      break;
    }
    case 'content_block_start': {
      const block = evt.content_block;
      if (block?.type === 'tool_use') {
        out.push({
          type: 'tool_call',
          id: block.id,
          name: block.name,
          argsDelta: '',
        });
      }
      // content_block_start(text) 无需事件，文本随 delta 来。
      break;
    }
    case 'content_block_delta': {
      const d = evt.delta;
      if (d?.type === 'text_delta') {
        out.push({ type: 'text', delta: d.text ?? '' });
      } else if (d?.type === 'input_json_delta') {
        // 工具参数增量：用空 id/name 标记「续写」，argsDelta 由 Loop 累积拼接。
        out.push({
          type: 'tool_call',
          id: '',
          name: '',
          argsDelta: d.partial_json ?? '',
        });
      }
      break;
    }
    case 'content_block_stop':
      out.push({ type: 'tool_call_done', id: '' });
      break;
    case 'message_delta': {
      const stop = evt.delta?.stop_reason;
      if (stop) state.finishReason = mapFinishReason(stop);
      const u = evt.usage;
      if (u && typeof u.output_tokens === 'number') {
        out.push({
          type: 'usage',
          promptTokens: u.input_tokens ?? 0,
          completionTokens: u.output_tokens ?? 0,
        });
      }
      break;
    }
    case 'message_stop':
      out.push({ type: 'done', finishReason: state.finishReason });
      break;
  }
  return out;
}

/** 标记不应重试的错误（鉴权/请求格式类 4xx）。 */
class NonRetryableError extends Error {}

/**
 * 流读取超时错误（Phase-9 P1）：响应头已到、但后续相邻字节间隔超过 timeoutMs。
 * 等价于一次半开连接超时，按「可重试」处理（与首字节超时同语义）。
 */
class StreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`流读取超时（${timeoutMs}ms 内无新数据）`);
    this.name = 'StreamTimeoutError';
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 错误分类（Phase-9 P2）：判定一个 `send()` / 流读取阶段抛出的错误是否可重试。
 * - 用户主动 abort（外部 signal 已 aborted）：不可重试（这是预期中断，不该重试）。
 * - 网络层错误（ECONNREFUSED/ETIMEDOUT/ENOTFOUND/EAI_AGAIN/"fetch failed"）：可重试。
 * - 流读取 idle 超时（StreamTimeoutError，等价超时）：可重试。
 * - NonRetryableError（4xx 鉴权/格式）：不可重试。
 * 判定依据错误的 code/cause/文案，而非单点字符串硬匹配。
 */
const RETRYABLE_NET_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function isRetryableNetworkError(err: unknown, outer: AbortSignal): boolean {
  // 用户主动中断：不重试。
  if (outer.aborted) return false;
  if (err instanceof NonRetryableError) return false;
  // 内部流读取 idle 超时：等价一次超时，重试。
  if (err instanceof StreamTimeoutError) return true;

  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e?.code ?? e?.cause?.code;
  if (code && RETRYABLE_NET_CODES.has(code)) return true;
  const msg = (e?.message ?? '').toLowerCase();
  if (msg.includes('fetch failed')) return true;
  return false;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class AnthropicProvider implements Provider {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicProviderOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const body = toAnthropicBody(req, this.maxTokens);
    let attempt = 0;

    // 退避重试外层：覆盖「发起请求 → 拿到响应头 → 开始读流之前」整个阶段。
    // 注意：流一旦开始 yield 事件，就不再重试（避免向上游重复发事件）；
    //   但「拿响应头 / 第一次读取前」抛出的网络错误（含流读取 idle 超时）仍纳入重试。
    for (;;) {
      // ── send 阶段：网络错误 / 首字节超时 在此抛出，需纳入重试（Phase-9 P2）──
      let res: Response;
      try {
        res = await this.send(body, req.signal);
      } catch (err) {
        if (isRetryableNetworkError(err, req.signal) && attempt < this.maxRetries) {
          attempt++;
          await sleep(backoffMs(attempt), req.signal);
          continue;
        }
        throw err;
      }

      if (!res.ok) {
        const status = res.status;
        // 读掉响应体避免句柄泄漏（也用于错误信息，但不打印密钥）。
        const text = await safeText(res);
        if (isRetryableStatus(status) && attempt < this.maxRetries) {
          attempt++;
          await sleep(backoffMs(attempt), req.signal);
          continue;
        }
        const err =
          status >= 400 && status < 500 && !isRetryableStatus(status)
            ? new NonRetryableError(`Anthropic ${status}: ${truncate(text)}`)
            : new Error(`Anthropic ${status}: ${truncate(text)}`);
        throw err;
      }

      if (!res.body) {
        throw new Error('Anthropic 响应无 body（无法读取 SSE 流）');
      }

      yield* this.readSSE(res.body, req.signal);
      return;
    }
  }

  /** 单次发起请求，带超时 abort（与外部 signal 联动）。 */
  private async send(
    body: AnthropicRequestBody,
    outer: AbortSignal,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort(outer.reason);
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });

    const timer = setTimeout(
      () => ctrl.abort(new Error(`请求超时（${this.timeoutMs}ms）`)),
      this.timeoutMs,
    );

    try {
      return await this.fetchImpl(`${this.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
      outer.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * 读取 SSE 字节流，按行拆 event/data，组装后交给 mapSSEEvent。
   * Phase-9 P1：每次 reader.read() 受 idle 超时保护——相邻两次字节到达间隔
   *   超过 timeoutMs 视为半开连接，abort reader 并抛 StreamTimeoutError；
   *   外部 signal abort 同样终止读取。计时器在每次成功读取后重置（idle 语义）。
   */
  private async *readSSE(
    stream: ReadableStream<Uint8Array>,
    outer: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const state: { finishReason: FinishReason } = { finishReason: 'stop' };
    let buf = '';

    try {
      for (;;) {
        const { done, value } = await this.readWithIdleTimeout(reader, outer);
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件块；逐块处理，保留未完成的尾部。
        let sep: number;
        while ((sep = indexOfBlockSep(buf)) !== -1) {
          const rawBlock = buf.slice(0, sep);
          buf = buf.slice(sep).replace(/^(?:\r?\n)+/, '');
          const dataJson = extractData(rawBlock);
          if (dataJson === null) continue;
          if (dataJson === '[DONE]') {
            yield { type: 'done', finishReason: state.finishReason };
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataJson);
          } catch {
            continue; // 容错：跳过坏帧而非崩溃。
          }
          for (const e of mapSSEEvent(parsed, state)) yield e;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 单次 reader.read() 加 idle 超时与外部 signal 联动（Phase-9 P1）。
   * - timeoutMs 内 read() 未 settle → cancel reader 并抛 StreamTimeoutError。
   * - 外部 signal 在等待期间 abort → cancel reader 并抛 abort 原因。
   * - read() 正常返回 → 清理计时器与监听器，把结果交回调用方（计时器随每次调用重建，即 idle 重置）。
   */
  private async readWithIdleTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    outer: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (outer.aborted) {
      // 等待前已中断：取消底层流并抛出中断原因。
      await reader.cancel(outer.reason).catch(() => {});
      throw outer.reason ?? new Error('aborted');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new StreamTimeoutError(this.timeoutMs);
        // 先 reject 赢得 race（避免 cancel 让 pending 的 read() 以 done:true 抢先 settle），
        // 再 cancel reader 释放底层连接，不再永久挂起。
        reject(err);
        reader.cancel(err).catch(() => {});
      }, this.timeoutMs);
      onAbort = () => {
        const reason = outer.reason ?? new Error('aborted');
        reject(reason);
        reader.cancel(reason).catch(() => {});
      };
      outer.addEventListener('abort', onAbort, { once: true });
    });

    try {
      return await Promise.race([reader.read(), guard]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) outer.removeEventListener('abort', onAbort);
    }
  }
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 找到一个完整 SSE 事件块的结束位置（空行 \n\n 或 \r\n\r\n 之后）。返回分隔起点；无则 -1。 */
function indexOfBlockSep(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** 从一个事件块中抽取并拼接所有 `data:` 行（多行 data 用 \n 连接）。无 data 返回 null。 */
function extractData(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const datas: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      datas.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return datas.length ? datas.join('\n') : null;
}

function backoffMs(attempt: number): number {
  // 指数退避 + 抖动：250ms, 500ms, ...，封顶 8s。
  const base = Math.min(250 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 100);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
