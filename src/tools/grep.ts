// src/tools/grep.ts
// grep：内容正则搜索（只读）。返回 file:line:match。限项目根内。
// 纯 JS 实现（不依赖外部 ripgrep），用 fast-glob 列文件再逐行匹配。

import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';

interface GrepArgs {
  /** 正则表达式（JS 语法） */
  pattern?: string;
  /** 限定搜索的文件 glob；缺省全仓递归 */
  include?: string;
  /** 大小写不敏感；缺省 false */
  ignoreCase?: boolean;
}

/** 返回匹配行上限。 */
const MAX_MATCHES = 500;

export const grep: Tool = {
  name: 'grep',
  description:
    "用正则在文件内容中搜索，返回 'file:line:匹配行'。可用 include 限定文件 glob。仅搜索项目根内文件。",
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（JS 语法）' },
      include: { type: 'string', description: "限定搜索的文件 glob，缺省 '**/*'" },
      ignoreCase: { type: 'boolean', description: '大小写不敏感，缺省 false' },
    },
    required: ['pattern'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, include = '**/*', ignoreCase = false } = (args ?? {}) as GrepArgs;
    if (!pattern) return { ok: false, error: 'grep 缺少参数：pattern' };

    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (err) {
      return { ok: false, error: `非法正则：${(err as Error).message}` };
    }

    try {
      const root = path.resolve(ctx.rootDir);
      const files = await fg(include, {
        cwd: root,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
      });

      const out: string[] = [];
      let truncated = false;
      for (const rel of files.sort()) {
        if (ctx.signal.aborted) return { ok: false, error: 'grep 被中断' };
        let content: string;
        try {
          content = await fs.readFile(path.join(root, rel), 'utf8');
        } catch {
          continue; // 二进制/无权限文件跳过
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${rel}:${i + 1}:${lines[i]}`);
            if (out.length >= MAX_MATCHES) {
              truncated = true;
              break;
            }
          }
        }
        if (truncated) break;
      }

      if (out.length === 0) return { ok: true, content: '(无匹配)' };
      const notice = truncated ? `\n…(匹配过多，已截断至前 ${MAX_MATCHES})` : '';
      return { ok: true, content: out.join('\n') + notice };
    } catch (err) {
      return { ok: false, error: `grep 失败：${(err as Error).message}` };
    }
  },
};
