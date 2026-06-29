// src/tui/App.tsx
// Ink 根组件 —— 装配消息流 / 输入框 / 状态栏 / 权限弹窗，消费 Agent Loop 的 UIEvent。
// 依赖规则（ARCHITECTURE）：TUI 只通过事件流消费 Loop，不内嵌业务逻辑；
//   一切「决策」在 agent/loop，一切 IO 在 provider/tools/session。本组件只做：
//   把用户输入 → runAgent，把 UIEvent → React 状态 → 重渲染，把权限提问 → 弹窗。

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { runAgent } from '../agent/index.js';
import type { AgentPhase, MemoryCompactionOptions, UIEvent } from '../agent/index.js';
import type { Tool } from '../core/types.js';
import { Permission } from '../permission/index.js';
import type { PermissionAsker } from '../permission/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { Provider } from '../core/types.js';
import {
  DEFAULT_MEMORY_KEEP_RECENT,
  DEFAULT_MEMORY_THRESHOLD_MSGS,
  Session,
  createHeuristicSummarizer,
  listSessions,
  resolveSessionLog,
} from '../session/index.js';
import { CheckpointStore } from '../checkpoint/index.js';
import { PlanStore, formatPlanSnapshot } from '../plan/index.js';
import {
  findLatestAutoCheckpoint,
  formatDiffResult,
  formatWorkspaceStatus,
  getWorkspaceDiff,
  getWorkspaceStatus,
} from '../workspace/index.js';
import type { ViewMessage } from './messages.js';
import { summarizeArgs } from './messages.js';
import { parseInput, HELP_TEXT } from './command.js';

// ============================================================================
// 组件入参 —— 由 cli.tsx 装配后注入。Provider 可在运行期随 /model 切换，故用 getter。
// ============================================================================

export interface AppProps {
  tools: ToolRegistry;
  session: Session;
  /** 当前模型 id（可被 /model 修改）。 */
  initialModel: string;
  baseURL: string;
  maxTurns: number;
  apiKeyConfigured: boolean;
  /** 用给定 model 构造一个 Provider；/model 切换时复用。null=未配置 Key（仅本地命令可用）。 */
  makeProvider: (model: string) => Provider | null;
  checkpointStore?: CheckpointStore;
  memoryCompaction?: MemoryCompactionOptions;
  /** 与 update_plan 工具共享的同一个 PlanStore（由 cli 注入）。 */
  planStore?: PlanStore;
}

/** 一次待用户决策的权限请求（弹窗用）。 */
interface PendingPermission {
  tool: Tool;
  args: unknown;
  resolve: (d: 'allow' | 'deny' | 'always') => void;
}

// ============================================================================
// 根组件
// ============================================================================

export function App(props: AppProps): React.JSX.Element {
  const { tools, session, baseURL, maxTurns, apiKeyConfigured, makeProvider } = props;
  const { exit } = useApp();

  const [messages, setMessages] = useState<ViewMessage[]>(() => [
    { kind: 'system', text: welcomeText(props.initialModel) },
  ]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(props.initialModel);
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [turn, setTurn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);

  const checkpointStore = useMemo(
    () => props.checkpointStore ?? new CheckpointStore(session.rootDir),
    [props.checkpointStore, session.rootDir],
  );
  const memoryCompaction = useMemo<MemoryCompactionOptions>(
    () =>
      props.memoryCompaction ?? {
        thresholdMsgs: DEFAULT_MEMORY_THRESHOLD_MSGS,
        keepRecent: DEFAULT_MEMORY_KEEP_RECENT,
        summarizer: createHeuristicSummarizer(),
      },
    [props.memoryCompaction],
  );
  // 与 update_plan 工具共享同一 PlanStore；未注入时新建（隔离场景/测试）。
  const planStore = useMemo(() => props.planStore ?? new PlanStore(), [props.planStore]);

  // 运行期可变引用：避免闭包捕获过期值。
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingPermission | null>(null);
  pendingRef.current = pending;

  // ── 消息流操作（函数式更新，保证基于最新状态）─────────────────────────
  const push = useCallback((m: ViewMessage) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  /** 把流式增量并入「最后一条 streaming assistant」，没有则新建。 */
  const appendAssistantDelta = useCallback((delta: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const next = prev.slice(0, -1);
        next.push({ ...last, text: last.text + delta });
        return next;
      }
      return [...prev, { kind: 'assistant', text: delta, streaming: true }];
    });
  }, []);

  /** 收口 streaming assistant（定型为非流式）。 */
  const finalizeAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const next = prev.slice(0, -1);
        next.push({ kind: 'assistant', text: content || last.text, streaming: false });
        return next;
      }
      // 没有流式块（如纯工具回合）：仅当有内容时补一条。
      if (content) return [...prev, { kind: 'assistant', text: content, streaming: false }];
      return prev;
    });
  }, []);

  // ── 权限询问器：把 Loop 的 check 桥接到弹窗，返回 Promise 等用户按键 ────
  const asker: PermissionAsker = useCallback((tool, args) => {
    return new Promise<'allow' | 'deny' | 'always'>((resolve) => {
      setPending({ tool, args, resolve });
    });
  }, []);

  // permission 控制器在组件生命周期内稳定（allowlist 跨多次任务保留）。
  const permission = useMemo(() => new Permission(asker), [asker]);

  // ── UIEvent → 状态映射 ─────────────────────────────────────────────────
  const onEvent = useCallback(
    (e: UIEvent) => {
      switch (e.type) {
        case 'phase':
          setPhase(e.phase);
          setTurn(e.turn);
          break;
        case 'assistant_delta':
          appendAssistantDelta(e.delta);
          break;
        case 'assistant_done':
          finalizeAssistant(e.content);
          break;
        case 'tool_call':
          push({ kind: 'tool-call', id: e.id, name: e.name, args: e.args });
          break;
        case 'tool_preview':
          push({ kind: 'system', text: e.content });
          break;
        case 'memory_compacted':
          push({ kind: 'system', text: e.content });
          break;
        case 'tool_result':
          push({ kind: 'tool-result', id: e.id, name: e.name, result: e.result });
          break;
        case 'error':
          push({ kind: 'error', text: e.message });
          break;
        case 'end':
          setPhase('idle');
          setBusy(false);
          abortRef.current = null;
          if (e.reason === 'max_turns') {
            push({ kind: 'system', text: `已达到最大轮次上限（${maxTurns}），已停止。` });
          } else if (e.reason === 'aborted') {
            push({ kind: 'system', text: '已中断当前任务。' });
          }
          break;
      }
    },
    [appendAssistantDelta, finalizeAssistant, push, maxTurns],
  );

  // ── 提交：内置命令 or 任务 ───────────────────────────────────────────────
  const submit = useCallback(
    async (raw: string) => {
      setInput('');
      const trimmed = raw.trim();
      if (!trimmed) return;

      const parsed = parseInput(trimmed);

      // 本地命令：不入 Agent。
      switch (parsed.kind) {
        case 'help':
          push({ kind: 'user', text: trimmed });
          push({ kind: 'system', text: HELP_TEXT });
          return;
        case 'clear':
          session.clear();
          setMessages([{ kind: 'system', text: '已清空上下文，开启新会话日志。' }]);
          setTurn(0);
          return;
        case 'status':
          push({ kind: 'user', text: trimmed });
          push({ kind: 'system', text: statusText({ model, baseURL, maxTurns, turn, apiKeyConfigured, logFile: session.logFile }) });
          return;
        case 'model': {
          push({ kind: 'user', text: trimmed });
          if (!parsed.id) {
            push({ kind: 'system', text: `当前模型：${model}` });
          } else {
            setModel(parsed.id);
            push({ kind: 'system', text: `已切换模型：${parsed.id}` });
          }
          return;
        }
        case 'resume': {
          push({ kind: 'user', text: trimmed });
          const target =
            parsed.file
              ? resolveSessionLog(session.rootDir, parsed.file, session.logFile)
              : Session.findLatestLog(session.rootDir, session.logFile);
          if (!target) {
            push({ kind: 'system', text: '没有可恢复的历史会话日志。' });
            return;
          }
          try {
            const { restored } = session.resumeFrom(target);
            const restoredMsgs = session.messages();
            const sysCount = restoredMsgs.filter((m) => m.role === 'system').length;
            const view = messagesToView(restoredMsgs); // 已跳过 system，不刷屏
            const note =
              `已从 ${target} 恢复 ${restored} 条消息` +
              (sysCount ? `（含 system 指令 ${sysCount} 条，不展示）。` : '。');
            setMessages([{ kind: 'system', text: note }, ...view]);
          } catch (err) {
            push({ kind: 'error', text: `恢复失败：${(err as Error)?.message ?? String(err)}` });
          }
          return;
        }
        case 'sessions': {
          push({ kind: 'user', text: trimmed });
          // Phase-6 LH3：默认只展示最近 50 条，避免大量日志全量读取阻塞 TUI。
          const SESSIONS_LIMIT = 50;
          const summaries = listSessions(session.rootDir, session.logFile, { limit: SESSIONS_LIMIT });
          if (summaries.length === 0) {
            push({ kind: 'system', text: '暂无历史会话。' });
            return;
          }
          push({
            kind: 'system',
            text: summaries
              .map((s) =>
                `${s.current ? '*' : ' '} ${s.id} · ${s.title} · ${s.messages} msg · ${s.toolCalls} tools · ${s.updatedAt}`,
              )
              .join('\n'),
          });
          return;
        }
        case 'memory': {
          push({ kind: 'user', text: trimmed });
          const st = session.memoryStats();
          push({
            kind: 'system',
            text: [
              `记忆状态：`,
              `  消息数：${st.messages}（system ${st.system}）`,
              `  含历史摘要：${st.hasSummary ? '是' : '否'}`,
              `  当前会话日志：${st.logFile}`,
            ].join('\n'),
          });
          return;
        }
        case 'checkpoint': {
          push({ kind: 'user', text: trimmed });
          try {
            const cp = await checkpointStore.create({
              label: parsed.label,
              trigger: 'manual',
              sessionLog: session.logFile,
            });
            session.logCheckpoint({
              id: cp.id,
              trigger: cp.trigger,
              label: cp.label,
              files: cp.files.length,
            });
            push({
              kind: 'system',
              text: `已创建 checkpoint ${cp.id}（${cp.files.length} 个文件，排除 ${cp.excluded.length} 项）。`,
            });
          } catch (err) {
            push({ kind: 'error', text: `checkpoint 创建失败：${(err as Error).message}` });
          }
          return;
        }
        case 'checkpoints': {
          push({ kind: 'user', text: trimmed });
          try {
            // LH6：默认只展示最近 50 条，避免全量解析所有 manifest。
            const CHECKPOINTS_LIMIT = 50;
            const cps = await checkpointStore.list({ limit: CHECKPOINTS_LIMIT });
            if (cps.length === 0) {
              push({ kind: 'system', text: '暂无 checkpoint。' });
              return;
            }
            const total = await checkpointStore.count();
            const lines = cps.map(
              (c) => `${c.id} · ${c.trigger} · ${c.label ?? '-'} · ${c.files.length} files · ${c.createdAt}`,
            );
            if (total > cps.length) {
              lines.push(`（共 ${total} 个，仅展示最近 ${cps.length} 个）`);
            }
            push({ kind: 'system', text: lines.join('\n') });
          } catch (err) {
            push({ kind: 'error', text: `checkpoint 列表读取失败：${(err as Error).message}` });
          }
          return;
        }
        case 'restore': {
          push({ kind: 'user', text: trimmed });
          if (!parsed.id) {
            push({ kind: 'error', text: 'restore 缺少 checkpoint id。' });
            return;
          }
          setPendingRestore(parsed.id);
          push({ kind: 'system', text: `确认恢复 checkpoint ${parsed.id}？按 y 确认，n/Esc 取消。` });
          return;
        }
        case 'changes': {
          push({ kind: 'user', text: trimmed });
          try {
            const status = await getWorkspaceStatus(session.rootDir, checkpointStore);
            push({ kind: 'system', text: formatWorkspaceStatus(status) });
          } catch (err) {
            push({ kind: 'error', text: `工作区状态读取失败：${(err as Error).message}` });
          }
          return;
        }
        case 'diff': {
          push({ kind: 'user', text: trimmed });
          try {
            const diff = await getWorkspaceDiff(session.rootDir, parsed.path);
            push({ kind: 'system', text: formatDiffResult(diff) });
          } catch (err) {
            push({ kind: 'error', text: `diff 读取失败：${(err as Error).message}` });
          }
          return;
        }
        case 'undo-last': {
          push({ kind: 'user', text: trimmed });
          try {
            const checkpoint = await findLatestAutoCheckpoint(checkpointStore);
            if (!checkpoint) {
              push({ kind: 'system', text: '暂无可恢复的自动 checkpoint。' });
              return;
            }
            setPendingRestore(checkpoint.id);
            push({
              kind: 'system',
              text: `确认恢复最近自动 checkpoint ${checkpoint.id}？按 y 确认，n/Esc 取消。`,
            });
          } catch (err) {
            push({ kind: 'error', text: `自动 checkpoint 查询失败：${(err as Error).message}` });
          }
          return;
        }
        case 'plan': {
          push({ kind: 'user', text: trimmed });
          if (parsed.sub === 'clear') {
            planStore.clear();
            push({ kind: 'system', text: '已清空当前任务计划。' });
          } else {
            push({ kind: 'system', text: formatPlanSnapshot(planStore.current()) });
          }
          return;
        }
        case 'exit':
          exit();
          return;
        case 'unknown':
          push({ kind: 'user', text: trimmed });
          push({ kind: 'system', text: `未知命令 /${parsed.name}，输入 /help 查看可用命令。` });
          return;
        case 'task':
          break; // 落到下面交给 Agent。
      }

      // 任务：需要 Provider（即 Key 已配置）。
      const provider = makeProvider(model);
      if (!provider) {
        push({ kind: 'user', text: trimmed });
        push({
          kind: 'error',
          text: '未配置 API Key（ANTHROPIC_AUTH_TOKEN），无法发起任务。可用本地命令：/help /status /model /clear /exit。',
        });
        return;
      }

      push({ kind: 'user', text: parsed.text });
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;

      await runAgent(
        parsed.text,
        { provider, tools, permission, session, checkpoint: checkpointStore, memory: memoryCompaction },
        { model, maxTurns, signal: ac.signal, onEvent },
      );
    },
    [apiKeyConfigured, baseURL, checkpointStore, exit, makeProvider, maxTurns, memoryCompaction, model, onEvent, permission, planStore, push, session, tools, turn],
  );

  const confirmRestore = useCallback(
    async (id: string) => {
      setPendingRestore(null);
      try {
        const r = await checkpointStore.restore(id);
        session.logRestore(r);
        push({
          kind: 'system',
          text:
            `已恢复 checkpoint ${r.id}：恢复 ${r.filesRestored} 个文件，删除 ${r.filesRemoved} 个新文件` +
            (r.filesSkipped ? `，跳过 ${r.filesSkipped} 个文件` : '') +
            (r.preRestoreCheckpoint ? `；恢复前 checkpoint：${r.preRestoreCheckpoint}` : '') +
            '。',
        });
      } catch (err) {
        push({ kind: 'error', text: `恢复失败：${(err as Error).message}` });
      }
    },
    [checkpointStore, push, session],
  );

  // ── 键盘：权限弹窗按键 / 全局中断 ───────────────────────────────────────
  useInput((inputChar, key) => {
    if (pendingRestore) {
      const c = inputChar.toLowerCase();
      if (c === 'y') void confirmRestore(pendingRestore);
      else if (c === 'n' || key.escape) {
        const id = pendingRestore;
        setPendingRestore(null);
        push({ kind: 'system', text: `已取消恢复 checkpoint ${id}。` });
      }
      return;
    }

    const p = pendingRef.current;
    if (p) {
      // 弹窗模式：y=允许一次 / a=本会话始终 / n / esc=拒绝。
      const c = inputChar.toLowerCase();
      if (c === 'y') decide(p, 'allow');
      else if (c === 'a') decide(p, 'always');
      else if (c === 'n' || key.escape) decide(p, 'deny');
      return;
    }
    // 非弹窗：Esc 中断在途任务。
    if (key.escape && busy && abortRef.current) {
      abortRef.current.abort();
    }
    // Ctrl+C：退出（Ink 默认也会处理，这里显式收尾）。
    if (key.ctrl && inputChar === 'c') {
      if (abortRef.current) abortRef.current.abort();
      exit();
    }
  });

  /** 落实一次权限决策：清弹窗、记录消息、resolve 给 Loop。 */
  const decide = useCallback(
    (p: PendingPermission, d: 'allow' | 'deny' | 'always') => {
      setPending(null);
      pendingRef.current = null;
      push({ kind: 'permission', tool: p.tool.name, effect: d });
      p.resolve(d);
    },
    [push],
  );

  // ── 渲染 ─────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />

      {pendingRestore ? (
        <RestorePrompt id={pendingRestore} />
      ) : pending ? (
        <PermissionPrompt tool={pending.tool.name} args={pending.args} />
      ) : (
        <Box>
          <Text color="cyan">{busy ? '… ' : '› '}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            placeholder={busy ? '运行中（Esc 中断）…' : '输入任务或 / 命令（/help）'}
            focus={!pending}
          />
        </Box>
      )}

      <StatusBar
        model={model}
        phase={phase}
        turn={turn}
        maxTurns={maxTurns}
        apiKeyConfigured={apiKeyConfigured}
      />
    </Box>
  );
}

// ============================================================================
// 子组件
// ============================================================================

export function MessageList({ messages }: { messages: ViewMessage[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => (
        <MessageRow key={i} m={m} />
      ))}
    </Box>
  );
}

function MessageRow({ m }: { m: ViewMessage }): React.JSX.Element {
  switch (m.kind) {
    case 'user':
      return (
        <Box>
          <Text color="cyan" bold>
            你 ›{' '}
          </Text>
          <Text>{m.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          <Text color="green" bold>
            助手{m.streaming ? ' …' : ''}
          </Text>
          <Text>{m.text}</Text>
        </Box>
      );
    case 'tool-call':
      return (
        <Box>
          <Text color="yellow">⚙ 调用 </Text>
          <Text color="yellow" bold>
            {m.name}
          </Text>
          <Text color="gray"> {summarizeArgs(m.args)}</Text>
        </Box>
      );
    case 'tool-result':
      return (
        <Box>
          <Text color={m.result.ok ? 'green' : 'red'}>
            {m.result.ok ? '✓' : '✗'} {m.name}{' '}
          </Text>
          <Text color="gray">
            {summarizeArgs(m.result.ok ? m.result.content : m.result.error, 160)}
          </Text>
        </Box>
      );
    case 'permission':
      return (
        <Text color="magenta">
          权限：{m.tool} → {effectLabel(m.effect)}
        </Text>
      );
    case 'error':
      return (
        <Box>
          <Text color="red" bold>
            错误：{' '}
          </Text>
          <Text color="red">{m.text}</Text>
        </Box>
      );
    case 'system':
      return <Text color="gray">{m.text}</Text>;
  }
}

export function PermissionPrompt({ tool, args }: { tool: string; args: unknown }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        需要授权：{tool}
      </Text>
      <Text color="gray">参数：{summarizeArgs(args)}</Text>
      <Text>
        <Text color="green">[y]</Text> 允许一次 {'  '}
        <Text color="cyan">[a]</Text> 本会话始终允许 {'  '}
        <Text color="red">[n]</Text> 拒绝
      </Text>
    </Box>
  );
}

export function RestorePrompt({ id }: { id: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red" bold>
        确认恢复 checkpoint：{id}
      </Text>
      <Text color="gray">该操作会覆盖 checkpoint 记录的文件，并可能删除当时不存在的新文件。</Text>
      <Text>
        <Text color="green">[y]</Text> 确认恢复 {'  '}
        <Text color="red">[n]</Text> 取消
      </Text>
    </Box>
  );
}

export function StatusBar({
  model,
  phase,
  turn,
  maxTurns,
  apiKeyConfigured,
}: {
  model: string;
  phase: AgentPhase;
  turn: number;
  maxTurns: number;
  apiKeyConfigured: boolean;
}): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color="gray">
        模型 <Text color="white">{model}</Text> · 轮次{' '}
        <Text color="white">
          {turn}/{maxTurns}
        </Text>{' '}
        · 状态 <Text color={phaseColor(phase)}>{phaseLabel(phase)}</Text> · Key{' '}
        <Text color={apiKeyConfigured ? 'green' : 'red'}>
          {apiKeyConfigured ? '已配置' : '未配置'}
        </Text>
      </Text>
    </Box>
  );
}

// ============================================================================
// 文案 / 标签
// ============================================================================

/** 把恢复出的 Message[] 转成可渲染的 ViewMessage[]（用于 /resume 重建消息流）。
 *  注意：内部 system 指令（系统提示 / 历史摘要）一律不渲染，避免 /resume 刷屏淹没证据。 */
export function messagesToView(msgs: import('../core/types.js').Message[]): ViewMessage[] {
  const view: ViewMessage[] = [];
  const nameById = new Map<string, string>();
  for (const m of msgs) {
    switch (m.role) {
      case 'system':
        // 不展示内部 system 指令（系统提示 / 历史摘要）——它们留在上下文里，但不刷屏淹没证据。
        break;
      case 'user':
        view.push({ kind: 'user', text: m.content });
        break;
      case 'assistant':
        if (m.content) view.push({ kind: 'assistant', text: m.content, streaming: false });
        for (const c of m.toolCalls ?? []) {
          nameById.set(c.id, c.name);
          view.push({ kind: 'tool-call', id: c.id, name: c.name, args: c.args });
        }
        break;
      case 'tool':
        view.push({
          kind: 'tool-result',
          id: m.toolCallId,
          name: nameById.get(m.toolCallId) ?? m.toolCallId,
          result: m.ok ? { ok: true, content: m.content } : { ok: false, error: m.content },
        });
        break;
    }
  }
  return view;
}

function welcomeText(model: string): string {
  return [
    'ai-code-cli —— 终端编码 Agent',
    `模型 ${model} · 输入 /help 查看命令 · 直接输入文字下达任务 · Esc 中断 · Ctrl+C 退出`,
  ].join('\n');
}

function statusText(s: {
  model: string;
  baseURL: string;
  maxTurns: number;
  turn: number;
  apiKeyConfigured: boolean;
  logFile: string;
}): string {
  return [
    `模型：${s.model}`,
    `baseURL：${s.baseURL}`,
    `轮次：${s.turn}/${s.maxTurns}`,
    `API Key：${s.apiKeyConfigured ? '已配置' : '未配置'}`,
    `会话日志：${s.logFile}`,
  ].join('\n');
}

function phaseLabel(p: AgentPhase): string {
  switch (p) {
    case 'idle':
      return '空闲';
    case 'thinking':
      return '思考中';
    case 'calling-tool':
      return '执行工具';
    case 'awaiting-permission':
      return '等待授权';
  }
}

function phaseColor(p: AgentPhase): string {
  switch (p) {
    case 'idle':
      return 'gray';
    case 'thinking':
      return 'yellow';
    case 'calling-tool':
      return 'blue';
    case 'awaiting-permission':
      return 'magenta';
  }
}

function effectLabel(e: 'allow' | 'deny' | 'always'): string {
  return e === 'deny' ? '拒绝' : e === 'always' ? '本会话始终允许' : '允许';
}
