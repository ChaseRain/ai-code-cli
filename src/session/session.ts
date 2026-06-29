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
  statSync,
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
  | 'summary'
  | 'checkpoint'
  | 'restore';

/**
 * 摘要器（记忆压缩用，见 product-specs/memory.md）。可注入：测试用 Mock，真实模型可选。
 * 输入较旧的若干消息，产出一段摘要文本；不抛异常由调用方保证（错误即数据）。
 */
export interface Summarizer {
  summarize(older: Message[], signal: AbortSignal): Promise<string>;
}

/** 压缩后注入的摘要消息前缀（便于识别 / memoryStats 判定 hasSummary）。 */
export const SUMMARY_PREFIX = '[此前对话摘要]\n';
export const DEFAULT_MEMORY_THRESHOLD_MSGS = 40;
export const DEFAULT_MEMORY_KEEP_RECENT = 16;
/** Phase-9 M2：token 预算默认值（与 config.md 一致）。 */
export const DEFAULT_MEMORY_THRESHOLD_TOKENS = 24000;
export const DEFAULT_MEMORY_KEEP_RECENT_TOKENS = 8000;
/** Phase-6 LH7：resume 日志大小硬上限（超过明确报错，不全量读入内存）。 */
export const MAX_RESUME_BYTES = 8 * 1024 * 1024;

/**
 * 单条消息的 token 估算（Phase-9 M2）：确定性近似，无需真实 tokenizer。
 * 规则：正文 chars/4，外加工具名 + 参数 JSON 长度的同等估算（工具调用/结果也吃 token）。
 * 仅用于「触发压缩」与「按预算保留近窗」的相对判据，不要求与真实计费严格一致。
 * 导出供测试与 maybeCompact 共用。
 */
export function estimateTokens(msg: Message): number {
  let chars = 0;
  switch (msg.role) {
    case 'system':
    case 'user':
      chars += msg.content.length;
      break;
    case 'assistant':
      chars += msg.content.length;
      for (const call of msg.toolCalls ?? []) {
        chars += call.name.length;
        try {
          chars += JSON.stringify(call.args ?? {}).length;
        } catch {
          // 参数不可序列化（极端情况）：给个保守常量，避免估算为 0。
          chars += 16;
        }
      }
      break;
    case 'tool':
      chars += msg.content.length + msg.toolCallId.length;
      break;
  }
  // 每条至少计 1 token（避免空消息被估为 0 导致预算判断失真）。
  return Math.max(1, Math.ceil(chars / 4));
}

/** 估算一组消息的累计 token。 */
export function estimateTokensTotal(messages: Message[]): number {
  let sum = 0;
  for (const m of messages) sum += estimateTokens(m);
  return sum;
}

/**
 * 默认本地摘要器：确定性、无网络依赖，供实时 Loop 自动压缩使用。
 * Phase-9 M4 增强：除消息计数 / 用户意图 / 工具列表外，额外保留高价值信息——
 *   ① 失败的工具结果（错误片段，截断）；② 最近成功的关键工具结果摘要；
 *   ③ 最后 2 条 assistant 推理要点；避免压缩把代码变更 / 决策 / 错误一并丢失。
 * 若 older 含「[需融合的既有摘要]」前缀的 system（来自 maybeCompact 融合），原样并入摘要顶部。
 */
export class HeuristicSummarizer implements Summarizer {
  async summarize(older: Message[], signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('memory compaction aborted');
    const counts = countRoles(older);

    // 既有摘要融合输入（maybeCompact 用 system 注入）——保留以维持「不丢历史摘要」。
    const priorSummary = older
      .filter((m) => m.role === 'system' && m.content.startsWith('[需融合的既有摘要]'))
      .map((m) => oneLine(m.content.replace(/^\[需融合的既有摘要\]\n?/, ''), 200))
      .join(' ');

    const userNotes = older
      .filter((m) => m.role === 'user')
      .map((m) => oneLine(m.content))
      .filter(Boolean)
      .slice(-3);

    const toolNotes = older
      .flatMap((m) =>
        m.role === 'assistant'
          ? (m.toolCalls ?? []).map((call) => `${call.name}(${call.id})`)
          : [],
      )
      .slice(-5);

    // 错误片段：失败的工具结果（错误即数据，最该留）。
    const errorNotes = older
      .filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool' && !m.ok)
      .map((m) => oneLine(m.content, 120))
      .filter(Boolean)
      .slice(-3);

    // 关键工具结果：成功的工具产出要点（写文件 / 命令输出等）。
    const okToolNotes = older
      .filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool' && m.ok)
      .map((m) => oneLine(m.content, 100))
      .filter(Boolean)
      .slice(-3);

    // 最后 2 条 assistant 推理要点（带文本的）。
    const lastAssistant = older
      .filter((m): m is Extract<Message, { role: 'assistant' }> => m.role === 'assistant' && !!m.content)
      .map((m) => oneLine(m.content, 120))
      .slice(-2);

    return [
      priorSummary ? `融合既有摘要：${priorSummary}` : '',
      `压缩了 ${older.filter((m) => m.role !== 'system' || !m.content.startsWith('[需融合的既有摘要]')).length} 条旧消息：user ${counts.user}，assistant ${counts.assistant}，tool ${counts.tool}。`,
      userNotes.length ? `近期用户意图：${userNotes.join(' / ')}` : '',
      toolNotes.length ? `涉及工具：${toolNotes.join(', ')}` : '',
      okToolNotes.length ? `关键工具结果：${okToolNotes.join(' | ')}` : '',
      errorNotes.length ? `错误片段：${errorNotes.join(' | ')}` : '',
      lastAssistant.length ? `最后推理：${lastAssistant.join(' / ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}

export function createHeuristicSummarizer(): Summarizer {
  return new HeuristicSummarizer();
}

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

function countRoles(messages: Message[]): { user: number; assistant: number; tool: number } {
  return {
    user: messages.filter((m) => m.role === 'user').length,
    assistant: messages.filter((m) => m.role === 'assistant').length,
    tool: messages.filter((m) => m.role === 'tool').length,
  };
}

function oneLine(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
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
  /** 日志路径唯一性兜底：上次时间戳与进程内单调序号（同毫秒冲突时递增）。 */
  private lastTs = '';
  private logSeq = 0;

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
    // LH7：先 stat，超上限明确报错，绝不把超大 jsonl 全量读入内存（防 OOM）。
    const size = statSync(logPath).size;
    if (size > MAX_RESUME_BYTES) {
      throw new Error(
        `会话日志过大（${size} bytes > ${MAX_RESUME_BYTES} 上限），无法恢复，请用 /sessions 查看摘要`,
      );
    }
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
          // 恢复压缩状态：把「前导真实 system 之后的 replaced 条旧消息」替换为摘要 system 消息（不丢摘要）。
          // 与 maybeCompact 一致：前导若是上一轮的 SUMMARY_PREFIX 摘要，不计入保留前缀——
          //   它属于被替换区段（融合），保证 replaced 计数与 splice 位置精确对齐。
          const replaced = Number(p.replaced ?? 0);
          const summary = String(p.summary ?? '');
          let sysCount = 0;
          while (
            sysCount < rebuilt.length &&
            rebuilt[sysCount].role === 'system' &&
            !(rebuilt[sysCount] as { content: string }).content.startsWith(SUMMARY_PREFIX)
          )
            sysCount++;
          const summaryMsg: Message = { role: 'system', content: SUMMARY_PREFIX + summary };
          rebuilt.splice(sysCount, replaced, summaryMsg);
          break;
        }
        // permission / error / checkpoint / restore：不进上下文，跳过。
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
   * 不变量（memory.md A1-A3 + Phase-9 M2/M3）：
   * - 不破坏 tool 配对：把切点回退到非 tool 消息，保证每个 tool_result 与其 assistant 同侧。
   * - system 永远在前：被压缩的是「前导 system 之后、近窗之前」的区段；摘要也以 system 注入头部。
   * - 近窗保真：默认按 keepRecent 条数保留；提供 keepRecentTokens 时按 token 预算保留近窗。
   * - 触发判据（向后兼容 + 叠加）：消息数 > thresholdMsgs **或** 估算 token > thresholdTokens（任一即触发）。
   *   未提供 token 预算 → 仅按消息数判据（与旧行为一致）。
   * - 防堆叠（M3）：被压缩区段若已含一条 SUMMARY_PREFIX 旧摘要，则把它从 older 中剔除、
   *   作为「旧摘要」一并交给摘要器融合重写，使历史中摘要 system 消息数 ≤ 2（融合后通常收敛为 1）。
   * 阈值未到 / 无可压缩区段 → no-op。
   */
  async maybeCompact(opts: {
    thresholdMsgs: number;
    keepRecent: number;
    thresholdTokens?: number;
    keepRecentTokens?: number;
    summarizer: Summarizer;
    signal?: AbortSignal;
  }): Promise<{ compacted: boolean; summary?: string }> {
    const { thresholdMsgs, keepRecent, thresholdTokens, keepRecentTokens, summarizer } = opts;
    const signal = opts.signal ?? new AbortController().signal;
    const h = this.history;

    // ── 触发判据：消息数 或 token 预算，任一超限即触发（M2 向后兼容）──────────
    const overMsgs = h.length > thresholdMsgs;
    const overTokens =
      typeof thresholdTokens === 'number' && estimateTokensTotal(h) > thresholdTokens;
    if (!overMsgs && !overTokens) return { compacted: false };

    // 前导「真实 system」区段始终保留（系统提示等）。
    // 注意（M3 防堆叠）：前导若是上一轮注入的 SUMMARY_PREFIX 摘要，**不**计入保留前缀——
    //   它要落进被压缩区段以便与新摘要融合，避免历史里摘要 system 线性堆叠。
    let sysCount = 0;
    while (
      sysCount < h.length &&
      h[sysCount].role === 'system' &&
      !(h[sysCount] as { content: string }).content.startsWith(SUMMARY_PREFIX)
    )
      sysCount++;

    // ── 近窗起点：默认按条数；提供 keepRecentTokens 时按 token 预算回推 ────────
    let boundary: number;
    if (typeof keepRecentTokens === 'number') {
      boundary = h.length;
      let acc = 0;
      while (boundary > sysCount) {
        const next = acc + estimateTokens(h[boundary - 1]);
        if (next > keepRecentTokens) break;
        acc = next;
        boundary--;
      }
    } else {
      boundary = h.length - keepRecent;
    }
    // 回退到非 tool 消息，避免把 tool_result 与其 assistant 切到两侧。
    while (boundary > sysCount && h[boundary]?.role === 'tool') boundary--;
    if (boundary <= sysCount) return { compacted: false };

    // ── 防堆叠融合（M3）：从被压缩区段剥离已有的旧摘要，单独交给摘要器融合 ─────
    const segment = h.slice(sysCount, boundary);
    const older = segment.filter(
      (m) => !(m.role === 'system' && m.content.startsWith(SUMMARY_PREFIX)),
    );
    const priorSummaries = segment
      .filter((m) => m.role === 'system' && m.content.startsWith(SUMMARY_PREFIX))
      .map((m) => m.content.slice(SUMMARY_PREFIX.length));
    if (older.length === 0 && priorSummaries.length === 0) return { compacted: false };

    // 融合：把旧摘要拼到 older 之前作为一条 system 上下文，让摘要器重写为单条。
    const toSummarize: Message[] = priorSummaries.length
      ? [
          {
            role: 'system',
            content: `[需融合的既有摘要]\n${priorSummaries.join('\n---\n')}`,
          },
          ...older,
        ]
      : older;

    const summary = await summarizer.summarize(toSummarize, signal);
    const summaryMsg: Message = { role: 'system', content: SUMMARY_PREFIX + summary };
    this.history = [...h.slice(0, sysCount), summaryMsg, ...h.slice(boundary)];
    // replaced 记被替换的整段（含旧摘要），保证 resume 能精确还原压缩态。
    this.writeLog('summary', { summary, replaced: segment.length });
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

  /** 记录 checkpoint 事件。过程记录只落 jsonl，不进入 provider messages 上下文。 */
  logCheckpoint(payload: unknown): void {
    this.writeLog('checkpoint', payload);
  }

  /** 记录 restore 事件。过程记录只落 jsonl，不进入 provider messages 上下文。 */
  logRestore(payload: unknown): void {
    this.writeLog('restore', payload);
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 当前日志文件绝对路径（测试/复盘用）。 */
  get logFile(): string {
    return this.logPath;
  }

  /**
   * 生成一个新日志文件路径：`<rootDir>/.ai_history/logs/<timestamp>-<id>[-<seq>].jsonl`。
   * 唯一性不变量（见 session-context.md）：同一进程内每次调用都返回唯一路径——
   * 当时间戳分辨率不足（同一毫秒内连续 clear）时，用进程内单调序号兜底，
   * 序号置于时间戳之后，保持文件名「时间戳在前」可排序、历史文件无需迁移。
   */
  private newLogPath(): string {
    const ts = fileTimestamp(new Date());
    let name: string;
    if (ts === this.lastTs) {
      this.logSeq += 1;
      name = `${ts}-${this.id}-${this.logSeq}.jsonl`;
    } else {
      this.lastTs = ts;
      this.logSeq = 0;
      name = `${ts}-${this.id}.jsonl`;
    }
    return join(this.rootDir, '.ai_history', 'logs', name);
  }

  /** 逐条 append 一行 jsonl（目录按需创建）。同步写入，确保即时持久化。 */
  private writeLog(kind: LogKind, payload: unknown): void {
    const record: LogRecord = { ts: new Date().toISOString(), kind, payload };
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8');
  }
}
