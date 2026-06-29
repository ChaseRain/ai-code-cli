// src/tools/write-file.ts
// write_file：整文件写入/新建（非只读，需权限）。自动建父目录。限项目根内。

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { resolveInRoot, PathEscapeError } from './path-guard.js';
import { MAX_TOOL_FILE_BYTES, humanBytes } from './limits.js';

interface WriteFileArgs {
  /** 相对项目根的文件路径 */
  path?: string;
  /** 要写入的完整内容（覆盖原文件） */
  content?: string;
}

export const writeFile: Tool = {
  name: 'write_file',
  description: '把内容整体写入文件（存在则覆盖，不存在则新建，自动创建父目录）。限项目根内。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根的文件路径' },
      content: { type: 'string', description: '要写入的完整内容（覆盖原文件）' },
    },
    required: ['path', 'content'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: file, content } = (args ?? {}) as WriteFileArgs;
    if (!file) return { ok: false, error: 'write_file 缺少参数：path' };
    if (content === undefined) return { ok: false, error: 'write_file 缺少参数：content' };
    // P7-B：写入内容字节上限。
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_TOOL_FILE_BYTES) {
      return {
        ok: false,
        error: `写入内容过大：${humanBytes(bytes)} > 上限 ${humanBytes(MAX_TOOL_FILE_BYTES)}；请拆分或改用 run_shell`,
      };
    }
    try {
      const abs = resolveInRoot(ctx.rootDir, file);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      return { ok: true, content: `已写入 ${file}（${bytes} 字节）` };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `写文件失败：${(err as Error).message}` };
    }
  },
};
