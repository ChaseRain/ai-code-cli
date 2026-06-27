// src/tui/command.ts
// 内置 `/` 命令解析 —— 纯函数，无 IO、无渲染，便于单测（tui.md「命令解析单测」）。
// 解析职责单一：把一行输入判定为「内置命令」或「自然语言任务」，命令再带参。

/** 解析结果：判别联合。命令一律小写归一，未知命令也照样返回（由 UI 友好提示）。 */
export type ParsedInput =
  | { kind: 'task'; text: string } // 非 / 开头：作为任务交给 Agent
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'status' }
  | { kind: 'exit' }
  | { kind: 'model'; id?: string } // /model 查看；/model <id> 切换
  | { kind: 'unknown'; name: string }; // 未知 / 命令

/**
 * 解析一行用户输入。
 * - 空白 / 非 `/` 开头 → task（保留原文，去首尾空白）。
 * - `/cmd args...` → 对应命令；`/model <id>` 提取参数；其余忽略多余参数。
 * 命令名大小写不敏感；`/quit` 视作 `/exit` 的别名。
 */
export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();
  if (!text.startsWith('/')) {
    return { kind: 'task', text };
  }

  // 去掉前导 /，按空白切分：第一段是命令名，其余是参数。
  const [nameRaw, ...rest] = text.slice(1).split(/\s+/);
  const name = nameRaw.toLowerCase();
  const arg = rest.join(' ').trim();

  switch (name) {
    case 'help':
      return { kind: 'help' };
    case 'clear':
      return { kind: 'clear' };
    case 'status':
      return { kind: 'status' };
    case 'exit':
    case 'quit':
      return { kind: 'exit' };
    case 'model':
      return { kind: 'model', id: arg.length ? arg : undefined };
    default:
      return { kind: 'unknown', name };
  }
}

/** `/help` 的展示文案（集中一处，UI 与测试共享单一真相）。 */
export const HELP_TEXT = [
  '可用命令：',
  '  /help          显示本帮助',
  '  /clear         清空当前会话上下文（开新日志）',
  '  /model         查看当前模型',
  '  /model <id>    切换模型',
  '  /status        显示模型 / baseURL / 轮次 / Key 是否已配置',
  '  /exit, /quit   退出',
  '',
  '直接输入文字即可作为任务下达给 Agent。',
].join('\n');
