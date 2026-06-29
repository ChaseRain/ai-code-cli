// src/tools/move-file.ts
// move_file：移动 / 重命名文件或目录（非只读，需权限）。源与目标均限项目根内。
// 边界（tools.md T1）：源/目标都做 realpath 沙箱守护（防移出根 / 从根外移入）；
//   目标已存在不静默覆盖；目标父目录不存在则自动创建。

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { resolveInRoot, PathEscapeError } from './path-guard.js';
import { validateArgs } from './validate-args.js';

interface MoveFileArgs {
  /** 相对项目根的源路径 */
  from?: string;
  /** 相对项目根的目标路径 */
  to?: string;
}

export const moveFile: Tool = {
  name: 'move_file',
  description:
    '移动或重命名文件/目录（from → to）。源与目标均限项目根内；目标已存在时报错（不覆盖），目标父目录不存在则自动创建。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '相对项目根的源路径' },
      to: { type: 'string', description: '相对项目根的目标路径' },
    },
    required: ['from', 'to'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    // T2：统一形参校验（from/to 均必填、均为字符串）。
    const bad = validateArgs('move_file', args, [
      { name: 'from', type: 'string' },
      { name: 'to', type: 'string' },
    ]);
    if (bad) return bad;
    const { from, to } = (args ?? {}) as MoveFileArgs;
    try {
      // 源与目标分别经沙箱守护（任一越界即拒绝）。
      const absFrom = resolveInRoot(ctx.rootDir, from!);
      const absTo = resolveInRoot(ctx.rootDir, to!);
      // 源不存在。
      try {
        await fs.lstat(absFrom);
      } catch {
        return { ok: false, error: `移动失败：源 ${from} 不存在` };
      }
      // 目标已存在不覆盖。
      let toExists = true;
      try {
        await fs.lstat(absTo);
      } catch {
        toExists = false;
      }
      if (toExists) {
        return { ok: false, error: `移动失败：目标 ${to} 已存在（不覆盖，请先删除或换名）` };
      }
      // 目标父目录不存在则自动创建。
      await fs.mkdir(path.dirname(absTo), { recursive: true });
      await fs.rename(absFrom, absTo);
      return { ok: true, content: `已移动 ${from} → ${to}` };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `移动失败：${(err as Error).message}` };
    }
  },
};
