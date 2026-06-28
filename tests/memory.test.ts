// tests/memory.test.ts
// 覆盖 docs/product-specs/memory.md 的验收项（不依赖真实网络，用 Mock Summarizer）：
//  A1 压缩不破坏 tool_call ↔ tool_result 配对
//  A2 system 消息始终保留在首部
//  A3 summary 作为独立消息注入，近 keepRecent 条原样保留
//  A4 Mock Summarizer 即可验证全流程
//  A5 resume 从 jsonl 重建历史，顺序与配对正确
//  A7 阈值未到时 maybeCompact 为 no-op
//  A8 append→maybeCompact→新 Session resumeFrom 后与压缩后 history 等价且 hasSummary=true

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Session, SUMMARY_PREFIX, type Summarizer } from '../src/session/index.js';
import type { Message } from '../src/core/types.js';

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'ai-code-cli-memory-'));
});
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/** Mock 摘要器：把消息数压成一句固定摘要（A4：不依赖真实模型/网络）。 */
const mockSummarizer: Summarizer = {
  async summarize(older: Message[]): Promise<string> {
    return `共 ${older.length} 条旧消息的摘要`;
  },
};

describe('Session.resumeFrom —— 会话恢复（A5）', () => {
  it('从 jsonl 重建历史：顺序正确且 tool_call 挂回 assistant、tool_result 还原', () => {
    // 先用一个会话写出一段含工具轮次的日志。
    const w = new Session({ rootDir, id: 'src' });
    const original: Message[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: '调用工具',
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'body', ok: true },
      { role: 'assistant', content: '完成' },
    ];
    for (const m of original) w.append(m);

    // 新会话从该日志恢复。
    const r = new Session({ rootDir, id: 'dst' });
    const { restored } = r.resumeFrom(w.logFile);

    expect(restored).toBe(original.length);
    const got = r.messages();
    expect(got).toEqual(original); // 顺序、内容、tool 配对完全等价
    // 明确断言 tool_call 挂回了 assistant
    const asst = got[2] as Extract<Message, { role: 'assistant' }>;
    expect(asst.toolCalls).toEqual([{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }]);
  });

  it('A8：append→maybeCompact→新 Session resumeFrom 后，与压缩后 history 等价且 hasSummary', async () => {
    // 写一段够长的历史并压缩（压缩 summary 记录会落到同一日志）。
    const w = new Session({ rootDir, id: 'a8' });
    w.append({ role: 'system', content: 'SYS' });
    for (let i = 0; i < 5; i++) {
      w.append({ role: 'user', content: `u${i}` });
      w.append({ role: 'assistant', content: `a${i}` });
    }
    const res = await w.maybeCompact({
      thresholdMsgs: 6,
      keepRecent: 4,
      summarizer: mockSummarizer,
    });
    expect(res.compacted).toBe(true);
    const compacted = w.messages(); // 压缩后的内存 history

    // 新 Session 从同一日志恢复 —— 应还原出压缩后的状态（不丢摘要）。
    const r = new Session({ rootDir, id: 'a8r' });
    r.resumeFrom(w.logFile);

    expect(r.messages()).toEqual(compacted);
    expect(r.memoryStats().hasSummary).toBe(true);
  });

  it('恢复跳过 permission / error，不进喂模型上下文', () => {
    const w = new Session({ rootDir, id: 'skip' });
    w.append({ role: 'user', content: 'hi' });
    w.logPermission({ toolCallId: 'c1', tool: 'write_file', effect: 'deny' });
    w.logError({ message: 'boom' });
    w.append({ role: 'assistant', content: 'ok' });

    const r = new Session({ rootDir, id: 'skip2' });
    r.resumeFrom(w.logFile);
    expect(r.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('Session.findLatestLog', () => {
  it('返回最近一次日志并可排除自身', () => {
    const a = new Session({ rootDir, id: 'aaa' });
    a.append({ role: 'user', content: '1' });
    const b = new Session({ rootDir, id: 'bbb' });
    b.append({ role: 'user', content: '2' });

    const latest = Session.findLatestLog(rootDir);
    expect(latest).toBe(b.logFile); // bbb 更晚

    const exclB = Session.findLatestLog(rootDir, b.logFile);
    expect(exclB).toBe(a.logFile);
  });

  it('无日志目录时返回 null', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ai-code-cli-empty-'));
    expect(Session.findLatestLog(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('Session.maybeCompact —— 上下文压缩', () => {
  /** 构造一段历史：1 system + N 轮（user/assistant）。 */
  function seed(s: Session, rounds: number): void {
    s.append({ role: 'system', content: 'SYS' });
    for (let i = 0; i < rounds; i++) {
      s.append({ role: 'user', content: `u${i}` });
      s.append({ role: 'assistant', content: `a${i}` });
    }
  }

  it('A7：阈值未到 → no-op', async () => {
    const s = new Session({ rootDir, id: 'noop' });
    seed(s, 2); // 1 + 4 = 5 条
    const before = s.messages();
    const res = await s.maybeCompact({ thresholdMsgs: 10, keepRecent: 2, summarizer: mockSummarizer });
    expect(res.compacted).toBe(false);
    expect(s.messages()).toEqual(before);
  });

  it('A2/A3/A4：压缩后 system 在首部、summary 独立注入、近窗保真', async () => {
    const s = new Session({ rootDir, id: 'comp' });
    seed(s, 5); // 1 + 10 = 11 条
    const res = await s.maybeCompact({ thresholdMsgs: 6, keepRecent: 4, summarizer: mockSummarizer });

    expect(res.compacted).toBe(true);
    const msgs = s.messages();
    // A2：首部仍是原 system
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    // A3：第二条是注入的 summary（system 角色，带前缀）
    expect(msgs[1].role).toBe('system');
    expect((msgs[1] as { content: string }).content.startsWith(SUMMARY_PREFIX)).toBe(true);
    // A3：近窗保真 —— 末尾 4 条仍是原最后两轮
    expect(msgs.slice(-4)).toEqual([
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
      { role: 'assistant', content: 'a4' },
    ]);
    // 压缩后总长缩短
    expect(msgs.length).toBeLessThan(11);
    // memoryStats 反映 hasSummary
    expect(s.memoryStats().hasSummary).toBe(true);
  });

  it('A1：压缩不破坏 tool_call ↔ tool_result 配对（切点不落在工具组中间）', async () => {
    const s = new Session({ rootDir, id: 'pair' });
    s.append({ role: 'system', content: 'SYS' });
    // 旧区：两个普通轮 + 一个工具轮
    s.append({ role: 'user', content: 'u0' });
    s.append({ role: 'assistant', content: 'a0' });
    s.append({ role: 'user', content: 'u1' });
    // 工具轮：assistant(toolCalls) 紧跟 tool 结果——必须同侧
    s.append({
      role: 'assistant',
      content: '调用',
      toolCalls: [{ id: 't1', name: 'read_file', args: {} }],
    });
    s.append({ role: 'tool', toolCallId: 't1', content: 'r', ok: true });
    // 近窗：最后两条
    s.append({ role: 'user', content: 'u2' });
    s.append({ role: 'assistant', content: 'a2' });

    const res = await s.maybeCompact({ thresholdMsgs: 5, keepRecent: 2, summarizer: mockSummarizer });
    expect(res.compacted).toBe(true);

    const msgs = s.messages();
    // 每个 tool 消息的前面必须能找到其 assistant 调用（配对未被切断）。
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'tool') {
        const hasCaller = msgs
          .slice(0, i)
          .some(
            (x) =>
              x.role === 'assistant' &&
              x.toolCalls?.some((c) => c.id === m.toolCallId),
          );
        expect(hasCaller).toBe(true);
      }
    }
  });
});
