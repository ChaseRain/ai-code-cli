// src/tools/glob.ts
// glob：用 fast-glob 匹配文件路径（只读）。结果限项目根内，返回相对根的路径。

import fg from 'fast-glob';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import {
  resolveInRoot,
  assertGlobInRoot,
  globLiteralPrefix,
  PathEscapeError,
} from './path-guard.js';

interface GlobArgs {
  /** glob 模式，如 src 下递归匹配 .ts */
  pattern?: string;
  /** 相对项目根的搜索基目录；缺省为根 */
  cwd?: string;
}

/** 返回结果上限，避免巨量输出挤占上下文。 */
const MAX_RESULTS = 1000;

export const glob: Tool = {
  name: 'glob',
  description:
    "按 glob 模式匹配文件路径（如 'src/**/*.ts'），返回相对项目根的路径列表。仅匹配项目根内文件。",
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: "glob 模式，如 'src/**/*.ts'" },
      cwd: { type: 'string', description: '相对项目根的搜索基目录，缺省为根' },
    },
    required: ['pattern'],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, cwd } = (args ?? {}) as GlobArgs;
    if (!pattern) return { ok: false, error: 'glob 缺少参数：pattern' };
    try {
      const root = path.resolve(ctx.rootDir);
      // P7-E：pattern 不得经 .. / 绝对路径逃逸（fast-glob 不净化 ..）。
      assertGlobInRoot(pattern);
      // cwd 折进 pattern 前缀；额外 lexical + realpath 校验（防 .. 与 symlink cwd）。
      let base = '';
      if (cwd) {
        assertGlobInRoot(cwd);
        resolveInRoot(root, cwd); // 越界（含 symlink）抛 PathEscapeError
        base = `${cwd.split(path.sep).join('/').replace(/\/$/, '')}/`;
      }
      const effective = base ? base + pattern : pattern;
      // P7-E：literal 前缀若是指向 root 外的 symlink，显式拒绝（可审计）。
      const prefix = globLiteralPrefix(effective);
      if (prefix) resolveInRoot(root, prefix);

      const matches = await fg(effective, {
        cwd: root,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
      });

      // 后置防御：命中结果逐一 realpath 校验，丢弃越界项（symlink 等兜底）。
      const safe = matches.filter((rel) => {
        try {
          resolveInRoot(root, rel);
          return true;
        } catch {
          return false;
        }
      });

      if (safe.length === 0) {
        return { ok: true, content: '(无匹配)' };
      }
      const sorted = safe.sort();
      const shown = sorted.slice(0, MAX_RESULTS);
      const notice =
        sorted.length > MAX_RESULTS
          ? `\n…(共 ${sorted.length} 项，已截断至前 ${MAX_RESULTS})`
          : '';
      return { ok: true, content: shown.join('\n') + notice };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `glob 失败：${(err as Error).message}` };
    }
  },
};
