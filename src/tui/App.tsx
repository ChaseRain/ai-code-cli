// src/tui/App.tsx
// Ink 根组件 —— 装配消息流 / 输入框 / 状态栏 / 权限弹窗，消费 Agent Loop 的 UIEvent。
// 依赖规则（ARCHITECTURE）：TUI 只通过事件流消费 Loop，不内嵌业务逻辑；
//   一切「决策」在 agent/loop，一切 IO 在 provider/tools/session。本组件只做：
//   把用户输入 → runAgent，把 UIEvent → React 状态 → 重渲染，把权限提问 → 弹窗。

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { runAgent } from '../agent/index.js';
import type { AgentPhase, UIEvent } from '../agent/index.js';
import type { Tool } from '../core/types.js';
import { Permission } from '../permission/index.js';
import type { PermissionAsker } from '../permission/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { Provider } from '../core/types.js';
import { Session } from '../session/index.js';
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
        { provider, tools, permission, session },
        { model, maxTurns, signal: ac.signal, onEvent },
      );
    },
    [apiKeyConfigured, baseURL, exit, makeProvider, maxTurns, model, onEvent, permission, push, session, tools, turn],
  );

  // ── 键盘：权限弹窗按键 / 全局中断 ───────────────────────────────────────
  useInput((inputChar, key) => {
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

      {pending ? (
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

function MessageList({ messages }: { messages: ViewMessage[] }): React.JSX.Element {
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

function PermissionPrompt({ tool, args }: { tool: string; args: unknown }): React.JSX.Element {
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

function StatusBar({
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
