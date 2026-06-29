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
  | { kind: 'resume'; file?: string } // /resume 恢复最近会话；/resume <path> 指定
  | { kind: 'sessions' }
  | { kind: 'memory' } // /memory 查看记忆状态
  | { kind: 'checkpoint'; label?: string }
  | { kind: 'checkpoints' }
  | { kind: 'rewind'; id?: string } // /rewind 打开快照选择器回滚；/rewind <id> 直接回滚
  | { kind: 'restore'; id?: string }
  | { kind: 'changes' }
  | { kind: 'diff'; path?: string }
  | { kind: 'undo-last' }
  | { kind: 'plan'; sub?: 'clear' } // /plan 查看；/plan clear 清空
  | { kind: 'skills'; name?: string } // /skills 列目录；/skills <name> 看正文
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
    case 'resume':
      return { kind: 'resume', file: arg.length ? arg : undefined };
    case 'sessions':
      return { kind: 'sessions' };
    case 'memory':
      return { kind: 'memory' };
    case 'checkpoint':
      return { kind: 'checkpoint', label: arg.length ? arg : undefined };
    case 'checkpoints':
      return { kind: 'checkpoints' };
    case 'rewind':
      return { kind: 'rewind', id: arg.length ? arg : undefined };
    case 'restore':
      return { kind: 'restore', id: arg.length ? arg : undefined };
    case 'changes':
      return { kind: 'changes' };
    case 'diff':
      return { kind: 'diff', path: arg.length ? arg : undefined };
    case 'undo-last':
      return { kind: 'undo-last' };
    case 'plan':
      return { kind: 'plan', sub: arg.toLowerCase() === 'clear' ? 'clear' : undefined };
    case 'skills':
      return { kind: 'skills', name: arg.length ? arg : undefined };
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
  '  /resume        打开会话选择器恢复（/resume <path> 直接恢复指定日志）',
  '  /sessions      打开会话选择器（/resume 的别名）',
  '  /memory        查看记忆状态（消息数 / 是否含摘要 / 当前日志）',
  '  /rewind        打开快照选择器回滚（↑/↓ 选 · Enter 确认 · Esc 取消）',
  '  /rewind <id>   直接回滚到指定 checkpoint',
  '  /checkpoint    创建本地可恢复快照（可加 label）',
  '  /checkpoints   列出本地 checkpoint',
  '  /restore <id>  同 /rewind <id>，确认后恢复指定 checkpoint',
  '  /changes       查看 Git/工作区变更概览',
  '  /diff [path]   查看全部或指定路径 diff',
  '  /undo-last     确认后恢复最近一次自动 checkpoint',
  '  /plan          查看当前任务计划',
  '  /plan clear    清空当前任务计划',
  '  /skills        列出可用技能（/skills <name> 查看某技能完整说明）',
  '  /exit, /quit   退出',
  '',
  '直接输入文字即可作为任务下达给 Agent。',
].join('\n');
