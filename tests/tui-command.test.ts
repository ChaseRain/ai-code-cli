// tests/tui-command.test.ts
// 覆盖 tui.md「命令解析单测（含 /model <id> 带参）」。纯函数，无渲染依赖。

import { describe, it, expect } from 'vitest';
import { parseInput, HELP_TEXT } from '../src/tui/command.js';

describe('parseInput —— 内置命令解析', () => {
  it('非 / 开头视为任务，保留原文并去首尾空白', () => {
    expect(parseInput('  帮我重构 foo.ts  ')).toEqual({
      kind: 'task',
      text: '帮我重构 foo.ts',
    });
  });

  it('斜杠命令大小写不敏感', () => {
    expect(parseInput('/HELP')).toEqual({ kind: 'help' });
    expect(parseInput('/Status')).toEqual({ kind: 'status' });
    expect(parseInput('/Clear')).toEqual({ kind: 'clear' });
  });

  it('/quit 是 /exit 的别名', () => {
    expect(parseInput('/exit')).toEqual({ kind: 'exit' });
    expect(parseInput('/quit')).toEqual({ kind: 'exit' });
  });

  it('/model 无参为查看', () => {
    expect(parseInput('/model')).toEqual({ kind: 'model', id: undefined });
  });

  it('/model <id> 带参为切换，多空格归一', () => {
    expect(parseInput('/model deepseek/deepseek-v4-pro')).toEqual({
      kind: 'model',
      id: 'deepseek/deepseek-v4-pro',
    });
    expect(parseInput('/model   gpt-x  ')).toEqual({ kind: 'model', id: 'gpt-x' });
  });

  it('未知命令返回 unknown 并带命令名', () => {
    expect(parseInput('/foobar x y')).toEqual({ kind: 'unknown', name: 'foobar' });
  });

  // R2：记忆增强命令解析
  it('/resume 无参恢复最近会话；带参指定文件', () => {
    expect(parseInput('/resume')).toEqual({ kind: 'resume', file: undefined });
    expect(parseInput('/resume /tmp/a.jsonl')).toEqual({
      kind: 'resume',
      file: '/tmp/a.jsonl',
    });
    expect(parseInput('/resume latest')).toEqual({
      kind: 'resume',
      file: 'latest',
    });
  });

  it('/sessions 列出本地历史会话', () => {
    expect(parseInput('/sessions')).toEqual({ kind: 'sessions' });
  });

  it('/memory 查看记忆状态', () => {
    expect(parseInput('/memory')).toEqual({ kind: 'memory' });
    expect(parseInput('/MEMORY')).toEqual({ kind: 'memory' });
  });

  it('M6 checkpoint 命令解析', () => {
    expect(parseInput('/checkpoint')).toEqual({ kind: 'checkpoint', label: undefined });
    expect(parseInput('/checkpoint before edit')).toEqual({
      kind: 'checkpoint',
      label: 'before edit',
    });
    expect(parseInput('/checkpoints')).toEqual({ kind: 'checkpoints' });
    expect(parseInput('/restore')).toEqual({ kind: 'restore', id: undefined });
    expect(parseInput('/restore cp-1')).toEqual({ kind: 'restore', id: 'cp-1' });
  });

  it('M8 diff/git 命令解析', () => {
    expect(parseInput('/changes')).toEqual({ kind: 'changes' });
    expect(parseInput('/diff')).toEqual({ kind: 'diff', path: undefined });
    expect(parseInput('/diff src/tui/App.tsx')).toEqual({
      kind: 'diff',
      path: 'src/tui/App.tsx',
    });
    expect(parseInput('/undo-last')).toEqual({ kind: 'undo-last' });
  });

  // TP5：Task Plan 命令解析
  it('/plan 查看；/plan clear 清空；大小写不敏感', () => {
    expect(parseInput('/plan')).toEqual({ kind: 'plan', sub: undefined });
    expect(parseInput('/plan clear')).toEqual({ kind: 'plan', sub: 'clear' });
    expect(parseInput('/PLAN CLEAR')).toEqual({ kind: 'plan', sub: 'clear' });
    expect(parseInput('/plan something')).toEqual({ kind: 'plan', sub: undefined });
  });

  // 防漂移：HELP_TEXT 必须包含 /plan（命令与帮助文案不脱节）
  it('HELP_TEXT 含 /plan', () => {
    expect(HELP_TEXT).toContain('/plan');
  });
});
