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

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Message } from '../core/types.js';

/** 日志事件类型 —— 覆盖 spec 要求的六类过程记录。 */
export type LogKind =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'permission'
  | 'error';

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

  // ── 仅落盘的过程记录（不进喂模型的内存上下文）─────────────────────────

  /**
   * 记录一次权限决策（通常是拒绝）。属交付级过程记录，只落 jsonl。
   * 注意：被拒绝后给模型的「拒绝结果」应由 Loop 以 tool 结果（append）回喂上下文，
   * 这里只负责把「发生过一次权限事件」沉淀到日志。
   */
  logPermission(payload: {
    toolCallId?: string;
    tool?: string;
    effect: 'allow' | 'deny';
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
