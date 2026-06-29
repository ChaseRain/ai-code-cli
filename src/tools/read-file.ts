// src/tools/read-file.ts
// read_file：读文件（带行号、可分段、大文件截断）。只读，限项目根内。

import fs from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { resolveInRoot, PathEscapeError } from './path-guard.js';
import { MAX_TOOL_FILE_BYTES, humanBytes } from './limits.js';

interface ReadFileArgs {
  /** 相对项目根的文件路径 */
  path?: string;
  /** 起始行（1 基，含）；缺省 1 */
  offset?: number;
  /** 读取行数；缺省读到上限 */
  limit?: number;
}

/** 默认最多返回的行数，超出截断并提示。 */
const MAX_LINES = 2000;
/** 单行最大字符数，超出截断。 */
const MAX_LINE_LEN = 2000;

export const readFile: Tool = {
  name: 'read_file',
  description:
    '读取文本文件内容，返回带行号的文本。可用 offset/limit 分段读取；大文件会被截断并提示。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根的文件路径' },
      offset: { type: 'integer', description: '起始行（1 基，含），缺省 1' },
      limit: { type: 'integer', description: '读取行数，缺省读到上限' },
    },
    required: ['path'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: file, offset, limit } = (args ?? {}) as ReadFileArgs;
    if (!file) return { ok: false, error: 'read_file 缺少参数：path' };
    try {
      const abs = resolveInRoot(ctx.rootDir, file);
      // P7-B：先 stat，超上限直接拒绝（不整文件读入内存）。
      const st = await fs.stat(abs);
      if (st.size > MAX_TOOL_FILE_BYTES) {
        return {
          ok: false,
          error: `文件过大：${file}（${humanBytes(st.size)} > 上限 ${humanBytes(MAX_TOOL_FILE_BYTES)}）；请用 grep/glob 或 run_shell 分段处理`,
        };
      }
      const raw = await fs.readFile(abs, 'utf8');
      const allLines = raw.split('\n');
      // 处理末尾换行造成的空末行
      if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }
      const start = Math.max(1, offset ?? 1);
      const cap = Math.min(limit ?? MAX_LINES, MAX_LINES);
      const slice = allLines.slice(start - 1, start - 1 + cap);

      const body = slice
        .map((line, i) => {
          const n = start + i;
          const text =
            line.length > MAX_LINE_LEN
              ? line.slice(0, MAX_LINE_LEN) + ' …(行过长已截断)'
              : line;
          return `${n}\t${text}`;
        })
        .join('\n');

      const remaining = allLines.length - (start - 1) - slice.length;
      const notice =
        remaining > 0 ? `\n…(还有 ${remaining} 行未显示，使用 offset/limit 继续读取)` : '';

      return { ok: true, content: body + notice };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `读文件失败：${(err as Error).message}` };
    }
  },
};
