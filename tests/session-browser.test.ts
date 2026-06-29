// tests/session-browser.test.ts
// M7 Session Browser：从 jsonl 解析会话摘要，支持 latest/id 定位，不展示 system prompt。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Session } from '../src/session/index.js';
import { listSessions, resolveSessionLog, summarizeLog } from '../src/session/browser.js';

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'session-browser-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('Session Browser', () => {
  it('解析多个 jsonl 摘要：title 来自首条 user，不展示 system prompt', () => {
    const s1 = new Session({ rootDir, id: 'one' });
    s1.append({ role: 'system', content: 'SECRET SYSTEM PROMPT' });
    s1.append({ role: 'user', content: '帮我修复一个很长很长的问题描述，需要截断标题' });
    s1.append({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }],
    });
    s1.append({ role: 'tool', toolCallId: 't1', content: 'ok', ok: true });

    const s2 = new Session({ rootDir, id: 'two' });
    s2.append({ role: 'user', content: '第二个会话' });

    const summaries = listSessions(rootDir);
    expect(summaries).toHaveLength(2);
    const first = summaries.find((s) => s.id.endsWith('one'));
    expect(first?.title).toContain('帮我修复');
    expect(first?.title).not.toContain('SECRET');
    expect(first?.messages).toBe(3);
    expect(first?.toolCalls).toBe(1);
  });

  it('resolve latest/id/prefix，且保留 /resume <path> 兼容', () => {
    const older = new Session({ rootDir, id: 'older' });
    older.append({ role: 'user', content: 'old' });
    const newer = new Session({ rootDir, id: 'newer' });
    newer.append({ role: 'user', content: 'new' });

    expect(resolveSessionLog(rootDir, 'latest', newer.logFile)).toBe(older.logFile);
    const id = newer.logFile.split('/').pop()!.replace(/\.jsonl$/, '');
    expect(resolveSessionLog(rootDir, id, undefined)).toBe(newer.logFile);
    expect(resolveSessionLog(rootDir, 'newer', undefined)).toBe(newer.logFile);
    expect(resolveSessionLog(rootDir, newer.logFile, undefined)).toBe(newer.logFile);
  });

  it('坏 jsonl 行不阻断摘要解析，记录 warnings', () => {
    const s = new Session({ rootDir, id: 'bad' });
    s.append({ role: 'user', content: 'ok' });
    appendFileSync(s.logFile, '{bad json}\n', 'utf8');
    const summary = summarizeLog(s.logFile);
    expect(summary?.warnings).toBe(1);
    expect(summary?.title).toBe('ok');
  });

  // Phase-6 LH3：limit 只返回并只读取最近 N 个日志（旧/坏日志不被解析）
  it('P6-A3：listSessions limit 只读最近 50 个，旧日志不解析', () => {
    const dir = join(rootDir, '.ai_history', 'logs');
    mkdirSync(dir, { recursive: true });
    const valid =
      JSON.stringify({ ts: '2026-06-28T00:00:00.000Z', kind: 'user', payload: { content: 'hi' } }) + '\n';
    // 50 个「最近」日志（2026，合法）
    for (let i = 0; i < 50; i++) {
      const n = String(i).padStart(3, '0');
      writeFileSync(join(dir, `2026-06-28T00-00-${n}-recent${n}.jsonl`), valid);
    }
    // 70 个「更旧」日志（2025，坏 JSON）——若被读取会产生 warnings
    for (let i = 0; i < 70; i++) {
      const n = String(i).padStart(3, '0');
      writeFileSync(join(dir, `2025-01-01T00-00-${n}-old${n}.jsonl`), '{bad json}\n');
    }

    const limited = listSessions(rootDir, undefined, { limit: 50 });
    expect(limited).toHaveLength(50);
    // 只读了最近 50 个合法日志：无 warnings、不含任何 old
    expect(limited.every((s) => s.warnings === 0)).toBe(true);
    expect(limited.some((s) => s.id.includes('old'))).toBe(false);

    // 不带 limit 时仍读取全部（向后兼容对照）
    expect(listSessions(rootDir).length).toBe(120);
  });

  // Phase-6 LH7：超大日志 summarize 先 stat、不全量读、warnings>0
  it('P6-B5：超大日志不被全量解析，给 warning + 标题提示', () => {
    const dir = join(rootDir, '.ai_history', 'logs');
    mkdirSync(dir, { recursive: true });
    const big = join(dir, '2026-06-28T00-00-00-000Z-huge.jsonl');
    // > 2 MiB（MAX_SUMMARY_BYTES）。内容是坏 JSON：若被全量解析会产生大量 warnings；这里应直接跳过解析。
    writeFileSync(big, 'x'.repeat(3 * 1024 * 1024));
    const s = summarizeLog(big);
    expect(s).not.toBeNull();
    expect(s?.warnings).toBe(1); // 仅 1（stat 跳过），而非逐行解析的海量 warning
    expect(s?.messages).toBe(0);
    expect(s?.title).toContain('日志过大');
  });

  // Phase-6 LH7：resolveSessionLog 走文件名快速路径，存在超大/坏日志也不解析、不抛
  it('P6-B7：resolveSessionLog latest/id 基于文件名，不解析内容', () => {
    const dir = join(rootDir, '.ai_history', 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-06-28T00-00-00-000Z-aaa.jsonl'), 'x'.repeat(3 * 1024 * 1024)); // 超大坏日志
    writeFileSync(join(dir, '2026-06-28T00-00-01-000Z-bbb.jsonl'), '{bad}\n');

    // latest（非当前）应是文件名最新的 bbb，且不抛、不解析
    expect(resolveSessionLog(rootDir, 'latest')).toBe(join(dir, '2026-06-28T00-00-01-000Z-bbb.jsonl'));
    // 按 id 后缀定位 aaa（基于文件名）
    expect(resolveSessionLog(rootDir, 'aaa')).toBe(join(dir, '2026-06-28T00-00-00-000Z-aaa.jsonl'));
  });
});
