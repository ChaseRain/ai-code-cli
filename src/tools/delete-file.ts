// src/tools/delete-file.ts
// delete_file：删除单个文件或空目录（非只读，需权限）。限项目根内。
// 边界（tools.md T1）：不递归删非空目录（防误删整树）；不删项目根本身；越界即拒绝。

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { resolveInRoot, PathEscapeError } from './path-guard.js';
import { validateArgs } from './validate-args.js';

interface DeleteFileArgs {
  /** 相对项目根的文件或空目录路径 */
  path?: string;
}

export const deleteFile: Tool = {
  name: 'delete_file',
  description:
    '删除单个文件或空目录（不递归删非空目录，避免误删整树）。限项目根内；目标不存在或为非空目录时报错。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根的文件或空目录路径' },
    },
    required: ['path'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    // T2：统一形参校验（必填 + 类型）。
    const bad = validateArgs('delete_file', args, [{ name: 'path', type: 'string' }]);
    if (bad) return bad;
    const { path: file } = (args ?? {}) as DeleteFileArgs;
    try {
      const abs = resolveInRoot(ctx.rootDir, file!);
      // 不允许删项目根本身。
      if (abs === path.resolve(ctx.rootDir)) {
        return { ok: false, error: `删除失败：不允许删除项目根目录` };
      }
      let st;
      try {
        st = await fs.lstat(abs);
      } catch {
        return { ok: false, error: `删除失败：${file} 不存在` };
      }
      if (st.isDirectory()) {
        const entries = await fs.readdir(abs);
        if (entries.length > 0) {
          return {
            ok: false,
            error: `删除失败：${file} 为非空目录（仅支持删空目录，请逐项删除或改用 run_shell）`,
          };
        }
        await fs.rmdir(abs);
        return { ok: true, content: `已删除 ${file}（空目录）` };
      }
      await fs.unlink(abs);
      return { ok: true, content: `已删除 ${file}` };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `删除失败：${(err as Error).message}` };
    }
  },
};
