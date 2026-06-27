// src/tools/path-guard.ts
// 路径守护：把工具传入的相对/绝对路径解析为绝对路径，并强制落在 rootDir 内。
// 越界（../ 逃逸、绝对路径逃逸、符号链接式越界）一律视为错误，由调用方归一为 ToolResult{ok:false}。

import path from 'node:path';

/** 越界错误的判别标志，调用方据此生成统一的 error 文案。 */
export class PathEscapeError extends Error {
  constructor(public readonly attempted: string) {
    super(`路径越界：${attempted} 不在项目根内`);
    this.name = 'PathEscapeError';
  }
}

/**
 * 把一个用户/模型给定的路径解析为「保证落在 rootDir 内」的绝对路径。
 * - 相对路径相对 rootDir 解析；绝对路径直接采用其规范化结果。
 * - 解析后必须等于 rootDir 或以 rootDir + sep 为前缀，否则抛 PathEscapeError。
 * @param rootDir 项目根（应为绝对路径）
 * @param target  目标路径（相对或绝对）
 */
export function resolveInRoot(rootDir: string, target: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, target);
  // 等于根，或位于根之下（用 sep 防止 /root 命中 /root-evil）
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(target);
  }
  return resolved;
}
