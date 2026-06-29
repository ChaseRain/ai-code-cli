// tests/session.test.ts
// 覆盖 docs/product-specs/session-context.md 的验收点（不依赖真实网络）：
// - 各类消息正确入历史且顺序正确
// - /clear 清空内存上下文并开新日志文件
// - jsonl 落盘内容可被重新读取解析（user / assistant / tool_call / tool_result / permission / error）

import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Session, type LogRecord } from '../src/session/index.js';
import type { Message } from '../src/core/types.js';

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'ai-code-cli-session-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/** 把一个 jsonl 文件解析成 LogRecord 数组（验证落盘可重新读取解析）。 */
function readLog(path: string): LogRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogRecord);
}

describe('Session 内存历史', () => {
  it('各类消息正确入历史且顺序正确', () => {
    const s = new Session({ rootDir, id: 'unit' });

    const msgs: Message[] = [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: '我来读文件',
        toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'call-1', content: 'file body', ok: true },
      { role: 'assistant', content: '读完了' },
    ];
    for (const m of msgs) s.append(m);

    const out = s.messages();
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    // 顺序与内容一致
    expect(out).toEqual(msgs);
  });

  it('messages() 返回浅拷贝，外部修改不影响内部历史', () => {
    const s = new Session({ rootDir, id: 'copy' });
    s.append({ role: 'user', content: 'hi' });

    const snapshot = s.messages();
    snapshot.push({ role: 'user', content: 'mutated' });

    expect(s.messages()).toHaveLength(1);
  });
});

describe('Session /clear', () => {
  it('清空内存上下文并开启新日志文件', () => {
    const s = new Session({ rootDir, id: 'clr' });
    s.append({ role: 'user', content: '第一轮' });
    const firstLog = s.logFile;
    expect(existsSync(firstLog)).toBe(true);

    s.clear();

    // 内存被清空
    expect(s.messages()).toHaveLength(0);
    // 新日志文件路径不同于旧的
    const secondLog = s.logFile;
    expect(secondLog).not.toBe(firstLog);

    // 旧日志原样保留（交付记录不丢）
    expect(existsSync(firstLog)).toBe(true);
    expect(readLog(firstLog)).toHaveLength(1);

    // 新会话独立记录
    s.append({ role: 'user', content: '第二轮' });
    const second = readLog(secondLog);
    expect(second).toHaveLength(1);
    expect(second[0].kind).toBe('user');
    expect((second[0].payload as { content: string }).content).toBe('第二轮');
  });

  // Phase-6 LH7：resume 超大日志明确报错，不全量读入内存（防 OOM）。
  it('P6-B6：resumeFrom 超大 jsonl 抛明确错误，不 OOM', () => {
    const s = new Session({ rootDir, id: 'huge' });
    s.append({ role: 'user', content: 'seed' });
    // 追加到 > 8 MiB（MAX_RESUME_BYTES）
    appendFileSync(s.logFile, 'Z'.repeat(9 * 1024 * 1024), 'utf8');
    const r = new Session({ rootDir, id: 'huge2' });
    expect(() => r.resumeFrom(s.logFile)).toThrow(/会话日志过大/);
  });

  // 历史回归硬化：同一毫秒内连续 clear 也必须拿到唯一日志路径，旧日志不丢。
  it('同一毫秒连续 clear 两次：3 个 logPath 全不同且旧日志保留', () => {
    // 固定时钟到同一毫秒，模拟 newLogPath 在同毫秒内被多次调用。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
    try {
      const s = new Session({ rootDir, id: 'same-ms' });
      const log0 = s.logFile;
      s.append({ role: 'user', content: 'r0' });

      s.clear();
      const log1 = s.logFile;
      s.append({ role: 'user', content: 'r1' });

      s.clear();
      const log2 = s.logFile;
      s.append({ role: 'user', content: 'r2' });

      // 三个路径互不相同（即便时间戳相同）
      expect(new Set([log0, log1, log2]).size).toBe(3);

      // 旧日志都保留且内容正确（不被覆盖/丢失）
      for (const [path, content] of [
        [log0, 'r0'],
        [log1, 'r1'],
        [log2, 'r2'],
      ] as const) {
        expect(existsSync(path)).toBe(true);
        const recs = readLog(path);
        expect(recs).toHaveLength(1);
        expect((recs[0].payload as { content: string }).content).toBe(content);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Session jsonl 持久化', () => {
  it('六类过程记录均落盘且可被重新读取解析', () => {
    const s = new Session({ rootDir, id: 'log' });

    // user
    s.append({ role: 'user', content: '改一下代码' });
    // assistant + tool_call（assistant 携带 toolCalls 会拆出独立 tool_call 行）
    s.append({
      role: 'assistant',
      content: '准备调用工具',
      toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'x.ts', content: 'y' } }],
    });
    // permission（仅落盘）
    s.logPermission({ toolCallId: 'c1', tool: 'write_file', effect: 'deny', reason: '用户拒绝' });
    // tool_result
    s.append({ role: 'tool', toolCallId: 'c1', content: '权限被拒绝', ok: false });
    // error（仅落盘）
    s.logError({ message: 'timeout', where: 'provider' });

    const records = readLog(s.logFile);
    const kinds = records.map((r) => r.kind);

    // 顺序：user → assistant → tool_call → permission → tool_result → error
    expect(kinds).toEqual([
      'user',
      'assistant',
      'tool_call',
      'permission',
      'tool_result',
      'error',
    ]);

    // 每条都带 ISO 时间戳
    for (const r of records) {
      expect(typeof r.ts).toBe('string');
      expect(Number.isNaN(Date.parse(r.ts))).toBe(false);
    }

    // tool_call 载荷完整
    const toolCall = records.find((r) => r.kind === 'tool_call')!;
    expect(toolCall.payload).toMatchObject({
      id: 'c1',
      name: 'write_file',
      args: { path: 'x.ts', content: 'y' },
    });

    // tool_result 含 ok=false（错误同样入记录）
    const toolResult = records.find((r) => r.kind === 'tool_result')!;
    expect(toolResult.payload).toMatchObject({ toolCallId: 'c1', ok: false });

    // permission / error 载荷正确
    expect(records.find((r) => r.kind === 'permission')!.payload).toMatchObject({
      effect: 'deny',
    });
    expect(records.find((r) => r.kind === 'error')!.payload).toMatchObject({
      message: 'timeout',
    });
  });

  it('日志文件落在 .ai_history/logs/ 下，文件名含 id 与 .jsonl 后缀', () => {
    const s = new Session({ rootDir, id: 'pathcheck' });
    s.append({ role: 'user', content: 'hi' });

    const expectedDir = join(rootDir, '.ai_history', 'logs');
    expect(s.logFile.startsWith(expectedDir)).toBe(true);
    expect(s.logFile.endsWith('-pathcheck.jsonl')).toBe(true);
  });

  it('逐条 append：每次 append 即追加一行', () => {
    const s = new Session({ rootDir, id: 'incr' });
    s.append({ role: 'user', content: 'a' });
    expect(readLog(s.logFile)).toHaveLength(1);
    s.append({ role: 'assistant', content: 'b' });
    expect(readLog(s.logFile)).toHaveLength(2);
  });
});
