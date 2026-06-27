// src/provider/mock.ts
// MockProvider —— 脚本化驱动核心：按预设序列吐 ProviderEvent，不依赖网络。
// 是所有上层（Agent Loop、TUI）测试的驱动基础（见 provider.md「验收」）。

import type { ChatRequest, Provider, ProviderEvent } from '../core/types.js';

/**
 * 单轮脚本：一个 ProviderEvent 序列。
 * 也可用函数形态，按「第几次 chat 调用 + 本次 ChatRequest」动态产出，
 * 便于模拟「先 tool_call，回喂 tool_result 后再 stop」的多轮链路。
 */
export type MockScript =
  | ProviderEvent[]
  | ((req: ChatRequest, turn: number) => ProviderEvent[]);

export interface MockProviderOptions {
  /** 单脚本，或按调用次序消费的多脚本数组。 */
  scripts: MockScript | MockScript[];
  /** 每个事件之间的延迟（毫秒），默认 0；用于模拟流式节奏。 */
  delayMs?: number;
}

export class MockProvider implements Provider {
  private readonly scripts: MockScript[];
  private readonly delayMs: number;
  private turn = 0;
  /** 记录收到的每次请求，便于断言上下文/转换。 */
  readonly requests: ChatRequest[] = [];

  constructor(opts: MockProviderOptions) {
    this.scripts = normalizeScripts(opts.scripts);
    this.delayMs = opts.delayMs ?? 0;
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    const idx = Math.min(this.turn, this.scripts.length - 1);
    this.turn++;

    const script = this.scripts[idx];
    const events =
      typeof script === 'function' ? script(req, idx) : script;

    for (const e of events) {
      // 尊重取消信号：中断时停止吐事件。
      if (req.signal.aborted) {
        throw req.signal.reason ?? new Error('aborted');
      }
      if (this.delayMs > 0) await delay(this.delayMs, req.signal);
      yield e;
    }
  }
}

/**
 * 归一 scripts 入参为 MockScript[]。
 * 歧义点：单个脚本本身可能是 ProviderEvent[]（也是数组）。
 * 判定：若是「数组的数组」或「数组里含函数」→ 视为多脚本；否则视为单脚本（一段事件序列）。
 */
function normalizeScripts(input: MockScript | MockScript[]): MockScript[] {
  if (typeof input === 'function') return [input];
  // input 是数组：判断是 ProviderEvent[]（单脚本）还是 MockScript[]（多脚本）。
  const looksMulti = input.some(
    (el) => typeof el === 'function' || Array.isArray(el),
  );
  return looksMulti ? (input as MockScript[]) : [input as MockScript];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
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

// ── 便捷构造器：拼出常见事件序列，让测试脚本可读 ────────────────────────────

/** 一段纯文本回复后正常结束。 */
export function scriptText(text: string, chunk = 4): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    events.push({ type: 'text', delta: text.slice(i, i + chunk) });
  }
  events.push({ type: 'done', finishReason: 'stop' });
  return events;
}

/**
 * 一次工具调用：tool_call(start) → 多个 argsDelta → tool_call_done → done(tool_calls)。
 * args 会被 JSON 序列化后切片，模拟 input_json_delta 跨 chunk 累积。
 */
export function scriptToolCall(
  id: string,
  name: string,
  args: unknown,
  opts: { chunk?: number; leadingText?: string } = {},
): ProviderEvent[] {
  const { chunk = 8, leadingText } = opts;
  const events: ProviderEvent[] = [];
  if (leadingText) events.push({ type: 'text', delta: leadingText });
  events.push({ type: 'tool_call', id, name, argsDelta: '' });
  const json = JSON.stringify(args ?? {});
  for (let i = 0; i < json.length; i += chunk) {
    events.push({
      type: 'tool_call',
      id: '',
      name: '',
      argsDelta: json.slice(i, i + chunk),
    });
  }
  events.push({ type: 'tool_call_done', id });
  events.push({ type: 'done', finishReason: 'tool_calls' });
  return events;
}
