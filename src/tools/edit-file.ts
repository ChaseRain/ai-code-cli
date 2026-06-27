// src/tools/edit-file.ts
// edit_file：字符串精确替换（非只读，需权限）。old_string 必须在文件中唯一，否则报错且不写入。

import fs from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { resolveInRoot, PathEscapeError } from './path-guard.js';

interface EditFileArgs {
  /** 相对项目根的文件路径 */
  path?: string;
  /** 待替换的原文片段，须在文件中唯一出现 */
  old_string?: string;
  /** 替换后的新文片段 */
  new_string?: string;
}

/** 统计 needle 在 haystack 中的非重叠出现次数。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editFile: Tool = {
  name: 'edit_file',
  description:
    '在文件中把 old_string 精确替换为 new_string。old_string 必须在文件中唯一出现，否则报错且不写入。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根的文件路径' },
      old_string: { type: 'string', description: '待替换的原文片段，须在文件中唯一出现' },
      new_string: { type: 'string', description: '替换后的新文片段' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: file, old_string, new_string } = (args ?? {}) as EditFileArgs;
    if (!file) return { ok: false, error: 'edit_file 缺少参数：path' };
    if (old_string === undefined) return { ok: false, error: 'edit_file 缺少参数：old_string' };
    if (new_string === undefined) return { ok: false, error: 'edit_file 缺少参数：new_string' };
    if (old_string === new_string) {
      return { ok: false, error: 'old_string 与 new_string 相同，无需编辑' };
    }
    try {
      const abs = resolveInRoot(ctx.rootDir, file);
      const content = await fs.readFile(abs, 'utf8');
      const n = countOccurrences(content, old_string);
      if (n === 0) {
        return { ok: false, error: `old_string 未在 ${file} 中找到` };
      }
      if (n > 1) {
        return {
          ok: false,
          error: `old_string 在 ${file} 中出现 ${n} 次（须唯一）；请扩大上下文使其唯一`,
        };
      }
      const next = content.replace(old_string, new_string);
      await fs.writeFile(abs, next, 'utf8');
      return { ok: true, content: `已编辑 ${file}（替换 1 处）` };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `编辑文件失败：${(err as Error).message}` };
    }
  },
};
