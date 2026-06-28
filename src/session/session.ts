// src/session/session.ts
// Session 聚合根 —— 见 docs/product-specs/session-context.md、domain-model.md。
// 职责：① 内存多轮历史 append/clear/messages；② 全要素逐条 append 到 jsonl 日志。
//
// 设计要点（core-beliefs：less is more / 错误即数据 / 上下文刻意管理）：
// - 内存历史只装 types.ts 的 Message（4 种 role），它就是喂给 Provider 的上下文。
// - 但「全要素入历史」里的 permission（权限拒绝）与 error（错误）不是 Message role，
//   它们是交付物级别的过程记录，只落 jsonl、不进喂模型的上下文，避免污染 context。
//   故日志记录类型 LogRecord 比 Message 更宽。
// - 落盘是「逐条 append」：每次 append 同步追加一行 JSON（jsonl），即时持久化、可复盘。

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { Message } from '../core/types.js';

/** 日志事件类型 —— 覆盖 spec 要求的六类过程记录 + 记忆压缩 summary。 */
export type LogKind =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'permission'
  | 'error'
  | 'summary';

/**
 * 摘要器（记忆压缩用，见 product-specs/memory.md）。可注入：测试用 Mock，真实模型可选。
 * 输入较旧的若干消息，产出一段摘要文本；不抛异常由调用方保证（错误即数据）。
 */
export interface Summarizer {
  summarize(older: Message[], signal: AbortSignal): Promise<string>;
}

/** 压缩后注入的摘要消息前缀（便于识别 / memoryStats 判定 hasSummary）。 */
export const SUMMARY_PREFIX = '[此前对话摘要]\n';

/**
 * jsonl 落盘的一行。统一信封：ts（ISO 时间戳）+ kind + payload。
 * payload 形态随 kind 而定，保持宽松以容纳各类过程数据。
 */
export interface LogRecord {
  ts: string;
  kind: LogKind;
  payload: unknown;
}

/** Session 构造选项。 */
export interface SessionOptions {
  /** 项目根；日志写到 <rootDir>/.ai_history/logs/ 下。默认 process.cwd()。 */
  rootDir?: string;
  /** 会话 id；用于日志文件名。默认随机短 id。 */
  id?: string;
}

/** 生成短随机 id（无外部依赖，够用即可）。 */
function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 文件名安全的时间戳：2026-06-27T12-05-03-123Z。 */
function fileTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Session：会话聚合根。
 * - 内存历史 = messages()，喂给 Provider 的唯一上下文。
 * - 每个会话一个 jsonl 日志文件；append* 系列即时追加一行。
 * - clear() 清空内存并开新日志文件（对应 /clear）。
 */
export class Session {
  readonly id: string;
  readonly rootDir: string;

  /** 内存历史（顺序即对话顺序）。 */
  private history: Message[] = [];
  /** 当前会话日志文件绝对路径。 */
  private logPath: string;

  constructor(opts: SessionOptions = {}) {
    this.rootDir = opts.rootDir ?? process.cwd();
    this.id = opts.id ?? shortId();
    this.logPath = this.newLogPath();
  }

  // ── 内存历史 ───────────────────────────────────────────────────────────

  /**
   * 追加一条消息：同时写入内存历史与 jsonl。
   * role → LogKind 的映射：assistant 携带 toolCalls 时拆出 tool_call 记录，
   * 以满足 spec「tool_call 入历史」；assistant 文本本身仍记为 assistant。
   */
  append(msg: Message): void {
    this.history.push(msg);

    switch (msg.role) {
      case 'user':
        this.writeLog('user', { content: msg.content });
        break;
      case 'system':
        // system 提示不属于六类过程记录，但仍落盘以便复盘（归到 user 信封外的独立处理）。
        this.writeLog('user', { system: msg.content });
        break;
      case 'assistant':
        this.writeLog('assistant', { content: msg.content });
        // 工具调用单独成行，便于复盘时与 tool_result 对齐。
        if (msg.toolCalls?.length) {
          for (const call of msg.toolCalls) {
            this.writeLog('tool_call', {
              id: call.id,
              name: call.name,
              args: call.args,
            });
          }
        }
        break;
      case 'tool':
        this.writeLog('tool_result', {
          toolCallId: msg.toolCallId,
          ok: msg.ok,
          content: msg.content,
        });
        break;
    }
  }

  /** 返回内存历史的浅拷贝（防止外部直接篡改内部数组）。 */
  messages(): Message[] {
    return [...this.history];
  }

  /**
   * 清空内存上下文并开启新日志文件（对应 `/clear`）。
   * 旧日志文件原样保留在磁盘上，作为交付记录。
   */
  clear(): void {
    this.history = [];
    this.logPath = this.newLogPath();
  }

  // ── 记忆增强：会话恢复 / 上下文压缩（见 product-specs/memory.md）────────

  /**
   * 从一个 jsonl 日志文件恢复内存历史（resume）。
   * 重建规则（保持顺序与 tool 配对）：
   * - user：payload.system → system 消息；否则 user 消息。
   * - assistant：assistant 文本消息。
   * - tool_call：挂回「最近一条 assistant」的 toolCalls（与落盘时的拆分互逆）。
   * - tool_result：还原为 tool 消息。
   * - summary：按 payload.replaced 把前导 system 后的旧消息段替换为摘要 system 消息，恢复压缩态。
   * - permission / error：跳过（不属于喂模型的上下文）。
   * 恢复只改内存历史；新消息仍写入当前（新）日志文件，不污染被恢复的旧日志。
   */
  resumeFrom(logPath: string): { restored: number } {
    const raw = readFileSync(logPath, 'utf8');
    const rebuilt: Message[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(line) as LogRecord;
      } catch {
        continue; // 容错：坏行跳过，不崩溃。
      }
      const p = (rec.payload ?? {}) as Record<string, unknown>;
      switch (rec.kind) {
        case 'user':
          if (typeof p.system === 'string') {
            rebuilt.push({ role: 'system', content: p.system });
          } else {
            rebuilt.push({ role: 'user', content: String(p.content ?? '') });
          }
          break;
        case 'assistant':
          rebuilt.push({ role: 'assistant', content: String(p.content ?? '') });
          break;
        case 'tool_call': {
          const last = rebuilt[rebuilt.length - 1];
          if (last && last.role === 'assistant') {
            const call = { id: String(p.id ?? ''), name: String(p.name ?? ''), args: p.args };
            last.toolCalls = [...(last.toolCalls ?? []), call];
          }
          break;
        }
        case 'tool_result':
          rebuilt.push({
            role: 'tool',
            toolCallId: String(p.toolCallId ?? ''),
            content: String(p.content ?? ''),
            ok: Boolean(p.ok),
          });
          break;
        case 'summary': {
          // 恢复压缩状态：把「前导 system 之后的 replaced 条旧消息」替换为摘要 system 消息（不丢摘要）。
          const replaced = Number(p.replaced ?? 0);
          const summary = String(p.summary ?? '');
          let sysCount = 0;
          while (sysCount < rebuilt.length && rebuilt[sysCount].role === 'system') sysCount++;
          const summaryMsg: Message = { role: 'system', content: SUMMARY_PREFIX + summary };
          rebuilt.splice(sysCount, replaced, summaryMsg);
          break;
        }
        // permission / error：不进上下文，跳过。
      }
    }
    this.history = rebuilt;
    return { restored: rebuilt.length };
  }

  /**
   * 找最近一次会话日志（按文件名时间戳倒序）。供 `/resume` 默认目标。
   * exclude：排除某个文件（通常是当前会话自身的日志）。无则返回 null。
   */
  static findLatestLog(rootDir: string, exclude?: string): string | null {
    const dir = join(rootDir, '.ai_history', 'logs');
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return null;
    }
    names.sort(); // 文件名以 ISO 时间戳起头，字典序即时间序。
    for (let i = names.length - 1; i >= 0; i--) {
      const full = join(dir, names[i]);
      if (exclude && full === exclude) continue;
      return full;
    }
    return null;
  }

  /**
   * 上下文压缩：历史超阈值时，把较旧消息摘要为一条 system 消息，保留 system 头与近窗。
   * 不变量（memory.md A1-A3）：
   * - 不破坏 tool 配对：把切点回退到非 tool 消息，保证每个 tool_result 与其 assistant 同侧。
   * - system 永远在前：被压缩的是「前导 system 之后、近窗之前」的区段；摘要也以 system 注入头部。
   * - 近窗保真：最后 keepRecent 条原样保留（实际可能更多，keepRecent 为下限）。
   * 阈值未到 / 无可压缩区段 → no-op。
   */
  async maybeCompact(opts: {
    thresholdMsgs: number;
    keepRecent: number;
    summarizer: Summarizer;
    signal?: AbortSignal;
  }): Promise<{ compacted: boolean; summary?: string }> {
    const { thresholdMsgs, keepRecent, summarizer } = opts;
    const signal = opts.signal ?? new AbortController().signal;
    const h = this.history;
    if (h.length <= thresholdMsgs) return { compacted: false };

    // 前导 system 区段始终保留。
    let sysCount = 0;
    while (sysCount < h.length && h[sysCount].role === 'system') sysCount++;

    // 近窗起点；回退到非 tool 消息，避免把 tool_result 与其 assistant 切到两侧。
    let boundary = h.length - keepRecent;
    while (boundary > sysCount && h[boundary]?.role === 'tool') boundary--;
    if (boundary <= sysCount) return { compacted: false };

    const older = h.slice(sysCount, boundary);
    if (older.length === 0) return { compacted: false };

    const summary = await summarizer.summarize(older, signal);
    const summaryMsg: Message = { role: 'system', content: SUMMARY_PREFIX + summary };
    this.history = [...h.slice(0, sysCount), summaryMsg, ...h.slice(boundary)];
    this.writeLog('summary', { summary, replaced: older.length });
    return { compacted: true, summary };
  }

  /** 记忆状态快照（供 `/memory` 展示）。 */
  memoryStats(): {
    messages: number;
    system: number;
    hasSummary: boolean;
    logFile: string;
  } {
    return {
      messages: this.history.length,
      system: this.history.filter((m) => m.role === 'system').length,
      hasSummary: this.history.some(
        (m) => m.role === 'system' && m.content.startsWith(SUMMARY_PREFIX),
      ),
      logFile: this.logPath,
    };
  }

  // ── 仅落盘的过程记录（不进喂模型的内存上下文）─────────────────────────

  /**
   * 记录一次权限决策（通常是拒绝）。属交付级过程记录，只落 jsonl。
   * 注意：被拒绝后给模型的「拒绝结果」应由 Loop 以 tool 结果（append）回喂上下文，
   * 这里只负责把「发生过一次权限事件」沉淀到日志。
   */
  logPermission(payload: {
    toolCallId?: string;
    tool?: string;
    // allow=敏感操作经用户授权；deny=用户拒绝；auto_allow=只读工具自动放行（非用户授权，避免混淆）
    effect: 'allow' | 'deny' | 'auto_allow';
    reason?: string;
  }): void {
    this.writeLog('permission', payload);
  }

  /** 记录一次错误（超时、解析失败等）。错误即数据，沉淀到 jsonl。 */
  logError(payload: { message: string; where?: string; detail?: unknown }): void {
    this.writeLog('error', payload);
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 当前日志文件绝对路径（测试/复盘用）。 */
  get logFile(): string {
    return this.logPath;
  }

  /** 生成一个新日志文件路径：<rootDir>/.ai_history/logs/<timestamp>-<id>.jsonl。 */
  private newLogPath(): string {
    const name = `${fileTimestamp(new Date())}-${this.id}.jsonl`;
    return join(this.rootDir, '.ai_history', 'logs', name);
  }

  /** 逐条 append 一行 jsonl（目录按需创建）。同步写入，确保即时持久化。 */
  private writeLog(kind: LogKind, payload: unknown): void {
    const record: LogRecord = { ts: new Date().toISOString(), kind, payload };
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8');
  }
}
