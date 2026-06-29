// tests/guardrails.test.ts
// Phase-7 P7-A：符号链接逃逸防护。root/link -> 外部目录/文件，工具/checkpoint/workspace
// 经 symlink 读/写/编辑/列目录/快照必须被拒，且 root 外文件不被读写。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFile, writeFile, editFile, listDir, glob, grep } from '../src/tools/index.js';
import { isPotentiallyCatastrophicRegex } from '../src/tools/grep.js';
import { CheckpointStore } from '../src/checkpoint/index.js';
import { getWorkspaceDiff } from '../src/workspace/index.js';
import type { ToolContext } from '../src/core/types.js';

let base: string;
let root: string;
let outside: string;

function ctx(): ToolContext {
  return { rootDir: root, signal: new AbortController().signal };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-guard-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
  // root/link -> outside（目录符号链接）；root/flink -> outside/secret.txt（文件符号链接）
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'flink'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('P7-A 符号链接逃逸防护', () => {
  it('read_file 经 symlink 读 root 外文件被拒', async () => {
    const r = await readFile.execute({ path: 'link/secret.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('read_file 经文件 symlink 读外部被拒', async () => {
    const r = await readFile.execute({ path: 'flink' }, ctx());
    expect(r.ok).toBe(false);
  });

  it('write_file 经 symlink 写出 root 外被拒，且外部文件未被创建', async () => {
    const r = await writeFile.execute({ path: 'link/pwn.txt', content: 'x' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
    expect(fs.existsSync(path.join(outside, 'pwn.txt'))).toBe(false);
  });

  it('edit_file 经 symlink 编辑外部文件被拒，且外部内容不变', async () => {
    const r = await editFile.execute(
      { path: 'flink', old_string: 'TOP SECRET', new_string: 'HACKED' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
  });

  it('list_dir 经 symlink 列 root 外目录被拒', async () => {
    const r = await listDir.execute({ path: 'link' }, ctx());
    expect(r.ok).toBe(false);
  });

  it('checkpoint targets 经 symlink 越界被拒', async () => {
    const store = new CheckpointStore(root);
    await expect(store.create({ targets: ['link/secret.txt'] })).rejects.toThrow(/越界/);
  });

  it('workspace diff 经 symlink 越界被拒', async () => {
    await expect(getWorkspaceDiff(root, 'link/secret.txt')).rejects.toThrow(/越界/);
  });

  it('正常 root 内文件不受影响', async () => {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'hello', 'utf8');
    const r = await readFile.execute({ path: 'ok.txt' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('hello');
  });
});

describe('P7-E glob/grep pattern/cwd 逃逸防护', () => {
  it('glob cwd=.. 被拒（越界）', async () => {
    const r = await glob.execute({ cwd: '..', pattern: '**/*.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('glob pattern=../outside 被拒（越界）', async () => {
    const r = await glob.execute({ pattern: '../outside/**/*.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('glob 绝对路径 pattern 被拒（越界）', async () => {
    const r = await glob.execute({ pattern: `${outside}/**/*.txt` }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('glob cwd 经 root 内 symlink 指向 outside 被拒（越界）', async () => {
    const r = await glob.execute({ cwd: 'link', pattern: '**/*.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('glob pattern literal 前缀是 symlink（link/**）显式越界', async () => {
    const r = await glob.execute({ pattern: 'link/**/*.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('grep include=../outside 被拒（越界），不读 root 外内容', async () => {
    const r = await grep.execute(
      { pattern: 'SECRET', include: '../outside/**/*.txt' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('grep include 绝对路径被拒（越界）', async () => {
    const r = await grep.execute(
      { pattern: 'SECRET', include: `${outside}/**/*.txt` },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('grep include literal 前缀是 symlink（link/**）显式越界', async () => {
    const r = await grep.execute({ pattern: 'SECRET', include: 'link/**/*.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('glob/grep literal 前缀为普通子目录（src/**）正常', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'export const a=1;', 'utf8');
    const g = await glob.execute({ pattern: 'src/**/*.ts' }, ctx());
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.content).toContain('src/x.ts');
    const gr = await grep.execute({ pattern: 'export const', include: 'src/**/*.ts' }, ctx());
    expect(gr.ok).toBe(true);
    if (gr.ok) expect(gr.content).toContain('src/x.ts:1:export const a=1;');
  });

  it('正常 root 内 glob/grep 回归', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello-world', 'utf8');
    const g = await glob.execute({ pattern: '**/*.txt' }, ctx());
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.content).toContain('a.txt');
    const gr = await grep.execute({ pattern: 'hello-world' }, ctx());
    expect(gr.ok).toBe(true);
    if (gr.ok) expect(gr.content).toContain('a.txt:1:hello-world');
  });
});

describe('P8 grep 资源与正则安全', () => {
  it('P8-A1：12MiB 文件不命中 → ok:true 含 (无匹配) 与 已跳过提示', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(12 * 1024 * 1024), 'utf8');
    const r = await grep.execute({ pattern: 'ZZZ_NO_MATCH' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('(无匹配)');
      expect(r.content).toContain('已跳过 1 个过大文件');
    }
  });

  it('P8-A2：大文件含 SECRET 也不泄漏内容，只提示跳过', async () => {
    fs.writeFileSync(
      path.join(root, 'big.txt'),
      'SECRET_MARKER_UNIQUE\n' + 'a'.repeat(12 * 1024 * 1024),
      'utf8',
    );
    const r = await grep.execute({ pattern: 'SECRET' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).not.toContain('SECRET_MARKER_UNIQUE');
      expect(r.content).toContain('已跳过 1 个过大文件');
    }
  });

  it('P8-B1：nested quantifier (a+)+$ 被拒（不卡死）', async () => {
    // evil 小文件存在也不会卡死：检测在扫描前完成。
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '(a+)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1b：{} 量词 nested (a{1,})+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '(a{1,})+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1c：歧义 alternation (a|aa)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '(a|aa)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1d：非捕获分组歧义 alternation (?:a|aa)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '(?:a|aa)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1e：命名捕获 (?<x>a|aa)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '(?<x>a|aa)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1f：一层非捕获包装 (?:(?:a|aa))+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '(?:(?:a|aa))+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B2b：安全命名/包装 alternation 放行并能命中', async () => {
    fs.writeFileSync(path.join(root, 'names.txt'), 'alice\nbob\n', 'utf8');
    const r = await grep.execute({ pattern: '(?<x>a|b)+' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('names.txt');
  });

  it('P8-B1g：可选分支歧义 (a?|aa)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '(a?|aa)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B2c：安全可选分支 (ab?|cd)+$ 放行并能命中（快速）', async () => {
    fs.writeFileSync(path.join(root, 'ab.txt'), 'abxcd\n', 'utf8');
    const r = await grep.execute({ pattern: '(ab?|cd)+' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('ab.txt');
  });

  it('P8-B1h：字符类首 token 重叠 ([a]|aa)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '([a]|aa)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B2d：安全字符类 ([b]|aa)+$ 放行并能命中（快速）', async () => {
    fs.writeFileSync(path.join(root, 'baa.txt'), 'baa\n', 'utf8');
    const r = await grep.execute({ pattern: '([b]|aa)+' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('baa.txt');
  });

  it('P8-B1i：等长等价字符类分支 ([a]|a)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '([a]|a)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1j：多字符类等价分支 ([ab]|a)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '([ab]|a)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1k：第二字面仍在集合内 ([ab]|ab)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '([ab]|ab)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1l：range 类首 token 重叠 ([a-c]|aa)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '([a-c]|aa)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B1m：单可选字面 ([a]|a?)+$ 被拒（不卡死）', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(34) + '!', 'utf8');
    const r = await grep.execute({ pattern: '([a]|a?)+$' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
  });

  it('P8-B2j：语义 escape 第二 token ([a]|a\\d)+$ 不误伤（放行、命中）', async () => {
    fs.writeFileSync(path.join(root, 'ad.txt'), 'a1\n', 'utf8');
    const r = await grep.execute({ pattern: '([a]|a\\d)+$' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('ad.txt');
  });

  it('P8-B2f：语义类 ([d]|\\d\\d)+$ 不误伤（放行、小输入快速）', async () => {
    fs.writeFileSync(path.join(root, 'nums.txt'), 'd12\n', 'utf8');
    const r = await grep.execute({ pattern: '([d]|\\d\\d)+' }, ctx());
    expect(r.ok).toBe(true);
  });

  it('P8-B2g：第二字面不在集合内 ([a]|ab)+$ 不误伤（放行、命中）', async () => {
    fs.writeFileSync(path.join(root, 'ab.txt'), 'ab\n', 'utf8');
    const r = await grep.execute({ pattern: '([a]|ab)+$' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('ab.txt');
  });

  it('P8-B2h：第二字面不在集合内 ([ab]|ac)+$ 不误伤（放行、命中）', async () => {
    fs.writeFileSync(path.join(root, 'ac.txt'), 'ac\n', 'utf8');
    const r = await grep.execute({ pattern: '([ab]|ac)+$' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('ac.txt');
  });

  it('P8-B2i：类分支非单原子 ([a]b|aa)+$ 不误伤（放行、命中）', async () => {
    fs.writeFileSync(path.join(root, 'abx.txt'), 'ab\n', 'utf8');
    const r = await grep.execute({ pattern: '([a]b|aa)+$' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('abx.txt');
  });

  // ---- P8-C：语义原子首 token 重叠 + 一层分支 unwrap（spec+测试先行，实现待下一轮，当前 RED）----
  // danger grep 用例刻意用**小输入**（匹配即返回），避免未实现时退化输入卡死整轮；
  // 期望 ok:false 由「下一轮 helper 拒绝」满足；当前实现放行 → 这些断言现在为 RED。
  const P8C_DANGER: Array<[string, string, string]> = [
    ['P8-C1a 语义原子 \\w + 双字面', '(\\w|ab)+$', 'ab'],
    ['P8-C1b 语义原子 \\w + 字面+\\d', '(\\w|a\\d)+$', 'a1'],
    ['P8-C1c 语义原子 \\d + 双数字', '(\\d|11)+$', '11'],
    ['P8-C1d 语义原子 \\s + 双空白', '(\\s|  )+$', '  '],
    ['P8-C1e 否定类 [^b] + aa', '([^b]|aa)+$', 'aa'],
    ['P8-C1f 通配 . + aa', '(.|aa)+$', 'aa'],
    ['P8-C1g 分支 unwrap ((a)|aa)', '((a)|aa)+$', 'aa'],
    ['P8-C1h 分支 unwrap ((?:a)|aa)', '((?:a)|aa)+$', 'aa'],
    ['P8-C1i 外层非捕获 + 分支 unwrap (?:(a)|aa)', '(?:(a)|aa)+$', 'aa'],
    ['P8-C1j 右分支 unwrap (a|(?:aa))', '(a|(?:aa))+$', 'aa'],
  ];
  for (const [name, pattern, sample] of P8C_DANGER) {
    it(`${name} → ok:false（不卡死）`, async () => {
      fs.writeFileSync(path.join(root, 'evil.txt'), sample + '\n', 'utf8');
      const r = await grep.execute({ pattern }, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/正则.*复杂|退化/);
    });
  }

  const P8C_SAFE: Array<[string, string, string]> = [
    ['P8-C2a \\d 首 token 不覆盖 (\\d|ab)', '(\\d|ab)+$', 'ab'],
    ['P8-C2b \\w 首 token 不覆盖 (\\w|!!)', '(\\w|!!)+$', '!!'],
    ['P8-C2c [^a] 首 token 被排除 ([^a]|aa) —— 命中 aa 分支', '([^a]|aa)+$', 'aa'],
    ['P8-C2d [^a] 命中否定类分支 ([^a]|aa)', '([^a]|aa)+$', 'bb'],
  ];
  for (const [name, pattern, sample] of P8C_SAFE) {
    it(`${name} → 不误伤（放行、命中）`, async () => {
      fs.writeFileSync(path.join(root, 'safe.txt'), sample + '\n', 'utf8');
      const r = await grep.execute({ pattern }, ctx());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.content).toContain('safe.txt');
    });
  }

  it('P8-B2：正常正则通过并命中', async () => {
    fs.writeFileSync(path.join(root, 'code.ts'), 'export const a = 1; // TODO refine', 'utf8');
    const r1 = await grep.execute({ pattern: 'TODO|FIXME' }, ctx());
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.content).toContain('code.ts');
    const r2 = await grep.execute({ pattern: 'export\\s+const' }, ctx());
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.content).toContain('code.ts');
  });

  it('isPotentiallyCatastrophicRegex：命中危险、放行常见', () => {
    for (const p of [
      '(a+)+$', '(.+)*', '(.*)+', '(\\d+){2,}', '(a{1,})+$',
      '(a|aa)+$', '(?:a|aa)+$', '(?<x>a|aa)+$', '(?:(?:a|aa))+$',
      '(a?|aa)+$', '(?:a?|aa)+$', '(?<x>a?|aa)+$', '(?:(?:a?|aa))+$',
      '([a]|aa)+$', '(?:[a]|aa)+$', '(?<x>[a]|aa)+$', '(?:(?:[a]|aa))+$',
      '([a?]|aa)+$', '([ab]|aa)+$', '([a-c]|aa)+$', '([d]|dd)+$',
      '([a]|a)+$', '([ab]|a)+$', '([ab]|ab)+$', '([a]|a?)+$',
      // P8-C danger（语义原子 + 一层分支 unwrap）——实现待下一轮，当前 RED：
      '(\\w|ab)+$', '(\\w|a\\d)+$', '(\\d|11)+$', '(\\s|  )+$', '([^b]|aa)+$', '(.|aa)+$',
      '((a)|aa)+$', '((?:a)|aa)+$', '(?:(a)|aa)+$', '(a|(?:aa))+$',
    ]) {
      expect(isPotentiallyCatastrophicRegex(p)).toBe(true);
    }
    for (const p of [
      'TODO|FIXME', 'export\\s+const', 'hello.*world', '^foo$',
      '(abc)+', '(a|b)+', '(?:a|b)+', '(?<x>a|b)+', '(?:(?:a|b))+$',
      '(a?)+$', '(a?|b)+$', '(ab?|cd)+$',
      '([b]|aa)+$', '([a?]|b)+$', '([a]|b)+$', '([ab]|cd)+$', '(a\\?|aa)+$',
      '([d]|\\d\\d)+$', '([a]b|aa)+$',
      '([a]|ab)+$', '([ab]|ac)+$', '([?]|\\d\\d)+$', '([a]|a\\d)+$',
      // P8-C safe（语义原子首 token 不覆盖 / 否定类排除）——现在与实现后都应放行：
      '(\\d|ab)+$', '(\\w|!!)+$', '([^a]|aa)+$',
    ]) {
      expect(isPotentiallyCatastrophicRegex(p)).toBe(false);
    }
  });
});
