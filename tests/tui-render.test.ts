// tests/tui-render.test.ts
// 覆盖 tui.md「Ink render 冒烟」(R4)：用 ink-testing-library 渲染真实 TUI 组件，
// 断言 ① 启动欢迎/状态栏；② 工具调用 + 工具结果行；③ 权限弹窗（“需要授权” + y/a/n）；
// ④ 状态栏状态流（等待授权）。用 React.createElement 避免 JSX 配置。
// 渲染的是 App 真正使用的同一批组件（MessageList / PermissionPrompt / StatusBar），确定性强、不依赖 stdin 时序。

import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  App,
  MessageList,
  PermissionPrompt,
  RestorePrompt,
  StatusBar,
  messagesToView,
  formatMemoryStatus,
  describeSummarizer,
  RESUME_SUMMARY_BRIDGE,
} from '../src/tui/App.js';
import { MockProvider } from '../src/provider/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  Session,
  createHeuristicSummarizer,
  createSummarizer,
} from '../src/session/index.js';
import type { MemoryCompactionOptions } from '../src/agent/index.js';
import { PlanStore, formatPlanSnapshot } from '../src/plan/index.js';
import type { ViewMessage } from '../src/tui/messages.js';
import type { Message } from '../src/core/types.js';

let rootDir: string;
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'ai-code-cli-render-'));
});
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('TUI 渲染冒烟 (R4)', () => {
  it('① 启动：完整 <App> 渲染出欢迎语 + 状态栏', () => {
    const tools = new ToolRegistry([]);
    const session = new Session({ rootDir, id: 'startup' });
    const { lastFrame, unmount } = render(
      React.createElement(App, {
        tools,
        session,
        initialModel: 'deepseek/deepseek-v4-pro',
        baseURL: 'https://ai-kas.kso.net/codeplan/anthropic',
        maxTurns: 25,
        apiKeyConfigured: true,
        makeProvider: () => new MockProvider({ scripts: [] }),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('终端编码 Agent');
    expect(frame).toContain('deepseek/deepseek-v4-pro');
    expect(frame).toContain('Key');
    unmount();
  });

  it('② 消息流：工具调用行 + 工具结果行', () => {
    const messages: ViewMessage[] = [
      { kind: 'user', text: '帮我写文件' },
      { kind: 'tool-call', id: 'w1', name: 'write_file', args: { path: 'hello.txt' } },
      { kind: 'tool-result', id: 'w1', name: 'write_file', result: { ok: true, content: 'written' } },
    ];
    const { lastFrame, unmount } = render(
      React.createElement(MessageList, { messages }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('调用');
    expect(frame).toContain('write_file');
    expect(frame).toContain('hello.txt');
    expect(frame).toContain('✓'); // 成功结果标记
    unmount();
  });

  it('③ 权限弹窗：需要授权 + [y]/[a]/[n] 选项', () => {
    const { lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, {
        tool: 'write_file',
        args: { path: 'hello.txt' },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('需要授权');
    expect(frame).toContain('write_file');
    expect(frame).toMatch(/\[y\]/);
    expect(frame).toMatch(/\[a\]/);
    expect(frame).toMatch(/\[n\]/);
    unmount();
  });

  it('③b restore 确认提示：恢复前必须显式确认', () => {
    const { lastFrame, unmount } = render(
      React.createElement(RestorePrompt, { id: 'cp-1' }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('确认恢复 checkpoint');
    expect(frame).toContain('cp-1');
    expect(frame).toMatch(/\[y\]/);
    expect(frame).toMatch(/\[n\]/);
    unmount();
  });

  it('③c memory 压缩事件作为 system 消息可见', () => {
    const messages: ViewMessage[] = [
      { kind: 'system', text: '已自动压缩上下文：压缩了 10 条旧消息' },
    ];
    const { lastFrame, unmount } = render(React.createElement(MessageList, { messages }));
    expect(lastFrame() ?? '').toContain('已自动压缩上下文');
    unmount();
  });

  // R1：/resume 不把内部 system prompt 刷屏（messagesToView 不渲染 system）
  it('⑤ messagesToView 不渲染内部 system prompt（防 /resume 刷屏泄漏）', () => {
    const LONG_SYSTEM = '你是一个运行在终端里的编码 Agent…'.repeat(50);
    const msgs: Message[] = [
      { role: 'system', content: LONG_SYSTEM },
      { role: 'user', content: '帮我读文件' },
      {
        role: 'assistant',
        content: '好',
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'body', ok: true },
    ];
    const view = messagesToView(msgs);
    // 不含任何 system 视图项，也不含长 system 文本
    expect(view.some((v) => v.kind === 'system')).toBe(false);
    expect(view.some((v) => v.kind === 'user')).toBe(true);
    expect(view.some((v) => v.kind === 'tool-call' && v.name === 'read_file')).toBe(true);
    // 渲染出来也不应出现 system prompt 内容
    const { lastFrame, unmount } = render(React.createElement(MessageList, { messages: view }));
    expect(lastFrame() ?? '').not.toContain('运行在终端里的编码 Agent');
    unmount();
  });

  // TP5：/plan 在 TUI 的展示路径（系统消息 = formatPlanSnapshot 的输出）
  it('⑥ Task Plan：/plan 展示当前计划（步骤 + 状态）', () => {
    const store = new PlanStore();
    store.update({
      explanation: '三步走',
      items: [
        { step: '读取', status: 'completed' },
        { step: '修改', status: 'in_progress' },
        { step: '测试', status: 'pending' },
      ],
    });
    // /plan 命令把 formatPlanSnapshot 的结果作为 system 消息 push 进消息流。
    const messages: ViewMessage[] = [
      { kind: 'system', text: formatPlanSnapshot(store.current()) },
    ];
    const { lastFrame, unmount } = render(React.createElement(MessageList, { messages }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('任务计划');
    expect(frame).toContain('读取');
    expect(frame).toContain('修改');
    expect(frame).toContain('in_progress');
    unmount();
  });

  // ── Phase-9 M3/M4：/memory 展示生效配置 + /resume 桥接提示（纯函数，确定性）──
  it('⑦ formatMemoryStatus：展示生效记忆配置（enabled / 阈值 / summarizer 类型）', () => {
    const memory: MemoryCompactionOptions = {
      thresholdMsgs: 33,
      keepRecent: 7,
      thresholdTokens: 12345,
      keepRecentTokens: 6000,
      summarizer: createSummarizer('llm', new MockProvider({ scripts: [] }), 'm'),
    };
    const text = formatMemoryStatus(
      { messages: 9, system: 2, hasSummary: true, logFile: '/tmp/x.jsonl' },
      memory,
      describeSummarizer(memory.summarizer),
    );
    expect(text).toContain('记忆配置');
    expect(text).toContain('自动压缩：开启');
    expect(text).toContain('33');
    expect(text).toContain('12345');
    expect(text).toContain('llm（失败降级 heuristic）');
    expect(text).toContain('含历史摘要：是');
  });

  it('⑦b formatMemoryStatus：enabled=false 时展示关闭', () => {
    const text = formatMemoryStatus(
      { messages: 3, system: 1, hasSummary: false, logFile: '/tmp/y.jsonl' },
      undefined,
      'heuristic',
    );
    expect(text).toContain('自动压缩：关闭');
  });

  it('⑦c describeSummarizer：heuristic 标签', () => {
    expect(describeSummarizer(createHeuristicSummarizer())).toBe('heuristic');
  });

  it('⑧ /resume 桥接提示文案含 /diff 与 /clear 引导', () => {
    expect(RESUME_SUMMARY_BRIDGE).toContain('历史摘要');
    expect(RESUME_SUMMARY_BRIDGE).toContain('/diff');
    expect(RESUME_SUMMARY_BRIDGE).toContain('/clear');
    // 渲染为 system 消息可见。
    const { lastFrame, unmount } = render(
      React.createElement(MessageList, {
        messages: [{ kind: 'system', text: RESUME_SUMMARY_BRIDGE }],
      }),
    );
    expect(lastFrame() ?? '').toContain('/diff');
    unmount();
  });

  it('④ 状态栏：等待授权状态流', () => {
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'deepseek/deepseek-v4-pro',
        phase: 'awaiting-permission',
        turn: 1,
        maxTurns: 25,
        apiKeyConfigured: true,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('等待授权');
    expect(frame).toContain('1/25');
    unmount();
  });
});
