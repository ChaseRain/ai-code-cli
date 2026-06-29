// src/session/llm-summarizer.ts
// LLMSummarizer —— 可注入的「LLM 摘要器」（Phase-9 M1，见 docs/product-specs/memory.md）。
// 用现有 Provider 调一个轻量模型，把较旧的若干消息压成一段层次化摘要
// （用户目标 / 已完成 / 阻碍 / 关键文件变更 / 错误 / 下一步）。
//
// 设计纪律（core-beliefs）：
// - 自带超时 + try/catch：超时或失败时抛错，由复合摘要器降级回 HeuristicSummarizer。
// - 绝不阻断主循环：本模块只「产出一条摘要文本或抛错」，是否降级由调用方（复合器）决定。
// - 协议无关：只依赖 core/types 的 Provider（不认识 tools），与 Agent Loop 同一抽象。

import type { Message, Provider, ProviderEvent } from '../core/types.js';
import {
  HeuristicSummarizer,
  type Summarizer,
} from './session.js';

/** LLMSummarizer 构造参数。 */
export interface LLMSummarizerOptions {
  /** 复用既有 Provider（同一密钥/网关，不另存凭据）。 */
  provider: Provider;
  /** 摘要用模型 id（通常与主对话同一个；可由 config 指定轻量模型）。 */
  model: string;
  /** 摘要请求独立超时（毫秒），默认 30000；与主请求超时解耦，避免拖慢压缩。 */
  timeoutMs?: number;
}

const DEFAULT_LLM_SUMMARY_TIMEOUT_MS = 30000;

/** 摘要系统提示：要求层次化、聚焦高价值信息（变更/错误/决策）。 */
const SUMMARY_SYSTEM_PROMPT =
  '你是对话压缩器。把给定的较旧对话片段压成中文层次化摘要，严格只输出摘要本身，不要寒暄。\n' +
  '必须覆盖以下小节（无内容则写「无」）：\n' +
  '1. 用户目标\n2. 已完成\n3. 阻碍/未决\n4. 关键文件变更\n5. 错误/失败\n6. 下一步建议';

/**
 * 把较旧消息线性化为一段可读文本，作为摘要请求的 user 输入。
 * 保留 role、工具调用名与工具结果成败，便于模型抓住变更与错误。
 */
function renderOlder(older: Message[]): string {
  const lines: string[] = [];
  for (const m of older) {
    switch (m.role) {
      case 'system':
        lines.push(`[system] ${m.content}`);
        break;
      case 'user':
        lines.push(`[user] ${m.content}`);
        break;
      case 'assistant': {
        if (m.content) lines.push(`[assistant] ${m.content}`);
        for (const call of m.toolCalls ?? []) {
          lines.push(`[tool_call] ${call.name}(${JSON.stringify(call.args ?? {})})`);
        }
        break;
      }
      case 'tool':
        lines.push(`[tool_result ${m.ok ? 'ok' : 'error'}] ${m.content}`);
        break;
    }
  }
  return lines.join('\n');
}

/**
 * LLM 摘要器：用 Provider 调模型产出层次化摘要。
 * 失败 / 超时 → 抛错（交给复合摘要器降级）。绝不在此吞错后返回空摘要。
 */
export class LLMSummarizer implements Summarizer {
  private readonly provider: Provider;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: LLMSummarizerOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_SUMMARY_TIMEOUT_MS;
  }

  async summarize(older: Message[], signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('memory compaction aborted');

    // 独立超时 controller：与外部 signal 联动（任一触发都终止本次摘要请求）。
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort(signal.reason);
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(
      () => ctrl.abort(new Error(`LLM 摘要超时（${this.timeoutMs}ms）`)),
      this.timeoutMs,
    );

    try {
      const messages: Message[] = [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `请压缩以下较旧对话片段（共 ${older.length} 条）：\n\n${renderOlder(older)}`,
        },
      ];
      const stream = this.provider.chat({
        model: this.model,
        messages,
        tools: [], // 摘要无需工具；Provider 不认识 tools 也无妨。
        signal: ctrl.signal,
      });

      let text = '';
      for await (const ev of stream as AsyncIterable<ProviderEvent>) {
        if (ev.type === 'text') text += ev.delta;
      }
      const trimmed = text.trim();
      if (!trimmed) throw new Error('LLM 摘要为空');
      return trimmed;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onOuterAbort);
    }
  }
}

/**
 * 复合摘要器：LLM 优先，失败/超时降级回 HeuristicSummarizer（Phase-9 M1）。
 * 降级是「拿到一条可用摘要」而非「放弃压缩」——绝不阻断主循环。
 */
export class FallbackSummarizer implements Summarizer {
  constructor(
    private readonly primary: Summarizer,
    private readonly fallback: Summarizer,
  ) {}

  async summarize(older: Message[], signal: AbortSignal): Promise<string> {
    try {
      return await this.primary.summarize(older, signal);
    } catch {
      // 主摘要器失败（LLM 超时 / 网络 / 空结果）→ 用本地确定性摘要兜底。
      // 用户主动 abort 也走兜底（HeuristicSummarizer 会自行检查 signal 并抛错，
      //   该抛错由 maybeCompact 的 try/catch 接住、记 error、不阻断）。
      return await this.fallback.summarize(older, signal);
    }
  }
}

/** 摘要器类型（来自 config.memory.summarizer）。 */
export type SummarizerKind = 'heuristic' | 'llm' | 'auto';

/**
 * 摘要器工厂（Phase-9 M1）：按 config 选择实现。
 * - 'heuristic'：本地确定性摘要器（默认，不依赖网络）。
 * - 'llm' / 'auto'：LLM 优先、失败降级 Heuristic 的复合摘要器；
 *   未配置 provider（无 Key）时回落 Heuristic。
 */
export function createSummarizer(
  kind: SummarizerKind,
  provider: Provider | null | undefined,
  model: string,
  opts: { timeoutMs?: number } = {},
): Summarizer {
  const heuristic = new HeuristicSummarizer();
  if (kind === 'heuristic' || !provider) return heuristic;
  // 'llm' 与 'auto' 同语义：LLM 优先 + 失败降级（auto 即「能用 LLM 就用，否则降级」）。
  const llm = new LLMSummarizer({ provider, model, timeoutMs: opts.timeoutMs });
  return new FallbackSummarizer(llm, heuristic);
}
