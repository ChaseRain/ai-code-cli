// src/agent/loop.ts
// Agent Loop —— 集成层「编排器」。把 Provider / Tools / Permission / Session 串成
// 一条清晰的「决策→工具→结果→再决策」主循环（flows.md 主时序）。
//
// 设计纪律（core-beliefs B）：
// - B1 循环极简且可观测：每一步通过 onEvent 向 UI 暴露（文本增量 / 工具事件 / 状态）。
// - B4 错误即数据：工具失败、权限拒绝、致命错误都转成结构化结果或事件，不崩溃。
// - B5 模型决策 / harness 守护：maxTurns / abort / 权限确认由本层强制，模型无法绕过。
// 依赖规则（ARCHITECTURE）：本层只编排，不直接做 HTTP / 文件 IO / 渲染——
//   IO 全部委托给注入的 deps（provider.chat / tools.execute / session.append / permission.check）。

import type {
  Message,
  Provider,
  ProviderEvent,
  ToolCall,
  ToolResult,
} from '../core/types.js';
import type { ToolRegistry } from '../tools/index.js';
import type { Permission } from '../permission/index.js';
import { denialResult } from '../permission/index.js';
import type { Session } from '../session/index.js';
import type { Summarizer } from '../session/index.js';
import type { CheckpointStore } from '../checkpoint/index.js';
import { checkpointTargetsForTool } from '../checkpoint/index.js';
import { previewToolChange } from '../workspace/index.js';

// ============================================================================
// UI 事件契约 —— Loop 是唯一生产者，TUI 是消费者。
// 放在 agent 层（而非 core/types）：它是「编排层 → 渲染层」的私有协议，
// provider/tools 不需要认识它，符合「上下文刻意管理 + 单一真相来源」。
// ============================================================================

/** Loop 运行时的状态机阶段（与 tui.md 状态栏一致）。 */
export type AgentPhase =
  | 'idle' // 空闲（一轮任务结束）
  | 'thinking' // 等待 / 接收模型流式输出
  | 'calling-tool' // 正在执行工具
  | 'awaiting-permission'; // 阻塞等待用户权限决策

/**
 * Loop 向 UI 发出的事件（判别联合）。覆盖：状态切换、文本增量、
 * 工具调用生命周期、最终回复、错误。UI 据此渲染消息流与状态栏。
 */
export type UIEvent =
  // 状态机切换：UI 更新状态栏；turn 为当前轮次（从 1 开始），maxTurns 为上限。
  | { type: 'phase'; phase: AgentPhase; turn: number; maxTurns: number }
  // assistant 文本增量（流式）。
  | { type: 'assistant_delta'; delta: string }
  // 本轮 assistant 文本结束（一段完整回复定型，便于 UI 收口该气泡）。
  | { type: 'assistant_done'; content: string }
  // 模型决定调用某工具（参数已拼接完整）。
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  // 敏感工具执行前的变更预览摘要；用于权限确认前提示用户。
  | { type: 'tool_preview'; id: string; name: string; content: string }
  // 自动记忆压缩结果；成功/失败都可观测，但失败不阻断 Loop。
  | { type: 'memory_compacted'; compacted: boolean; content: string }
  // 工具执行结果（成功或失败 / 权限拒绝，皆为数据）。
  | { type: 'tool_result'; id: string; name: string; result: ToolResult }
  // 致命错误（如 Provider 不可恢复异常）：UI 提示，循环收尾。
  | { type: 'error'; message: string }
  // 整个 runAgent 结束及原因（最终回复 / 触顶 / 中断 / 错误）。
  | { type: 'end'; reason: EndReason };

/** runAgent 的终止原因。 */
export type EndReason = 'final' | 'max_turns' | 'aborted' | 'error';

// ============================================================================
// 依赖与运行选项
// ============================================================================

/** Loop 编排所需的四件套（全部注入，便于测试替换为 Mock）。 */
export interface AgentDeps {
  provider: Provider;
  tools: ToolRegistry;
  permission: Permission;
  session: Session;
  checkpoint?: CheckpointStore;
  memory?: MemoryCompactionOptions;
}

export interface MemoryCompactionOptions {
  thresholdMsgs: number;
  keepRecent: number;
  /** token 预算触发阈值（Phase-9 M2，可选；提供时与消息数判据叠加）。 */
  thresholdTokens?: number;
  /** 近窗保留 token 预算（Phase-9 M2，可选；提供时按 token 而非条数保留近窗）。 */
  keepRecentTokens?: number;
  summarizer: Summarizer;
}

/** 单次 runAgent 的运行参数。 */
export interface RunOpts {
  /**
   * 模型 id（来自 Config.model，可被 /model 切换）。
   * 随每次请求传给 Provider（ChatRequest.model 是协议必填项）。
   * 放在 RunOpts 而非 AgentDeps：它是「每次运行可变」的 harness 参数，Loop 不持有 Config。
   */
  model: string;
  /** 最大轮次守护栏（来自 Config.maxTurns）。 */
  maxTurns: number;
  /** 取消信号：用户中断 / 进程退出时触发。 */
  signal: AbortSignal;
  /** UI 事件回调（同步即可；UI 内部决定如何调度渲染）。 */
  onEvent: (e: UIEvent) => void;
}

// ============================================================================
// 内部：累积一次 provider.chat 流的产物
// ============================================================================

/** 工具调用累积器：tool_call(start) 起一个块，后续空 id 的 argsDelta 拼接到当前块。 */
interface ToolCallAccum {
  id: string;
  name: string;
  argsJson: string;
}

/** 一次模型回合的解析结果。 */
interface TurnOutcome {
  /** assistant 文本（流式拼接后的完整文本）。 */
  text: string;
  /** 解析出的工具调用（参数已 JSON.parse；解析失败的单独标记）。 */
  toolCalls: ToolCall[];
  /** 终止原因（来自 done 事件）。 */
  finishReason: 'stop' | 'tool_calls' | 'length';
}

/**
 * 消费一次 provider.chat 事件流，拼接文本与工具调用。
 * 流式文本通过 onText 实时外发；工具参数累积为 JSON 字符串，结束时统一 parse。
 */
async function consumeStream(
  stream: AsyncIterable<ProviderEvent>,
  onText: (delta: string) => void,
): Promise<TurnOutcome> {
  let text = '';
  // 顺序保持：用数组而非 Map，模型可能在一回合里发多个 tool_use。
  const accums: ToolCallAccum[] = [];
  let current: ToolCallAccum | undefined;
  let finishReason: TurnOutcome['finishReason'] = 'stop';

  for await (const ev of stream) {
    switch (ev.type) {
      case 'text':
        text += ev.delta;
        onText(ev.delta);
        break;
      case 'tool_call':
        if (ev.id) {
          // 新工具块开始（带 id/name）。
          current = { id: ev.id, name: ev.name, argsJson: '' };
          accums.push(current);
          if (ev.argsDelta) current.argsJson += ev.argsDelta;
        } else if (current) {
          // 参数增量（input_json_delta），拼到当前块。
          current.argsJson += ev.argsDelta;
        }
        break;
      case 'tool_call_done':
        // 块结束；当前块定型，后续若再有块会重新 start。
        current = undefined;
        break;
      case 'usage':
        // 用量统计：首期不进上下文，忽略（未来可外发给状态栏）。
        break;
      case 'done':
        finishReason = ev.finishReason;
        break;
    }
  }

  const toolCalls: ToolCall[] = accums.map((a) => ({
    id: a.id,
    name: a.name,
    args: parseArgs(a.argsJson),
  }));

  return { text, toolCalls, finishReason };
}

/** 宽松解析工具参数：空串视为无参 {}；非法 JSON 收敛为特殊标记对象（错误即数据）。 */
function parseArgs(json: string): unknown {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // 不抛异常：把「参数解析失败」作为数据带下去，工具校验会给出失败结果。
    return { __parseError: true, raw: trimmed };
  }
}

// ============================================================================
// 主入口：runAgent
// ============================================================================

/**
 * 运行一次完整任务的 Agent Loop。
 *
 * 时序（flows.md）：
 *   append(user) → for turn in 1..maxTurns:
 *     provider.chat(messages, schemas) → 累积文本/tool_calls（流式外发）
 *     若无 tool_call：append(assistant 文本) → 完成(final)
 *     否则：append(assistant + toolCalls)，逐个工具：
 *       permission.check → allow ? tools.execute : 拒绝结果
 *       append(tool 结果)  // 成功/失败/拒绝皆入上下文
 *     继续下一轮
 *   触顶 maxTurns / abort / 致命错误 → 优雅收尾。
 *
 * 不抛异常：所有失败转成 UIEvent + 会话日志（错误即数据）。
 */
export async function runAgent(
  input: string,
  deps: AgentDeps,
  opts: RunOpts,
): Promise<void> {
  const { provider, tools, permission, session, checkpoint, memory } = deps;
  const { model, maxTurns, signal, onEvent } = opts;

  // 用户输入入历史（同时落 jsonl）。
  session.append({ role: 'user', content: input });

  // 已中断则直接收尾（守护栏前置）。
  if (signal.aborted) {
    onEvent({ type: 'end', reason: 'aborted' });
    return;
  }

  const schemas = tools.toSchemas();

  for (let turn = 1; turn <= maxTurns; turn++) {
    onEvent({ type: 'phase', phase: 'thinking', turn, maxTurns });
    await maybeCompactMemory(session, memory, signal, onEvent);

    // ── 1. 决策：调用模型，流式累积 ──────────────────────────────────────
    let outcome: TurnOutcome;
    try {
      const stream = provider.chat({
        model, // 来自 RunOpts（Config.model 或 /model 切换值）。
        messages: session.messages(),
        tools: schemas,
        signal,
      });
      outcome = await consumeStream(stream, (delta) =>
        onEvent({ type: 'assistant_delta', delta }),
      );
    } catch (err) {
      // 中断与致命错误区分：abort 是预期收尾，其余是 error。
      if (isAbort(err, signal)) {
        session.logError({ message: 'aborted', where: 'provider.chat' });
        onEvent({ type: 'end', reason: 'aborted' });
        return;
      }
      const message = (err as Error)?.message ?? String(err);
      session.logError({ message, where: 'provider.chat' });
      onEvent({ type: 'error', message });
      onEvent({ type: 'end', reason: 'error' });
      return;
    }

    // 中断检查：流可能正常结束但用户已请求中断。
    if (signal.aborted) {
      onEvent({ type: 'end', reason: 'aborted' });
      return;
    }

    // ── 2. 无工具调用 → 最终回复，结束 ──────────────────────────────────
    if (outcome.toolCalls.length === 0) {
      session.append({ role: 'assistant', content: outcome.text });
      onEvent({ type: 'assistant_done', content: outcome.text });
      onEvent({ type: 'phase', phase: 'idle', turn, maxTurns });
      onEvent({ type: 'end', reason: 'final' });
      return;
    }

    // ── 3. 有工具调用 → assistant(含 toolCalls) 入历史，逐个执行 ──────────
    const assistantMsg: Message = {
      role: 'assistant',
      content: outcome.text,
      toolCalls: outcome.toolCalls,
    };
    session.append(assistantMsg);
    if (outcome.text) onEvent({ type: 'assistant_done', content: outcome.text });

    for (const tc of outcome.toolCalls) {
      // 中断检查：用户可能在工具序列执行中途中断。
      if (signal.aborted) {
        onEvent({ type: 'end', reason: 'aborted' });
        return;
      }

      onEvent({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args });

      const tool = tools.get(tc.name);
      let result: ToolResult | undefined;

      if (!tool) {
        // 未知工具：错误即数据，回喂模型让其纠正。
        result = { ok: false, error: `未知工具：${tc.name}` };
      } else {
        // 权限决策：只读直过；写类经 asker（可能弹窗阻塞）。
        if (!tool.readOnly) {
          const preview = previewToolChange(session.rootDir, tc.name, tc.args);
          onEvent({
            type: 'tool_preview',
            id: tc.id,
            name: tc.name,
            content: preview.summary,
          });
        }
        onEvent({
          type: 'phase',
          phase: tool.readOnly ? 'calling-tool' : 'awaiting-permission',
          turn,
          maxTurns,
        });

        let decision: 'allow' | 'deny';
        try {
          decision = await permission.check(tool, tc.args);
        } catch (err) {
          // asker 异常（如 UI 关闭）：保守视为拒绝，不阻塞循环。
          if (isAbort(err, signal)) {
            onEvent({ type: 'end', reason: 'aborted' });
            return;
          }
          decision = 'deny';
        }

        if (decision === 'deny') {
          session.logPermission({
            toolCallId: tc.id,
            tool: tc.name,
            effect: 'deny',
          });
          result = denialResult(); // { ok:false, error:'user denied permission' }
        } else {
          // 区分放行来源：只读=自动放行(auto_allow)，非用户授权；敏感=用户授权(allow)。
          session.logPermission({
            toolCallId: tc.id,
            tool: tc.name,
            effect: tool.readOnly ? 'auto_allow' : 'allow',
          });
          onEvent({ type: 'phase', phase: 'calling-tool', turn, maxTurns });
          if (!tool.readOnly && checkpoint) {
            try {
              const cp = await checkpoint.create({
                trigger: 'auto',
                label: `before ${tc.name}`,
                sessionLog: session.logFile,
                targets: checkpointTargetsForTool(tc.name, tc.args),
              });
              session.logCheckpoint({
                id: cp.id,
                trigger: cp.trigger,
                label: cp.label,
                toolCallId: tc.id,
                tool: tc.name,
                files: cp.files.length,
              });
            } catch (err) {
              result = {
                ok: false,
                error: `checkpoint 创建失败，已取消执行 ${tc.name}：${(err as Error).message}`,
              };
            }
          }
          if (!result) {
            // tools.execute 已把工具自身异常收敛为 ok:false，不会抛出。
            result = await tools.execute(tc.name, tc.args, {
              rootDir: session.rootDir,
              signal,
            });
          }
        }
      }

      // 工具结果（成功/失败/拒绝）入历史，参与下一轮请求。
      if (!result) {
        result = { ok: false, error: `工具 ${tc.name} 未返回结果` };
      }
      session.append({
        role: 'tool',
        toolCallId: tc.id,
        content: toolResultText(result),
        ok: result.ok,
      });
      onEvent({ type: 'tool_result', id: tc.id, name: tc.name, result });
    }
    // 继续下一轮（带上本轮工具结果再决策）。
  }

  // ── 4. 触顶 maxTurns：优雅收尾，不无限循环 ──────────────────────────────
  session.logError({
    message: '达到最大轮次上限',
    where: 'agent-loop',
    detail: { maxTurns },
  });
  onEvent({ type: 'phase', phase: 'idle', turn: maxTurns, maxTurns });
  onEvent({ type: 'end', reason: 'max_turns' });
}

// ============================================================================
// 辅助
// ============================================================================

async function maybeCompactMemory(
  session: Session,
  memory: MemoryCompactionOptions | undefined,
  signal: AbortSignal,
  onEvent: (e: UIEvent) => void,
): Promise<void> {
  if (!memory || signal.aborted) return;
  try {
    const result = await session.maybeCompact({
      thresholdMsgs: memory.thresholdMsgs,
      keepRecent: memory.keepRecent,
      thresholdTokens: memory.thresholdTokens,
      keepRecentTokens: memory.keepRecentTokens,
      summarizer: memory.summarizer,
      signal,
    });
    if (result.compacted) {
      onEvent({
        type: 'memory_compacted',
        compacted: true,
        content: `已自动压缩上下文：${result.summary ?? 'summary created'}`,
      });
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    session.logError({ message, where: 'memory.compaction' });
    onEvent({
      type: 'memory_compacted',
      compacted: false,
      content: `上下文压缩失败，已继续执行：${message}`,
    });
  }
}

/** 把 ToolResult 归一为字符串文本（供 session 存储 / 回喂模型）。 */
function toolResultText(result: ToolResult): string {
  return result.ok ? result.content : result.error;
}

/** 判断异常是否由 abort 引起（区分预期中断与真实错误）。 */
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (err as { name?: string })?.name;
  return name === 'AbortError';
}
