// src/session/browser.ts
// Session Browser 读侧：从 .ai_history/logs/*.jsonl 解析摘要，不改变 Session 写入格式。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { LogRecord } from './session.js';

/** Phase-6 LH7：summarizeLog 全量读取上限；超过则不读内容，仅给 stat 摘要 + warning。 */
export const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;

export interface SessionSummary {
  id: string;
  logPath: string;
  startedAt: string;
  updatedAt: string;
  title: string;
  messages: number;
  toolCalls: number;
  current: boolean;
  warnings: number;
}

export interface ListSessionsOptions {
  /** 最多返回/读取的会话数；缺省读取全部（向后兼容）。`/sessions` 默认传 50。 */
  limit?: number;
}

/**
 * 列出本地会话摘要。Phase-6 LH3 容量硬化：
 * 文件名以 ISO 时间戳起头，按名倒序≈时间倒序；给定 `limit` 时**先选候选再读取**，
 * 只对最近 N 个日志做 readFileSync，避免 2 万+ 日志全量同步读取阻塞 TUI。
 */
export function listSessions(
  rootDir: string,
  currentLog?: string,
  opts: ListSessionsOptions = {},
): SessionSummary[] {
  const dir = path.join(rootDir, '.ai_history', 'logs');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  // 先按文件名倒序选候选（不读取内容），limit 时只取最近 N 个再解析。
  names.sort((a, b) => b.localeCompare(a));
  const candidates =
    typeof opts.limit === 'number' ? names.slice(0, Math.max(0, opts.limit)) : names;
  return candidates
    .map((name) => summarizeLog(path.join(dir, name), currentLog))
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * 定位会话日志。LH7：**只基于文件名**（id 即文件 basename），不读取/解析任何日志内容，
 * 因此在 2 万+ 日志下也不会退化为全量 summarize。
 */
export function resolveSessionLog(rootDir: string, target: string, currentLog?: string): string | null {
  const dir = path.join(rootDir, '.ai_history', 'logs');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    names = [];
  }
  names.sort((a, b) => b.localeCompare(a)); // 文件名时间前缀，倒序≈最新在前
  const base = (n: string): string => n.replace(/\.jsonl$/, '');
  const toPath = (n: string): string => path.join(dir, n);

  if (target === 'latest') {
    for (const n of names) {
      const p = toPath(n);
      if (p !== currentLog) return p; // 最新且非当前会话
    }
    return null;
  }
  const exact = names.find((n) => base(n) === target);
  if (exact) return toPath(exact);
  const prefix = names.find((n) => base(n).startsWith(target));
  if (prefix) return toPath(prefix);
  const suffix = names.find((n) => base(n).endsWith(target));
  if (suffix) return toPath(suffix);
  // Backward compatibility: /resume <path>
  if (target.endsWith('.jsonl')) return target;
  return null;
}

export function summarizeLog(logPath: string, currentLog?: string): SessionSummary | null {
  const id = path.basename(logPath, '.jsonl');

  // LH7：先 stat；超大日志不全量读，给 stat 摘要 + warning（避免阻塞/占内存）。
  let stat: import('node:fs').Stats;
  try {
    stat = statSync(logPath);
  } catch {
    return null;
  }
  if (stat.size > MAX_SUMMARY_BYTES) {
    const ts = stat.mtime.toISOString();
    return {
      id,
      logPath,
      startedAt: ts,
      updatedAt: ts,
      title: `（日志过大 ${stat.size} bytes，未解析）`,
      messages: 0,
      toolCalls: 0,
      current: currentLog === logPath,
      warnings: 1,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  let startedAt = '';
  let updatedAt = '';
  let title = '';
  let messages = 0;
  let toolCalls = 0;
  let warnings = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: LogRecord;
    try {
      rec = JSON.parse(line) as LogRecord;
    } catch {
      warnings++;
      continue;
    }
    startedAt ||= rec.ts;
    updatedAt = rec.ts || updatedAt;
    if (rec.kind === 'tool_call') toolCalls++;
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    const isSystemRecord = rec.kind === 'user' && typeof p.system === 'string';
    if (!isSystemRecord && (rec.kind === 'user' || rec.kind === 'assistant' || rec.kind === 'tool_result')) {
      messages++;
    }
    if (!title && rec.kind === 'user') {
      if (typeof p.content === 'string') title = compactTitle(p.content);
    }
  }

  if (!updatedAt) {
    try {
      updatedAt = statSync(logPath).mtime.toISOString();
      startedAt ||= updatedAt;
    } catch {
      return null;
    }
  }

  return {
    id,
    logPath,
    startedAt,
    updatedAt,
    title: title || id,
    messages,
    toolCalls,
    current: currentLog === logPath,
    warnings,
  };
}

function compactTitle(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 48 ? oneLine.slice(0, 45) + '...' : oneLine;
}
