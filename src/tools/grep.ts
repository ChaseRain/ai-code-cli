// src/tools/grep.ts
// grep：内容正则搜索（只读）。返回 file:line:match。限项目根内。
// 纯 JS 实现（不依赖外部 ripgrep），用 fast-glob 列文件再逐行匹配。

import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import {
  resolveInRoot,
  assertGlobInRoot,
  globLiteralPrefix,
  PathEscapeError,
} from './path-guard.js';
import { MAX_TOOL_FILE_BYTES } from './limits.js';

/**
 * 轻量 ReDoS 检测（P8-B）。保守启发式，**非 RE2 / 非完整 regex sandbox**，常见安全正则不误伤。
 * 命中两类：
 *  (a) nested quantifier：组内含量词 `*`/`+`/`{...}`，组整体又被 `*`/`+`/`{` 量化
 *      —— `(a+)+`、`(.+)*`、`(.*)+`、`(\d+){2,}`、`(a{1,})+`。
 *  (b) 歧义 alternation：被外层量词量化的分组里，某分支是另一分支的前缀 —— `(a|aa)+`、`(a|ab)*`；
 *      覆盖 捕获/非捕获 `(?:...)`/命名 `(?<n>...)`/一层包装 `(?:(?:...))`/可选分支 `(a?|aa)+`/
 *      字符类首 token 重叠 `([a]|a)+`/`([ab]|a)+`/`([a]|aa)+`/`([ab]|ab)+`/`([a]|a?)+`
 *      （单个非否定字符类，另一分支仅此单字面 / 第二字面也在集合内 / 是单可选字面 a0?）。
 * 放行（不误伤）：`(abc)+`、`(a|b)+`、`(?:a|b)+`、`(?<x>a|b)+`、`(?:(?:a|b))+$`、
 *   `(a?)+$`、`(a?|b)+$`、`(ab?|cd)+$`、`([b]|aa)+$`、`([a?]|b)+$`、`([ab]|cd)+$`、
 *   `([a]|ab)+$`/`([ab]|ac)+$`（第二字面不在集合内）、`([a]|a\d)+$`（a\d 至少消费两字符）、
 *   `([d]|\d\d)+$`（语义类 escape 非字面）、`([a]b|aa)+$`（类分支非单原子）、
 *   `TODO|FIXME`、`export\s+const`、`hello.*world`、`^foo$`。
 */
export function isPotentiallyCatastrophicRegex(pattern: string): boolean {
  // (a) 内层量词类纳入 `{`（覆盖 {m,n}/{m,}），外层量词 `*`/`+`/`{`。
  if (/\([^()]*[*+{][^()]*\)[*+{]/.test(pattern)) return true;
  // (b) 被外层量词量化的分组里存在歧义 alternation（某分支是另一分支前缀）。
  //     用轻量 scanner 处理 捕获/非捕获(?:)/命名(?<n>)/一层包装；非完整 parser。
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== ')' || !'*+{'.includes(pattern[i + 1] ?? '')) continue;
    const open = matchingOpen(pattern, i);
    if (open < 0) continue;
    if (hasAmbiguousAlternation(pattern.slice(open + 1, i))) return true;
  }
  return false;
}

/** 从某个 `)` 回溯找到与之匹配的 `(` 下标；找不到返回 -1（忽略转义，轻量足够）。 */
function matchingOpen(s: string, closeIdx: number): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 去掉分组前缀：`?:`（非捕获）、`?<name>` / `?'name'`（命名捕获）。 */
function stripGroupPrefix(body: string): string {
  return body.replace(/^\?:/, '').replace(/^\?<[^>]*>/, '').replace(/^\?'[^']*'/, '');
}

/** 判断一个被外层量词量化的分组 body 是否含歧义 alternation。 */
function hasAmbiguousAlternation(rawBody: string): boolean {
  let body = stripGroupPrefix(rawBody);
  // 一层包装：body 整体就是单个分组 `(...)` 时解包一次再规范化（覆盖 `(?:(?:a|aa))` 等）。
  if (body.startsWith('(') && body.endsWith(')') && matchingOpen(body, body.length - 1) === 0) {
    body = stripGroupPrefix(body.slice(1, -1));
  }
  // 注意：不要 trim 分支——正则里空白是字面字符，trim 会吞掉 `(\s|  )` 的空白分支（P8-C）。
  // 仅过滤真正的空分支（如 `(a|)` 的空串），避免 ''.startsWith 造成误判。
  const rawAlts = splitTopLevel(body, '|').filter((s) => s.length > 0);
  if (rawAlts.length < 2) return false;
  // P8-C (e)：每个分支若整体是单层分组 `(a)`/`(?:a)`/`(?<n>a)`，解包一层再参与比较。
  const alts = rawAlts.map(unwrapOneGroup);
  // 同时比较 raw 分支与「去掉可选量词 ? 后的 normalized 分支」——覆盖 (a?|aa)+ 这类可选分支前缀重叠。
  const norm = alts.map(stripOptionalQuantifiers);
  for (let i = 0; i < alts.length; i++) {
    for (let j = 0; j < alts.length; j++) {
      if (i === j) continue;
      if (alts[i] && alts[j].startsWith(alts[i])) return true;
      if (norm[i] && norm[j].startsWith(norm[i])) return true;
      // 字符类首 token 重叠（P8-B）：alts[i] 整体是单个非否定字符类，取 alts[j] 首个字面 a0。
      // 仅三种情况判重叠（避免 ([a]|ab) 这类 false positive）：
      //  (a) a0 在 set 且 alts[j] 仅此单字面（等长等价，如 ([a]|a)/([ab]|a)）；
      //  (b) a0 在 set 且第二个字面 a1 也在 set（重复切分，如 ([a]|aa)/([ab]|ab)/([a-c]|aa)）；
      //  (c) a0 在 set 且 alts[j] 是单可选字面 a0?（a0 后紧跟未转义 ? 且到此结束，如 ([a]|a?)）。
      // a0 不在 set → 放行；a1 存在但不在 set（如 ([a]|ab)）→ 放行；
      // a1 为语义 escape（literalAt=null）且其后仍有内容（如 ([a]|a\d)）→ 保守放行。
      const set = classCharSet(alts[i]);
      if (set) {
        const a0 = literalAt(alts[j], 0);
        if (a0 && set.has(a0.ch)) {
          if (a0.next >= alts[j].length) return true; // (a) 单字面等长
          if (alts[j][a0.next] === '?' && a0.next === alts[j].length - 1) return true; // (c) 单可选字面 a?
          const a1 = literalAt(alts[j], a0.next);
          if (a1 && set.has(a1.ch)) return true; // (b) 第二字面也在集合内
        }
      }
      // P8-C (d)：语义原子首 token 重叠——alts[i] 是 \d/\w/\s/./简单 [^X]，
      // 且 alts[j] 前两个 token 都被其覆盖（token 可为字面或被覆盖的语义 escape）。
      // 只覆盖明显子集（见 semanticAtom/coversEscapeClass），宁漏不误伤。
      const atom = semanticAtom(alts[i]);
      if (atom) {
        const t0 = tokenAt(alts[j], 0);
        if (t0 && atom.covers(t0)) {
          const t1 = tokenAt(alts[j], t0.next);
          if (t1 && atom.covers(t1)) return true;
        }
      }
    }
  }
  return false;
}

/** P8-C (e)：若 branch 整体是单层分组 (…)/(?:…)/(?<n>…)，解包一层并去分组前缀；否则原样返回。 */
function unwrapOneGroup(branch: string): string {
  if (
    branch.startsWith('(') &&
    branch.endsWith(')') &&
    matchingOpen(branch, branch.length - 1) === 0
  ) {
    return stripGroupPrefix(branch.slice(1, -1));
  }
  return branch;
}

/** 单个正则 token：字面字符 `lit`，或语义类 escape `esc`（`d`/`w`/`s`，通配 `.` 记为 esc='.'）。 */
interface RToken {
  lit?: string;
  esc?: string;
  next: number;
}

/** 读取 s[i] 处单个 token；分组/字符类/锚点/量词等非单 token 起始返回 null。 */
function tokenAt(s: string, i: number): RToken | null {
  if (i >= s.length) return null;
  const c = s[i];
  if (c === '\\') {
    const n = s[i + 1];
    if (!n) return null;
    if (/[dswDSW]/.test(n)) return { esc: n, next: i + 2 }; // 语义类 escape
    const ws: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };
    if (ws[n] !== undefined) return { lit: ws[n], next: i + 2 }; // 空白字面 escape
    if (/[bB0-9xu]/.test(n)) return null; // 锚点/反向引用/hex——不处理
    return { lit: n, next: i + 2 }; // escaped literal，如 \? \.
  }
  if ('()[]'.includes(c)) return null; // 分组/字符类边界
  if ('^$|*+?{}'.includes(c)) return null; // 锚点/量词
  if (c === '.') return { esc: '.', next: i + 1 }; // 通配
  return { lit: c, next: i + 1 };
}

interface SemAtom {
  covers(t: RToken): boolean;
}

/** P8-C (d)：若 branch 整体是语义原子（\d/\w/\s/./简单 [^X]），返回覆盖判定；否则 null。 */
function semanticAtom(branch: string): SemAtom | null {
  if (branch === '.') return { covers: () => true }; // . 覆盖任意 token
  const m = /^\\([dws])$/.exec(branch);
  if (m) {
    const kind = m[1];
    return { covers: (t) => coversEscapeClass(kind, t) };
  }
  const neg = /^\[\^([^\]]+)\]$/.exec(branch);
  if (neg) {
    const x = classCharSetFromContent(neg[1]);
    // [^X] 只覆盖「不在 X 的字面字符」；语义 escape 保守不覆盖。
    return { covers: (t) => t.lit !== undefined && !x.has(t.lit) };
  }
  return null;
}

/** \d/\w/\s 的覆盖判定（只取明显子集：见 P8-C 规格）。 */
function coversEscapeClass(kind: string, t: RToken): boolean {
  if (kind === 'd') return (t.lit !== undefined && /[0-9]/.test(t.lit)) || t.esc === 'd';
  if (kind === 'w')
    return (t.lit !== undefined && /[A-Za-z0-9_]/.test(t.lit)) || t.esc === 'd' || t.esc === 'w';
  if (kind === 's') return (t.lit !== undefined && /\s/.test(t.lit)) || t.esc === 's';
  return false;
}

/** 若 branch 整体是单个**非否定**简单字符类（`[a]`/`[a?]`/`[ab]`/简单 `a-c` range），返回其字符集合；否则 null。 */
function classCharSet(branch: string): Set<string> | null {
  const m = /^\[(?!\^)([^\]]+)\]$/.exec(branch);
  if (!m) return null;
  return classCharSetFromContent(m[1]);
}

/** 把字符类内容（`[` `]` 之间，不含开头 `^`）展开为字面字符集合；简单 range 展开（hi-lo<128）。 */
function classCharSetFromContent(content: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\') {
      if (content[i + 1]) set.add(content[i + 1]);
      i++;
      continue;
    }
    if (content[i + 1] === '-' && i + 2 < content.length) {
      const lo = content.charCodeAt(i);
      const hi = content.charCodeAt(i + 2);
      if (hi >= lo && hi - lo < 128) {
        for (let c = lo; c <= hi; c++) set.add(String.fromCharCode(c));
        i += 2;
        continue;
      }
    }
    set.add(content[i]);
  }
  return set;
}

/**
 * 取 s[i] 处的「字面字符」及其后继下标；非字面（组/类/锚点/量词/语义 escape）返回 null。
 * 语义 escape（`\d \D \s \S \w \W \b \B \n \r \t \f \v`、`\xNN`/`\uNNNN`、反向引用 `\1`）不算字面字符。
 */
function literalAt(s: string, i: number): { ch: string; next: number } | null {
  if (i >= s.length) return null;
  const c = s[i];
  if (c === '\\') {
    const n = s[i + 1];
    if (!n || /[dDsSwWbBnrtfvxu0-9]/.test(n)) return null; // 语义/特殊 escape，非字面
    return { ch: n, next: i + 2 }; // escaped literal，如 \? \. \+
  }
  if ('([{^$.|*+?'.includes(c)) return null; // 组/锚点/量词等非字面起始
  return { ch: c, next: i + 1 };
}

/** 去掉分支里未转义、非字符类内的 `?`（可选量词）。仅做轻量规范化，非完整 parser。 */
function stripOptionalQuantifiers(branch: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < branch.length; i++) {
    const c = branch[i];
    if (c === '\\') {
      out += c + (branch[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      out += c;
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += c;
      continue;
    }
    if (c === '?') continue;
    out += c;
  }
  return out;
}

/** 按分隔符在「顶层」（不在 () 或 [] 内、非转义）切分。 */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      cur += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      cur += c;
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

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

    // P8-B：扫描前拒绝明显危险的 ReDoS/退化正则（嵌套量词 / 歧义 alternation），避免病态回溯卡死事件循环。
    if (isPotentiallyCatastrophicRegex(pattern)) {
      return {
        ok: false,
        error: `正则过于复杂（可能导致灾难性回溯/退化）：${pattern}；请简化后重试`,
      };
    }

    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (err) {
      return { ok: false, error: `非法正则：${(err as Error).message}` };
    }

    try {
      const root = path.resolve(ctx.rootDir);
      // P7-E：include 不得经 .. / 绝对路径逃逸（fast-glob 不净化 ..）；
      // literal 前缀若是指向 root 外的 symlink 也显式拒绝。
      assertGlobInRoot(include);
      const incPrefix = globLiteralPrefix(include);
      if (incPrefix) resolveInRoot(root, incPrefix);
      const files = await fg(include, {
        cwd: root,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
      });

      const out: string[] = [];
      let truncated = false;
      let skipped = 0; // P8-A：因过大而跳过的文件数
      for (const rel of files.sort()) {
        if (ctx.signal.aborted) return { ok: false, error: 'grep 被中断' };
        // 后置防御：越界文件（symlink 等）不读。
        try {
          resolveInRoot(root, rel);
        } catch {
          continue;
        }
        const abs = path.join(root, rel);
        // P8-A：stat-before-read，超上限的文件不读（与 read/edit/write 一致的守护栏）。
        try {
          if ((await fs.stat(abs)).size > MAX_TOOL_FILE_BYTES) {
            skipped++;
            continue;
          }
        } catch {
          continue;
        }
        let content: string;
        try {
          content = await fs.readFile(abs, 'utf8');
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

      const skipNotice =
        skipped > 0
          ? `\n…(已跳过 ${skipped} 个过大文件，单文件上限 ${MAX_TOOL_FILE_BYTES} bytes)`
          : '';
      if (out.length === 0) return { ok: true, content: '(无匹配)' + skipNotice };
      const truncNotice = truncated ? `\n…(匹配过多，已截断至前 ${MAX_MATCHES})` : '';
      return { ok: true, content: out.join('\n') + truncNotice + skipNotice };
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, error: err.message };
      return { ok: false, error: `grep 失败：${(err as Error).message}` };
    }
  },
};
