// src/tools/list-dir.ts
// list_dir：列出目录直接子项（只读）。限项目根内。

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { resolveInRoot, PathEscapeError } from './path-guard.js';

interface ListDirArgs {
  /** 相对项目根的目录路径；缺省为根 '.' */
  path?: string;
}

export const listDir: Tool = {
  name: 'list_dir',
  description: '列出指定目录下的直接子项（文件与子目录），限项目根内。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: "相对项目根的目录路径，缺省为根 '.'",
      },
    },
    required: [],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: dir = '.' } = (args ?? {}) as ListDirArgs;
    try {
      const abs = resolveInRoot(ctx.rootDir, dir);
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) {
        return { ok: false, error: `不是目录：${dir}` };
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      if (entries.length === 0) {
        return { ok: true, content: '(空目录)' };
      }
      // 目录在前、名字升序，目录名后缀 '/'
      const lines = entries
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
        )
        .map((e) => (e.isDir ? `${e.name}/` : e.name));
      return { ok: true, content: lines.join('\n') };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `列目录失败：${(err as Error).message}` };
    }
  },
};
