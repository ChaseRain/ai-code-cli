// src/tui/messages.ts
// TUI 消息流的视图模型 —— 区分 user / assistant / tool-call / tool-result / permission / error / system。
// 这是「渲染层私有」的展示结构（不同于 core 的 Message 上下文模型）：
// 它要表达 UI 关心的东西（流式拼接中的 assistant、工具调用与其结果的配对、系统提示行）。

import type { ToolResult } from '../core/types.js';

/** 消息流里的一条可渲染记录。 */
export type ViewMessage =
  | { kind: 'user'; text: string }
  // assistant：streaming 期间 text 持续增长，done 后定型。
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'tool-result'; id: string; name: string; result: ToolResult }
  // permission：一次权限决策的记录（用于回看）。
  | { kind: 'permission'; tool: string; effect: 'allow' | 'deny' | 'always' }
  | { kind: 'error'; text: string }
  // system：本地系统提示（/help、/status、欢迎语等），不属于对话上下文。
  | { kind: 'system'; text: string };

/** 把任意参数对象压成单行摘要，避免刷屏（权限弹窗与工具块共用）。 */
export function summarizeArgs(args: unknown, max = 120): string {
  let s: string;
  try {
    s = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  if (s === undefined) s = '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
