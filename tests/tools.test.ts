// tests/tools.test.ts
// 覆盖 docs/product-specs/tools.md 的验收点（不依赖真实网络）：
// - 路径越界拦截（../ 逃逸 / 绝对路径逃逸）
// - edit_file old_string 非唯一时报错且不写入
// - run_shell 非零退出收敛为 ok:false 且含 stderr
// - 注册表 schema 序列化、未知工具归一为 ok:false
// 另含各只读/写工具的基本正确性。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext } from '../src/core/types.js';
import {
  ToolRegistry,
  builtinTools,
  createDefaultRegistry,
  listDir,
  readFile,
  glob,
  grep,
  writeFile,
  editFile,
  runShell,
} from '../src/tools/index.js';

let rootDir: string;

function ctx(): ToolContext {
  return { rootDir, signal: new AbortController().signal };
}

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-test-'));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 路径守护
// ---------------------------------------------------------------------------
describe('路径守护', () => {
  it('read_file 用 ../ 逃逸根 → ok:false', async () => {
    const r = await readFile.execute({ path: '../../etc/passwd' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('read_file 用绝对路径逃逸根 → ok:false', async () => {
    const r = await readFile.execute({ path: '/etc/passwd' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('write_file 越界 → ok:false 且不创建文件', async () => {
    const r = await writeFile.execute({ path: '../escape.txt', content: 'x' }, ctx());
    expect(r.ok).toBe(false);
    await expect(fs.readFile(path.join(rootDir, '..', 'escape.txt'), 'utf8')).rejects.toThrow();
  });

  it('list_dir 越界 → ok:false', async () => {
    const r = await listDir.execute({ path: '..' }, ctx());
    expect(r.ok).toBe(false);
  });

  it('前缀相同但不在根内的兄弟目录不被误判为根内', async () => {
    // rootDir = /tmp/tools-test-XXX ; 尝试 ../tools-test-XXX-evil 之类
    const r = await readFile.execute({ path: `../${path.basename(rootDir)}-evil/x` }, ctx());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list_dir / read_file / glob / grep（只读）
// ---------------------------------------------------------------------------
describe('只读工具', () => {
  it('list_dir 列出子项，目录带 / 后缀', async () => {
    await fs.mkdir(path.join(rootDir, 'sub'));
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'hi');
    const r = await listDir.execute({ path: '.' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('sub/');
      expect(r.content).toContain('a.txt');
    }
  });

  it('read_file 带行号返回，offset/limit 分段', async () => {
    await fs.writeFile(path.join(rootDir, 'f.txt'), 'l1\nl2\nl3\nl4');
    const r = await readFile.execute({ path: 'f.txt', offset: 2, limit: 2 }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('2\tl2');
      expect(r.content).toContain('3\tl3');
      expect(r.content).not.toContain('1\tl1');
      expect(r.content).toMatch(/还有 1 行未显示/);
    }
  });

  it('read_file 不存在 → ok:false（错误即数据）', async () => {
    const r = await readFile.execute({ path: 'nope.txt' }, ctx());
    expect(r.ok).toBe(false);
  });

  it('glob 匹配 ts 文件', async () => {
    await fs.mkdir(path.join(rootDir, 'src'));
    await fs.writeFile(path.join(rootDir, 'src', 'a.ts'), '');
    await fs.writeFile(path.join(rootDir, 'src', 'b.js'), '');
    const r = await glob.execute({ pattern: 'src/**/*.ts' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('src/a.ts');
      expect(r.content).not.toContain('b.js');
    }
  });

  it('grep 返回 file:line:match', async () => {
    await fs.writeFile(path.join(rootDir, 'x.txt'), 'foo\nbar TODO\nbaz');
    const r = await grep.execute({ pattern: 'TODO' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('x.txt:2:bar TODO');
  });

  it('grep 非法正则 → ok:false', async () => {
    const r = await grep.execute({ pattern: '(' }, ctx());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// write_file / edit_file（写）
// ---------------------------------------------------------------------------
describe('写工具', () => {
  it('write_file 新建并自动建父目录', async () => {
    const r = await writeFile.execute({ path: 'deep/dir/f.txt', content: 'hello' }, ctx());
    expect(r.ok).toBe(true);
    const got = await fs.readFile(path.join(rootDir, 'deep/dir/f.txt'), 'utf8');
    expect(got).toBe('hello');
  });

  it('edit_file 唯一 old_string → 替换成功', async () => {
    await fs.writeFile(path.join(rootDir, 'e.txt'), 'alpha UNIQUE beta');
    const r = await editFile.execute(
      { path: 'e.txt', old_string: 'UNIQUE', new_string: 'CHANGED' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    const got = await fs.readFile(path.join(rootDir, 'e.txt'), 'utf8');
    expect(got).toBe('alpha CHANGED beta');
  });

  it('edit_file old_string 非唯一 → 报错且不写入', async () => {
    const original = 'dup\ndup\n';
    await fs.writeFile(path.join(rootDir, 'd.txt'), original);
    const r = await editFile.execute(
      { path: 'd.txt', old_string: 'dup', new_string: 'X' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/唯一/);
    // 未写入：内容不变
    const got = await fs.readFile(path.join(rootDir, 'd.txt'), 'utf8');
    expect(got).toBe(original);
  });

  it('edit_file old_string 未找到 → ok:false', async () => {
    await fs.writeFile(path.join(rootDir, 'd.txt'), 'abc');
    const r = await editFile.execute(
      { path: 'd.txt', old_string: 'zzz', new_string: 'X' },
      ctx(),
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run_shell
// ---------------------------------------------------------------------------
describe('run_shell', () => {
  it('零退出 → ok:true 含 stdout', async () => {
    const r = await runShell.execute({ command: 'echo hello-shell' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('hello-shell');
  });

  it('非零退出 → ok:false 且含 stderr', async () => {
    const r = await runShell.execute(
      { command: 'echo oops 1>&2; exit 3' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/退出码 3/);
      expect(r.error).toContain('oops');
    }
  });

  it('超时 → ok:false', async () => {
    const r = await runShell.execute({ command: 'sleep 5', timeoutMs: 100 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/超时/);
  });

  it('在 rootDir 内执行（pwd 命中根）', async () => {
    const r = await runShell.execute({ command: 'pwd' }, ctx());
    expect(r.ok).toBe(true);
    // macOS 下 /tmp 可能是 /private/tmp 的符号链接，故用 basename 校验
    if (r.ok) expect(r.content).toContain(path.basename(rootDir));
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------
describe('ToolRegistry', () => {
  it('createDefaultRegistry 装入 7 个工具', () => {
    const reg = createDefaultRegistry();
    expect(reg.list()).toHaveLength(7);
    expect(builtinTools).toHaveLength(7);
  });

  it('toSchemas 输出 ToolSchema（name/description/parameters）', () => {
    const reg = createDefaultRegistry();
    const schemas = reg.toSchemas();
    expect(schemas).toHaveLength(7);
    for (const s of schemas) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.description).toBe('string');
      expect(s.parameters.type).toBe('object');
    }
    const names = schemas.map((s) => s.name);
    expect(names).toEqual([
      'list_dir',
      'read_file',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'run_shell',
    ]);
  });

  it('readOnly 标记正确：只读 4 个，敏感 3 个', () => {
    const reg = createDefaultRegistry();
    const ro = reg.list().filter((t) => t.readOnly).map((t) => t.name);
    const rw = reg.list().filter((t) => !t.readOnly).map((t) => t.name);
    expect(ro).toEqual(['list_dir', 'read_file', 'glob', 'grep']);
    expect(rw).toEqual(['write_file', 'edit_file', 'run_shell']);
  });

  it('未知工具 execute → ok:false（不抛异常）', async () => {
    const reg = new ToolRegistry();
    const r = await reg.execute('nope', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/未知工具/);
  });

  it('重名注册 → 抛错', () => {
    const reg = new ToolRegistry([listDir]);
    expect(() => reg.register(listDir)).toThrow(/重名/);
  });

  it('工具抛异常被兜底为 ok:false', async () => {
    const reg = new ToolRegistry([
      {
        name: 'boom',
        description: 'x',
        readOnly: true,
        parameters: { type: 'object' },
        execute: async () => {
          throw new Error('kaboom');
        },
      },
    ]);
    const r = await reg.execute('boom', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('kaboom');
  });
});
