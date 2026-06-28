// tests/agent-loop.test.ts
// 覆盖 agent-loop.md「验收」：
//  ① MockProvider 驱动「文本 → tool_call → 结果 → 最终回复」完整一轮，断言消息序列；
//  ② 工具结果被正确 append 并参与下一次请求；
//  ③ maxTurns 触顶时优雅收尾，不无限循环；
//  ④ 权限拒绝的结果（denial）入上下文。
// 真实文件 IO 仅限 Session 的 jsonl 落盘，写到临时目录，测试后清理。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgent } from '../src/agent/loop.js';
import type { UIEvent } from '../src/agent/loop.js';
import { MockProvider, scriptText, scriptToolCall } from '../src/provider/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Permission } from '../src/permission/index.js';
import type { PermissionAsker } from '../src/permission/index.js';
import { Session } from '../src/session/index.js';
import type { Message, Tool, ToolResult } from '../src/core/types.js';

// ── 测试桩工具 ──────────────────────────────────────────────────────────────

/** 只读 echo 工具：把入参原样回显，自动放行。 */
function makeReadTool(calls: unknown[]): Tool {
  return {
    name: 'echo',
    description: '回显参数（只读）',
    readOnly: true,
    parameters: { type: 'object', properties: {} },
    async execute(args: unknown): Promise<ToolResult> {
      calls.push(args);
      return { ok: true, content: `echo:${JSON.stringify(args)}` };
    },
  };
}

/** 敏感写工具：记录是否被执行（用于断言拒绝时不执行）。 */
function makeWriteTool(state: { executed: boolean }): Tool {
  return {
    name: 'do_write',
    description: '写文件（敏感）',
    readOnly: false,
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      state.executed = true;
      return { ok: true, content: 'written' };
    },
  };
}

// ── 公共脚手架 ──────────────────────────────────────────────────────────────

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'ai-code-cli-loop-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/** 收集 onEvent 事件的回调与缓冲。 */
function collector() {
  const events: UIEvent[] = [];
  return { events, onEvent: (e: UIEvent) => events.push(e) };
}

/** 永远允许的 asker。 */
const allowAsker: PermissionAsker = async () => 'allow';
/** 永远拒绝的 asker。 */
const denyAsker: PermissionAsker = async () => 'deny';

describe('runAgent —— 主循环编排', () => {
  it('① 完整一轮：tool_call → 结果 → 最终回复，消息序列正确', async () => {
    const toolCalls: unknown[] = [];
    const tools = new ToolRegistry([makeReadTool(toolCalls)]);
    const session = new Session({ rootDir, id: 'round' });
    const permission = new Permission(allowAsker);

    // 第 1 次 chat：调用 echo 工具；第 2 次 chat：纯文本最终回复。
    const provider = new MockProvider({
      scripts: [
        scriptToolCall('call-1', 'echo', { msg: 'hi' }),
        scriptText('完成了。'),
      ],
    });

    const { events, onEvent } = collector();
    await runAgent('请回显 hi', { provider, tools, permission, session }, {
      model: 'mock-model',
      maxTurns: 25,
      signal: new AbortController().signal,
      onEvent,
    });

    // 工具被执行且拿到正确参数。
    expect(toolCalls).toEqual([{ msg: 'hi' }]);

    // 会话消息序列：user → assistant(toolCalls) → tool → assistant(最终)。
    const msgs = session.messages();
    expect(msgs.map((m) => roleTag(m))).toEqual([
      'user',
      'assistant+tools',
      'tool',
      'assistant',
    ]);
    const toolMsg = msgs[2] as Extract<Message, { role: 'tool' }>;
    expect(toolMsg.ok).toBe(true);
    expect(toolMsg.toolCallId).toBe('call-1');
    expect(toolMsg.content).toBe('echo:{"msg":"hi"}');
    expect((msgs[3] as Extract<Message, { role: 'assistant' }>).content).toBe(
      '完成了。',
    );

    // ② 工具结果参与了下一次请求：第二次 chat 的 messages 含 tool 结果。
    expect(provider.requests.length).toBe(2);
    const secondReqRoles = provider.requests[1].messages.map((m) => m.role);
    expect(secondReqRoles).toContain('tool');

    // UI 事件覆盖关键节点。
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('assistant_done');
    const end = events.at(-1);
    expect(end).toEqual({ type: 'end', reason: 'final' });
  });

  it('③ maxTurns 触顶：每轮都 tool_call，达到上限优雅收尾', async () => {
    const tools = new ToolRegistry([makeReadTool([])]);
    const session = new Session({ rootDir, id: 'cap' });
    const permission = new Permission(allowAsker);

    // 每一轮都返回 tool_call（永不给最终文本）→ 强制触顶。
    const provider = new MockProvider({
      scripts: () => scriptToolCall('c', 'echo', {}),
    });

    const { events, onEvent } = collector();
    await runAgent('死循环用例', { provider, tools, permission, session }, {
      model: 'mock-model',
      maxTurns: 3,
      signal: new AbortController().signal,
      onEvent,
    });

    // 恰好 3 轮请求，不多不少（不无限循环）。
    expect(provider.requests.length).toBe(3);
    const end = events.at(-1);
    expect(end).toEqual({ type: 'end', reason: 'max_turns' });
  });

  it('④ 权限拒绝：denial 入上下文，工具不执行，循环继续到最终回复', async () => {
    const writeState = { executed: false };
    const tools = new ToolRegistry([makeWriteTool(writeState)]);
    const session = new Session({ rootDir, id: 'deny' });
    const permission = new Permission(denyAsker);

    const provider = new MockProvider({
      scripts: [
        scriptToolCall('w-1', 'do_write', { path: 'a.txt' }),
        scriptText('已放弃写入。'),
      ],
    });

    const { events, onEvent } = collector();
    await runAgent('写个文件', { provider, tools, permission, session }, {
      model: 'mock-model',
      maxTurns: 25,
      signal: new AbortController().signal,
      onEvent,
    });

    // 拒绝 → 工具未执行。
    expect(writeState.executed).toBe(false);

    // 拒绝结果作为 tool 消息入上下文（错误即数据）。
    const toolMsg = session
      .messages()
      .find((m) => m.role === 'tool') as Extract<Message, { role: 'tool' }>;
    expect(toolMsg.ok).toBe(false);
    expect(toolMsg.content).toBe('user denied permission');

    // 拒绝结果参与了下一次请求。
    expect(provider.requests.length).toBe(2);
    expect(provider.requests[1].messages.some((m) => m.role === 'tool')).toBe(true);

    // UI 收到 tool_result（失败）与最终 end。
    const toolResultEv = events.find((e) => e.type === 'tool_result');
    expect(toolResultEv && toolResultEv.type === 'tool_result' && toolResultEv.result.ok).toBe(
      false,
    );
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'final' });
  });

  it('abort：已中断信号下立即收尾，不发起请求', async () => {
    const tools = new ToolRegistry([makeReadTool([])]);
    const session = new Session({ rootDir, id: 'abort' });
    const permission = new Permission(allowAsker);
    const provider = new MockProvider({ scripts: scriptText('不该被调用') });

    const ac = new AbortController();
    ac.abort();

    const { events, onEvent } = collector();
    await runAgent('中断', { provider, tools, permission, session }, {
      model: 'mock-model',
      maxTurns: 25,
      signal: ac.signal,
      onEvent,
    });

    expect(provider.requests.length).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'aborted' });
  });
});

/** 把 Message 归一为可断言的标签。 */
function roleTag(m: Message): string {
  if (m.role === 'assistant' && m.toolCalls?.length) return 'assistant+tools';
  return m.role;
}

// ── R1：权限日志语义（只读 auto_allow / 敏感 allow / 拒绝 deny）─────────────

/** 从会话 jsonl 读取所有 permission 记录的 effect。 */
function permissionEffects(logFile: string): string[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { kind: string; payload: { effect?: string } })
    .filter((r) => r.kind === 'permission')
    .map((r) => r.payload.effect ?? '');
}

describe('runAgent —— 权限日志语义 (R1)', () => {
  it('只读工具自动放行记为 auto_allow（不与用户授权混淆）', async () => {
    const tools = new ToolRegistry([makeReadTool([])]);
    const session = new Session({ rootDir, id: 'auto' });
    const permission = new Permission(allowAsker);
    const provider = new MockProvider({
      scripts: [scriptToolCall('c', 'echo', {}), scriptText('done')],
    });
    const { onEvent } = collector();
    await runAgent('x', { provider, tools, permission, session }, {
      model: 'm', maxTurns: 25, signal: new AbortController().signal, onEvent,
    });
    expect(permissionEffects(session.logFile)).toEqual(['auto_allow']);
  });

  it('敏感工具经用户允许记为 allow', async () => {
    const tools = new ToolRegistry([makeWriteTool({ executed: false })]);
    const session = new Session({ rootDir, id: 'allow' });
    const permission = new Permission(allowAsker);
    const provider = new MockProvider({
      scripts: [scriptToolCall('w', 'do_write', {}), scriptText('done')],
    });
    const { onEvent } = collector();
    await runAgent('x', { provider, tools, permission, session }, {
      model: 'm', maxTurns: 25, signal: new AbortController().signal, onEvent,
    });
    expect(permissionEffects(session.logFile)).toEqual(['allow']);
  });

  it('敏感工具被拒绝记为 deny', async () => {
    const tools = new ToolRegistry([makeWriteTool({ executed: false })]);
    const session = new Session({ rootDir, id: 'deny2' });
    const permission = new Permission(denyAsker);
    const provider = new MockProvider({
      scripts: [scriptToolCall('w', 'do_write', {}), scriptText('done')],
    });
    const { onEvent } = collector();
    await runAgent('x', { provider, tools, permission, session }, {
      model: 'm', maxTurns: 25, signal: new AbortController().signal, onEvent,
    });
    expect(permissionEffects(session.logFile)).toEqual(['deny']);
  });
});
