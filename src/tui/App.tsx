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
  FallbackSummarizer,
  LLMSummarizer,
  createHeuristicSummarizer,
} from '../session/index.js';
import type { Session, SessionSummary } from '../session/index.js';
import { CheckpointStore } from '../checkpoint/index.js';
import type { CheckpointManifest } from '../checkpoint/index.js';
import { PlanStore } from '../plan/index.js';
import type { SkillRegistry } from '../skills/index.js';
import type { ViewMessage } from './messages.js';
import { summarizeArgs } from './messages.js';
import { parseInput } from './command.js';
import { createCommandExecutor } from './command-executor.js';
import type { OutMessage } from './command-executor.js';

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
  /** 技能注册表（Phase-11）：供 /skills。undefined=skills 已禁用。 */
  skills?: SkillRegistry;
}

/** 一次待用户决策的权限请求（弹窗用）。 */
interface PendingPermission {
  tool: Tool;
  args: unknown;
  resolve: (d: 'allow' | 'deny' | 'always') => void;
}

/**
 * 列表选择器状态（判别联合）：
 * - session：/resume、/sessions —— Enter 恢复会话日志。
 * - checkpoint：/rewind —— Enter 进入回滚确认（y/n）。
 */
type PickerState =
  | { mode: 'session'; items: SessionSummary[]; index: number }
  | { mode: 'checkpoint'; items: CheckpointManifest[]; index: number };

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
  // 交互选择器：null=未打开。/resume·/sessions 选会话，/rewind 选快照。
  const [picker, setPicker] = useState<PickerState | null>(null);

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
  // 据摘要器实例类型推导展示标签（供 /memory 展示生效配置）。
  const summarizerLabel = useMemo(
    () => describeSummarizer(memoryCompaction.summarizer),
    [memoryCompaction.summarizer],
  );

  // 运行期可变引用：避免闭包捕获过期值。
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingPermission | null>(null);
  pendingRef.current = pending;
  // 供命令执行器读取最新的运行时状态（model/turn 会随交互变化）。
  const statusRef = useRef({ model, turn });
  statusRef.current = { model, turn };

  // 命令执行器（Phase-10 Q1）：把命令副作用（IO + 状态查询）从本组件下沉到纯逻辑模块。
  //   App 只负责调用它 + 据返回的 messages/effect 渲染。status 用 getter 读最新值。
  const executor = useMemo(
    () =>
      createCommandExecutor({
        session,
        checkpointStore,
        planStore,
        status: () => ({
          model: statusRef.current.model,
          baseURL,
          maxTurns,
          turn: statusRef.current.turn,
          apiKeyConfigured,
        }),
        memory: props.memoryCompaction ? memoryCompaction : undefined,
        summarizerLabel,
        skills: props.skills,
      }),
    [
      session,
      checkpointStore,
      planStore,
      baseURL,
      maxTurns,
      apiKeyConfigured,
      props.memoryCompaction,
      memoryCompaction,
      summarizerLabel,
      props.skills,
    ],
  );

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

  // ── 从指定日志恢复会话（/resume 与 /sessions 选择器共用）────────────────
  const resumeFromTarget = useCallback(
    (target: string) => {
      try {
        const { restored } = session.resumeFrom(target);
        const restoredMsgs = session.messages();
        const sysCount = restoredMsgs.filter((m) => m.role === 'system').length;
        const view = messagesToView(restoredMsgs); // 已跳过 system，不刷屏
        const note =
          `已从 ${target} 恢复 ${restored} 条消息` +
          (sysCount ? `（含 system 指令 ${sysCount} 条，不展示）。` : '。');
        const next: ViewMessage[] = [{ kind: 'system', text: note }, ...view];
        // Phase-9 M4：恢复的历史含摘要时给出桥接提示，帮模型在摘要语境下顺畅续作。
        if (session.memoryStats().hasSummary) {
          next.push({ kind: 'system', text: RESUME_SUMMARY_BRIDGE });
        }
        setMessages(next);
      } catch (err) {
        push({ kind: 'error', text: `恢复失败：${(err as Error)?.message ?? String(err)}` });
      }
    },
    [push, session],
  );

  // ── 真正发起一次 Agent 任务（被 run-task 副作用触发）─────────────────────
  const runTask = useCallback(
    async (text: string) => {
      // 任务：需要 Provider（即 Key 已配置）。
      const provider = makeProvider(model);
      if (!provider) {
        push({ kind: 'user', text });
        push({
          kind: 'error',
          text: '未配置 API Key（ANTHROPIC_AUTH_TOKEN），无法发起任务。可用本地命令：/help /status /model /clear /exit。',
        });
        return;
      }

      push({ kind: 'user', text });
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;

      await runAgent(
        text,
        { provider, tools, permission, session, checkpoint: checkpointStore, memory: memoryCompaction },
        { model, maxTurns, signal: ac.signal, onEvent },
      );
    },
    [checkpointStore, makeProvider, maxTurns, memoryCompaction, model, onEvent, permission, push, session, tools],
  );

  /** 把执行器返回的 system/error 消息落到消息流。 */
  const pushOutMessages = useCallback(
    (msgs: OutMessage[]) => {
      for (const m of msgs) push({ kind: m.kind, text: m.text });
    },
    [push],
  );

  // ── 提交：解析 → 执行器 → 据结构化结果 push 消息 / 触发副作用 ──────────────
  // 本组件不再内嵌命令的 IO 与状态查询（Phase-10 Q1）：执行器算出「该做什么 + 查好数据」，
  //   App 只负责回显输入、落消息、并执行运行时才能做的副作用（弹窗 / picker / 切模型 / 清屏 /
  //   退出 / 恢复 / 落到 Agent）。
  const submit = useCallback(
    async (raw: string) => {
      setInput('');
      const trimmed = raw.trim();
      if (!trimmed) return;

      const parsed = parseInput(trimmed);
      const outcome = await executor.run(parsed, trimmed);

      // ① 回显原始输入（命令的回显由执行器决定；run-task/clear/exit 不在此回显）。
      if (outcome.echoUser) push({ kind: 'user', text: trimmed });
      // ② 顺序落系统/错误消息。
      pushOutMessages(outcome.messages);

      // ③ 执行副作用（运行时能力，执行器只发意图）。
      const eff = outcome.effect;
      switch (eff.type) {
        case 'none':
          return;
        case 'clear-session':
          session.clear();
          // Phase-9 P3：/clear 开启新会话，必须重置会话级 allowlist——
          //   否则上一会话「本会话始终允许」的工具会在新会话继续直过。
          permission.reset();
          setMessages([{ kind: 'system', text: '已清空上下文，开启新会话日志。' }]);
          setTurn(0);
          return;
        case 'set-model':
          setModel(eff.id);
          return;
        case 'open-session-picker':
          setPicker({ mode: 'session', items: eff.items, index: eff.index });
          return;
        case 'open-checkpoint-picker':
          setPicker({ mode: 'checkpoint', items: eff.items, index: eff.index });
          return;
        case 'resume':
          resumeFromTarget(eff.target);
          return;
        case 'confirm-restore':
          setPendingRestore(eff.id);
          return;
        case 'exit':
          exit();
          return;
        case 'run-task':
          await runTask(eff.text);
          return;
      }
    },
    [executor, exit, permission, push, pushOutMessages, resumeFromTarget, runTask, session],
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

    // 列表选择器：↑/↓（或 Ctrl-P/N）移动、Enter 选定、Esc 取消。
    if (picker) {
      const n = picker.items.length;
      if (key.upArrow || (key.ctrl && inputChar === 'p')) {
        setPicker((s) => (s ? { ...s, index: (s.index - 1 + n) % n } : s));
      } else if (key.downArrow || (key.ctrl && inputChar === 'n')) {
        setPicker((s) => (s ? { ...s, index: (s.index + 1) % n } : s));
      } else if (key.return) {
        setPicker(null);
        // 会话：直接恢复日志；快照：进入回滚确认（y/n，复用 pendingRestore 流程）。
        if (picker.mode === 'session') {
          const sel = picker.items[picker.index];
          if (sel) resumeFromTarget(sel.logPath);
        } else {
          const sel = picker.items[picker.index];
          if (sel) setPendingRestore(sel.id);
        }
      } else if (key.escape) {
        const what = picker.mode === 'session' ? '会话选择' : '回滚选择';
        setPicker(null);
        push({ kind: 'system', text: `已取消${what}。` });
      }
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
      ) : picker ? (
        <PickerView title={pickerTitle(picker)} lines={pickerLines(picker)} index={picker.index} />
      ) : (
        <Box>
          <Text color="cyan">{busy ? '… ' : '› '}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            placeholder={busy ? '运行中（Esc 中断）…' : '输入任务或 / 命令（/help）'}
            focus={!pending && !picker}
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

/** 选择器标题（含操作提示），随模式而变。 */
export function pickerTitle(p: PickerState): string {
  return p.mode === 'session'
    ? '选择会话恢复（↑/↓ 移动 · Enter 恢复 · Esc 取消）'
    : '选择快照回滚（↑/↓ 移动 · Enter 确认 · Esc 取消）';
}

/** 把选择器条目格式化为展示行（每条一行）。 */
export function pickerLines(p: PickerState): string[] {
  return p.mode === 'session'
    ? p.items.map(
        (s) =>
          `${s.current ? '*' : ' '} ${s.title} · ${s.messages} msg · ${s.toolCalls} tools · ${s.updatedAt}`,
      )
    : p.items.map(
        (c) =>
          `${c.trigger === 'auto' ? '~' : '·'} ${c.label ?? '(无标签)'} · ${c.files.length} files · ${c.createdAt}`,
      );
}

/** 通用列表选择器视图：高亮当前项，窗口滚动（最多展示 VISIBLE 行）。 */
export function PickerView({
  title,
  lines,
  index,
}: {
  title: string;
  lines: string[];
  index: number;
}): React.JSX.Element {
  const VISIBLE = 10;
  // 让高亮项尽量居中，并夹紧到列表边界。
  let start = Math.max(0, index - Math.floor(VISIBLE / 2));
  start = Math.min(start, Math.max(0, lines.length - VISIBLE));
  const window = lines.slice(start, start + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {title}{'  '}
        <Text color="gray">
          {index + 1}/{lines.length}
        </Text>
      </Text>
      {start > 0 && <Text color="gray">  ↑ 上面还有 {start} 条</Text>}
      {window.map((line, i) => {
        const real = start + i;
        const selected = real === index;
        return (
          <Text key={real} color={selected ? 'cyan' : undefined} inverse={selected}>
            {selected ? '❯ ' : '  '}
            {line}
          </Text>
        );
      })}
      {start + VISIBLE < lines.length && (
        <Text color="gray">  ↓ 下面还有 {lines.length - start - VISIBLE} 条</Text>
      )}
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

/** 据摘要器实例类型给出 /memory 展示标签（Phase-9 M3）。 */
export function describeSummarizer(s: import('../session/index.js').Summarizer): string {
  if (s instanceof FallbackSummarizer) return 'llm（失败降级 heuristic）';
  if (s instanceof LLMSummarizer) return 'llm';
  return 'heuristic';
}

// `/memory` 展示文本的格式化已下沉到 command-executor（单一真相）；此处 re-export 兼容既有导入。
export { formatMemoryStatus } from './command-executor.js';

/** `/resume` 含摘要时的桥接提示文案（Phase-9 M4，导出供测试）。 */
export const RESUME_SUMMARY_BRIDGE =
  '提示：本次恢复的上下文含历史摘要。建议用 /diff 查看已有文件变更、' +
  '用一句话清晰描述要续作的目标；若摘要信息不足以续作，可 /clear 重新开始。';
