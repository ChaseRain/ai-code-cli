// src/tools/path-guard.ts
// 路径守护：把工具传入的相对/绝对路径解析为绝对路径，并强制落在 rootDir 内。
// 两道防线（Phase-7 P7-A）：
//   ① lexical：path.resolve 后必须在 root 之下（防 ../ 逃逸、绝对路径逃逸）。
//   ② realpath：目标（或其最近存在的祖先）的 realpath 必须在 realpath(root) 之下——
//      防经符号链接读/写出 root（lexical 检查挡不住 symlink）。
// 返回 lexical 解析后的绝对路径（OS 会自行跟随 symlink 读写），调用方无需改动。

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** 越界错误的判别标志，调用方据此生成统一的 error 文案。 */
export class PathEscapeError extends Error {
  constructor(public readonly attempted: string) {
    super(`路径越界：${attempted} 不在项目根内`);
    this.name = 'PathEscapeError';
  }
}

/** realpath，失败（不存在/权限）返回 null。 */
function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 找到一个路径的「最近存在祖先」（含自身）。用于校验尚不存在的新建目标。 */
function nearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur; // 到达根
    cur = parent;
  }
}

/** real 是否落在 rootReal 内（等于根或位于根之下）。 */
function within(real: string, rootReal: string): boolean {
  return real === rootReal || real.startsWith(rootReal + path.sep);
}

/**
 * 把一个用户/模型给定的路径解析为「保证落在 rootDir 内」的绝对路径。
 * @param rootDir 项目根（应为绝对路径）
 * @param target  目标路径（相对或绝对）
 * @throws PathEscapeError 当 lexical 或 realpath 校验越界。
 */
export function resolveInRoot(rootDir: string, target: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, target);

  // ① lexical：等于根或位于根之下（用 sep 防止 /root 命中 /root-evil）。
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(target);
  }

  // ② realpath：目标或其最近存在祖先的 realpath 必须仍在 root 内（防 symlink 逃逸）。
  const rootReal = realpathOrNull(root) ?? root;
  const anchorReal = realpathOrNull(nearestExisting(resolved));
  if (anchorReal !== null && !within(anchorReal, rootReal)) {
    throw new PathEscapeError(target);
  }

  return resolved;
}

/**
 * 校验 glob/grep 的 pattern / include / cwd 不经 `..` 或绝对路径逃逸 root（P7-E）。
 * fast-glob 不会净化 `..`，故在传入前做 lexical 拒绝；symlink 逃逸由 cwd 的 resolveInRoot
 * 与命中结果的 resolveInRoot 后置过滤兜底。越界抛 PathEscapeError。
 */
export function assertGlobInRoot(pattern: string): void {
  if (path.isAbsolute(pattern)) throw new PathEscapeError(pattern);
  if (pattern.split(/[\\/]/).includes('..')) throw new PathEscapeError(pattern);
}

/**
 * 取 glob 模式中「首个含 glob 元字符的段之前」的 literal 路径前缀（P7-E）。
 * 例：`link/**\/*.txt`→`link`、`src/**\/*.ts`→`src`、`**\/*.ts`→``、`a/b/c.txt`→`a/b/c.txt`。
 * 调用方对非空前缀做 resolveInRoot——literal 前缀若是指向 root 外的 symlink 会被显式拒绝。
 */
export function globLiteralPrefix(pattern: string): string {
  const lit: string[] = [];
  for (const seg of pattern.split('/')) {
    if (/[*?[\]{}()!]/.test(seg)) break;
    lit.push(seg);
  }
  return lit.join('/');
}
