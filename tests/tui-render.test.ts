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

import { App, MessageList, PermissionPrompt, StatusBar, messagesToView } from '../src/tui/App.js';
import { MockProvider } from '../src/provider/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Session } from '../src/session/index.js';
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
