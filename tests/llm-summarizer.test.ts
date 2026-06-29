// tests/llm-summarizer.test.ts
// 覆盖 memory.md A12（M1）：LLMSummarizer 用 mock Provider 产出层次化摘要；
//   超时/失败时复合 FallbackSummarizer 降级回 HeuristicSummarizer，主循环不被阻断。
// 不依赖真实网络：Provider 全部用 Mock / 桩。

import { describe, it, expect } from 'vitest';
import {
  LLMSummarizer,
  FallbackSummarizer,
  createSummarizer,
  HeuristicSummarizer,
} from '../src/session/index.js';
import { MockProvider, scriptText } from '../src/provider/mock.js';
import type { Message, Provider, ProviderEvent } from '../src/core/types.js';

const older: Message[] = [
  { role: 'user', content: '请实现登录功能' },
  {
    role: 'assistant',
    content: '好的',
    toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'login.ts' } }],
  },
  { role: 'tool', toolCallId: 'c1', content: 'written', ok: true },
  { role: 'assistant', content: '已写入 login.ts' },
];

describe('LLMSummarizer（M1）', () => {
  it('用 mock Provider 产出摘要文本', async () => {
    const provider = new MockProvider({ scripts: scriptText('1. 用户目标：登录功能\n2. 已完成：写入 login.ts') });
    const s = new LLMSummarizer({ provider, model: 'm', timeoutMs: 1000 });
    const summary = await s.summarize(older, new AbortController().signal);
    expect(summary).toContain('用户目标');
    expect(summary).toContain('login.ts');
    // Provider 收到的请求：system 摘要提示 + user 片段，无 tools。
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].tools).toEqual([]);
    expect(provider.requests[0].messages[0].role).toBe('system');
  });

  it('Provider 抛错 → summarize 抛错（交给复合器降级）', async () => {
    const failing: Provider = {
      // eslint-disable-next-line require-yield
      async *chat(): AsyncIterable<ProviderEvent> {
        throw new Error('网络炸了');
      },
    };
    const s = new LLMSummarizer({ provider: failing, model: 'm' });
    await expect(s.summarize(older, new AbortController().signal)).rejects.toThrow(/网络炸了/);
  });

  it('Provider 输出空文本 → 抛「LLM 摘要为空」', async () => {
    const provider = new MockProvider({ scripts: scriptText('') });
    const s = new LLMSummarizer({ provider, model: 'm' });
    await expect(s.summarize(older, new AbortController().signal)).rejects.toThrow(/为空/);
  });

  it('超时 → 抛超时错误（短 timeoutMs，Provider 迟迟不产出）', async () => {
    // 永不产出事件的 Provider：等到自身 signal abort 才结束。
    const hanging: Provider = {
      async *chat(req): AsyncIterable<ProviderEvent> {
        await new Promise<void>((_resolve, reject) => {
          req.signal.addEventListener('abort', () =>
            reject(req.signal.reason ?? new Error('aborted')),
          );
        });
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const s = new LLMSummarizer({ provider: hanging, model: 'm', timeoutMs: 20 });
    await expect(s.summarize(older, new AbortController().signal)).rejects.toThrow();
  });
});

describe('FallbackSummarizer / createSummarizer 降级（M1）', () => {
  it('主摘要器失败 → 降级回 Heuristic（拿到可用摘要，不抛错）', async () => {
    const failing: Provider = {
      // eslint-disable-next-line require-yield
      async *chat(): AsyncIterable<ProviderEvent> {
        throw new Error('boom');
      },
    };
    const composite = new FallbackSummarizer(
      new LLMSummarizer({ provider: failing, model: 'm' }),
      new HeuristicSummarizer(),
    );
    const summary = await composite.summarize(older, new AbortController().signal);
    // 降级到 heuristic：含其确定性输出特征。
    expect(summary).toContain('压缩了');
    expect(summary).toContain('请实现登录功能');
  });

  it('createSummarizer：heuristic 返回本地实现', () => {
    const s = createSummarizer('heuristic', null, 'm');
    expect(s).toBeInstanceOf(HeuristicSummarizer);
  });

  it('createSummarizer：llm 无 provider 时回落 heuristic', () => {
    const s = createSummarizer('llm', null, 'm');
    expect(s).toBeInstanceOf(HeuristicSummarizer);
  });

  it('createSummarizer：llm/auto 有 provider 时返回复合降级摘要器', () => {
    const provider = new MockProvider({ scripts: scriptText('x') });
    expect(createSummarizer('llm', provider, 'm')).toBeInstanceOf(FallbackSummarizer);
    expect(createSummarizer('auto', provider, 'm')).toBeInstanceOf(FallbackSummarizer);
  });
});
