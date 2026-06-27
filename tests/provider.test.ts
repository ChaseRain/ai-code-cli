// tests/provider.test.ts
// 覆盖 provider.md「验收」：SSE 分片拼接、Message[]↔Anthropic 转换、超时/重试/4xx、Mock 驱动。
// 不依赖真实网络：fetch 全部注入桩。

import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicProvider,
  toAnthropicBody,
  mapSSEEvent,
} from '../src/provider/anthropic.js';
import {
  MockProvider,
  scriptText,
  scriptToolCall,
} from '../src/provider/mock.js';
import type {
  ChatRequest,
  Message,
  ProviderEvent,
  ToolSchema,
} from '../src/core/types.js';

// ── 测试小工具 ──────────────────────────────────────────────────────────────

function makeReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'deepseek/deepseek-v4-pro',
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(
  it: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** 把若干 Anthropic SSE 事件对象编码成一个 SSE 文本帧。 */
function sseFrame(evt: unknown): string {
  return `event: ${(evt as any).type}\ndata: ${JSON.stringify(evt)}\n\n`;
}

/** 构造一个返回给定字节分片的 Response（body 为 ReadableStream）。 */
function streamResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status });
}

// ── 1. SSE 分片拼接出完整工具参数 ───────────────────────────────────────────

describe('AnthropicProvider SSE 解析', () => {
  it('input_json_delta 跨多个 chunk 拼接出完整工具参数', async () => {
    // 完整参数 {"path":"a.txt"} 被切成两段 partial_json，且跨 TCP 分片传输。
    const frames = [
      sseFrame({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
      sseFrame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' },
      }),
      sseFrame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }),
      sseFrame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"a.txt"}' },
      }),
      sseFrame({ type: 'content_block_stop', index: 0 }),
      sseFrame({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 },
      }),
      sseFrame({ type: 'message_stop' }),
    ].join('');

    // 故意把整段流切成不对齐字节边界的小块，逼真模拟 SSE 分片。
    const chunks: string[] = [];
    for (let p = 0; p < frames.length; p += 7) chunks.push(frames.slice(p, p + 7));

    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(chunks));
    const provider = new AnthropicProvider({
      baseURL: 'https://example.test/anthropic',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(provider.chat(makeReq({ tools: [] })));

    // 累积所有 tool_call.argsDelta 应拼出完整 JSON。
    const args = events
      .filter((e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call')
      .map((e) => e.argsDelta)
      .join('');
    expect(args).toBe('{"path":"a.txt"}');
    expect(JSON.parse(args)).toEqual({ path: 'a.txt' });

    // tool_call 起始块带 id/name。
    const start = events.find(
      (e): e is Extract<ProviderEvent, { type: 'tool_call' }> =>
        e.type === 'tool_call' && e.name !== '',
    );
    expect(start).toMatchObject({ id: 'tu_1', name: 'read_file' });

    // tool_call_done 与 done(tool_calls) 都到位。
    expect(events.some((e) => e.type === 'tool_call_done')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('text_delta 映射为 text 事件，end_turn → stop', async () => {
    const frames = [
      sseFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
      sseFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      sseFrame({ type: 'content_block_stop', index: 0 }),
      sseFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      sseFrame({ type: 'message_stop' }),
    ].join('');

    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([frames]));
    const provider = new AnthropicProvider({
      baseURL: 'https://example.test/anthropic/',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(provider.chat(makeReq()));
    const text = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hello');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });

    // baseURL 末尾斜杠被规整，端点正确。
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/anthropic/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('mapSSEEvent: max_tokens → length，未知 stop_reason → stop', () => {
    const s1 = { finishReason: 'stop' as const };
    mapSSEEvent({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, s1);
    expect(mapSSEEvent({ type: 'message_stop' }, s1)).toEqual([
      { type: 'done', finishReason: 'length' },
    ]);
  });
});

// ── 2. Message[] ↔ Anthropic 体转换 ─────────────────────────────────────────

describe('toAnthropicBody 转换', () => {
  const tools: ToolSchema[] = [
    { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];

  it('提取 system 顶层、配对 tool_use/tool_result、映射工具 schema', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: '读一下 a.txt' },
      { role: 'assistant', content: '好的', toolCalls: [{ id: 'tu_1', name: 'read_file', args: { path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'tu_1', content: 'file contents', ok: true },
      { role: 'assistant', content: '内容如上' },
    ];

    const body = toAnthropicBody(makeReq({ messages, tools }), 4096);

    // system 提取为顶层，不进 messages。
    expect(body.system).toBe('You are helpful.');
    expect(body.messages.every((m) => m.role !== ('system' as any))).toBe(true);

    // tools 映射为 input_schema。
    expect(body.tools).toEqual([
      { name: 'read_file', description: '读文件', input_schema: tools[0].parameters },
    ]);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);

    // assistant 携带 tool_use 块；input 来自 args。
    const asst = body.messages[1];
    expect(asst.role).toBe('assistant');
    expect(asst.content).toEqual([
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
    ]);

    // tool 结果包装为 user.tool_result，tool_use_id 配对。
    const toolMsg = body.messages[2];
    expect(toolMsg.role).toBe('user');
    expect(toolMsg.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents', is_error: undefined },
    ]);
  });

  it('失败的 tool 结果标注 is_error；多个 system 拼接；空 tools 不带 tools 字段', () => {
    const messages: Message[] = [
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'sh', args: {} }] },
      { role: 'tool', toolCallId: 't1', content: 'boom', ok: false },
    ];
    const body = toAnthropicBody(makeReq({ messages, tools: [] }), 100);
    expect(body.system).toBe('A\n\nB');
    expect(body.tools).toBeUndefined();
    const toolResult = (body.messages.at(-1) as any).content[0];
    expect(toolResult).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true });
  });

  it('连续多个 tool 结果合并进同一条 user 消息', () => {
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }, { id: 'b', name: 'y', args: {} }] },
      { role: 'tool', toolCallId: 'a', content: 'ra', ok: true },
      { role: 'tool', toolCallId: 'b', content: 'rb', ok: true },
    ];
    const body = toAnthropicBody(makeReq({ messages }), 100);
    const userMsg = body.messages.at(-1)!;
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content.map((c: any) => c.tool_use_id)).toEqual(['a', 'b']);
  });
});

// ── 3. 超时 / 重试 / 4xx ────────────────────────────────────────────────────

describe('AnthropicProvider 错误处理', () => {
  it('5xx 触发退避重试，最终成功', async () => {
    const ok = streamResponse([
      sseFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
        sseFrame({ type: 'message_stop' }),
    ]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream error', { status: 503 }))
      .mockResolvedValueOnce(ok);

    const provider = new AnthropicProvider({
      baseURL: 'https://x.test/an',
      apiKey: 'k',
      maxRetries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const events = await collect(provider.chat(makeReq()));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('429 触发重试；超过 maxRetries 后抛错', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429 }));
    const provider = new AnthropicProvider({
      baseURL: 'https://x.test/an',
      apiKey: 'k',
      maxRetries: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(collect(provider.chat(makeReq()))).rejects.toThrow(/429/);
    // 首次 + 1 次重试 = 2 次。
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('4xx（401）不重试，直接抛错', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const provider = new AnthropicProvider({
      baseURL: 'https://x.test/an',
      apiKey: 'bad',
      maxRetries: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(collect(provider.chat(makeReq()))).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('超时触发 abort（fetch 收到已 abort 的 signal）', async () => {
    // fetchImpl 永不 resolve，直到其 signal 被 abort 才 reject —— 模拟真实超时。
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')));
      });
    });
    const provider = new AnthropicProvider({
      baseURL: 'https://x.test/an',
      apiKey: 'k',
      timeoutMs: 20,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(collect(provider.chat(makeReq()))).rejects.toThrow(/超时/);
  });
});

// ── 4. MockProvider 驱动 ────────────────────────────────────────────────────

describe('MockProvider 脚本驱动', () => {
  it('scriptText 驱动纯文本回复', async () => {
    const provider = new MockProvider({ scripts: scriptText('Hello world') });
    const events = await collect(provider.chat(makeReq()));
    const text = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hello world');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('多轮脚本：先 tool_call，第二轮 stop（模拟 Agent Loop 全链路）', async () => {
    const provider = new MockProvider({
      scripts: [
        scriptToolCall('tu_1', 'read_file', { path: 'a.txt' }),
        scriptText('done'),
      ],
    });

    // 第 1 轮：拿到工具调用，参数拼接完整。
    const r1 = await collect(provider.chat(makeReq()));
    const args = r1
      .filter((e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call')
      .map((e) => e.argsDelta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.txt' });
    expect(r1.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });

    // 第 2 轮：回喂 tool_result 后正常结束。
    const r2 = await collect(
      provider.chat(
        makeReq({ messages: [{ role: 'tool', toolCallId: 'tu_1', content: 'x', ok: true }] }),
      ),
    );
    expect(r2.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });

    // 记录了两次请求，便于上层断言。
    expect(provider.requests).toHaveLength(2);
  });

  it('函数脚本可基于请求动态产出', async () => {
    const provider = new MockProvider({
      scripts: (req) => scriptText(`got ${req.messages.length} msgs`),
    });
    const events = await collect(
      provider.chat(makeReq({ messages: [{ role: 'user', content: 'hi' }] })),
    );
    const text = events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');
    expect(text).toBe('got 1 msgs');
  });
});
