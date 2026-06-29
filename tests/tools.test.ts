// tests/tools.test.ts
// 覆盖 docs/product-specs/tools.md 的验收点（不依赖真实网络）：
// - 路径越界拦截（../ 逃逸 / 绝对路径逃逸）
// - edit_file old_string 非唯一时报错且不写入
// - run_shell 非零退出收敛为 ok:false 且含 stderr
// - 注册表 schema 序列化、未知工具归一为 ok:false
// 另含各只读/写工具的基本正确性。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  deleteFile,
  moveFile,
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

  // Phase-6 LH2：输出内存硬上限——大输出受控且带截断提示
  it('P6-A2：stdout 远超上限时长度受控并含截断提示', async () => {
    // 打印约 100 万字符，远超 MAX_OUTPUT(30000)
    const r = await runShell.execute(
      { command: `node -e "process.stdout.write('x'.repeat(1000000))"` },
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('输出过长已截断');
      expect(r.content.length).toBeLessThan(40_000); // 受控（≈MAX_OUTPUT + 提示），非百万级
    }
  });

  it('P6-A2：失败命令的 stderr 大输出也受控截断', async () => {
    // 确定性 flush：在 write 回调里再 exit，避免 stderr 缓冲未写完就退出导致父进程只收到少量字节。
    const r = await runShell.execute(
      {
        command: `node -e "process.stderr.write('e'.repeat(1000000), () => process.exit(2))"`,
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('输出过长已截断');
      expect(r.error.length).toBeLessThan(80_000); // stdout+stderr 各自受控
    }
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------
describe('ToolRegistry', () => {
  it('createDefaultRegistry 装入 9 个内置工具 + update_plan（TP6 + Phase-10 T1）', () => {
    const reg = createDefaultRegistry();
    expect(reg.list()).toHaveLength(10);
    expect(builtinTools).toHaveLength(9); // 9 个文件/Shell 工具（含 delete_file/move_file）
    expect(reg.has('update_plan')).toBe(true);
    expect(reg.has('delete_file')).toBe(true);
    expect(reg.has('move_file')).toBe(true);
  });

  it('toSchemas 输出 ToolSchema（name/description/parameters）', () => {
    const reg = createDefaultRegistry();
    const schemas = reg.toSchemas();
    expect(schemas).toHaveLength(10);
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
      'delete_file',
      'move_file',
      'run_shell',
      'update_plan',
    ]);
  });

  it('readOnly 标记正确：只读 5 个（含 update_plan），敏感 5 个（含 delete_file/move_file）', () => {
    const reg = createDefaultRegistry();
    const ro = reg.list().filter((t) => t.readOnly).map((t) => t.name);
    const rw = reg.list().filter((t) => !t.readOnly).map((t) => t.name);
    expect(ro).toEqual(['list_dir', 'read_file', 'glob', 'grep', 'update_plan']);
    expect(rw).toEqual(['write_file', 'edit_file', 'delete_file', 'move_file', 'run_shell']);
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

// ---------------------------------------------------------------------------
// Phase-7 P7-B：工具文件大小上限
// ---------------------------------------------------------------------------
describe('P7-B 文件大小上限', () => {
  const BIG = 12 * 1024 * 1024; // 12 MiB > 5 MiB 上限

  it('read_file 超上限快速拒绝', async () => {
    await fs.writeFile(path.join(rootDir, 'big.txt'), 'x'.repeat(BIG));
    const r = await readFile.execute({ path: 'big.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/过大/);
  });

  it('edit_file 超上限拒绝', async () => {
    await fs.writeFile(path.join(rootDir, 'big.txt'), 'x'.repeat(BIG));
    const r = await editFile.execute(
      { path: 'big.txt', old_string: 'x', new_string: 'y' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/过大/);
  });

  it('write_file 超上限 content 拒绝', async () => {
    const r = await writeFile.execute({ path: 'out.txt', content: 'x'.repeat(BIG) }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/过大/);
  });
});

// ---------------------------------------------------------------------------
// Phase-7 P7-D：run_shell 超时杀进程树，不悬挂、无残留
// ---------------------------------------------------------------------------
describe('P7-D run_shell 进程树清理', () => {
  it('timeout 杀掉后台子进程树，外层不假死、无残留', async () => {
    const marker = `CCMARK${process.pid}${Date.now()}`;
    // 后台子进程持有 pipe；shell wait 阻塞 → 触发 timeout。
    const command = `node -e "/*${marker}*/ setInterval(()=>{},1000)" & wait`;

    try {
      const guard = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15000));
      const result = await Promise.race([
        runShell.execute({ command, timeoutMs: 300 }, ctx()),
        guard,
      ]);

      expect(result).not.toBe('hung'); // 不假死
      expect(typeof result === 'object' && result.ok).toBe(false);

      // 给进程组退出留一点时间，再确认无残留。
      await new Promise((r) => setTimeout(r, 500));
      let residual = '';
      try {
        residual = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim();
      } catch {
        residual = ''; // pgrep 无匹配 → 退出码 1
      }
      expect(residual).toBe('');
    } finally {
      // 兜底清理：即便断言失败也不残留进程。
      try { execFileSync('pkill', ['-9', '-f', marker]); } catch { /* 无残留 */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase-10 T1：delete_file / move_file
// ---------------------------------------------------------------------------
describe('delete_file（Phase-10 T1）', () => {
  it('删除存在的文件 → ok:true，文件消失', async () => {
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'x', 'utf8');
    const r = await deleteFile.execute({ path: 'a.txt' }, ctx());
    expect(r.ok).toBe(true);
    await expect(fs.access(path.join(rootDir, 'a.txt'))).rejects.toBeTruthy();
  });

  it('删除空目录 → ok:true', async () => {
    await fs.mkdir(path.join(rootDir, 'empty'));
    const r = await deleteFile.execute({ path: 'empty' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toMatch(/空目录/);
  });

  it('删除非空目录 → ok:false（不递归删整树），目录仍在', async () => {
    await fs.mkdir(path.join(rootDir, 'dir'));
    await fs.writeFile(path.join(rootDir, 'dir', 'inner.txt'), 'y', 'utf8');
    const r = await deleteFile.execute({ path: 'dir' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/非空目录/);
    // 副作用未发生：子文件仍在。
    await expect(fs.access(path.join(rootDir, 'dir', 'inner.txt'))).resolves.toBeUndefined();
  });

  it('删除不存在的文件 → ok:false', async () => {
    const r = await deleteFile.execute({ path: 'nope.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/不存在/);
  });

  it('用 ../ 逃逸根 → ok:false（越界拒绝）', async () => {
    const r = await deleteFile.execute({ path: '../escape.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('绝对路径逃逸根 → ok:false', async () => {
    const r = await deleteFile.execute({ path: '/etc/hosts' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });
});

describe('move_file（Phase-10 T1）', () => {
  it('重命名文件 → ok:true，源消失目标出现', async () => {
    await fs.writeFile(path.join(rootDir, 'old.txt'), 'data', 'utf8');
    const r = await moveFile.execute({ from: 'old.txt', to: 'new.txt' }, ctx());
    expect(r.ok).toBe(true);
    await expect(fs.access(path.join(rootDir, 'old.txt'))).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(rootDir, 'new.txt'), 'utf8')).toBe('data');
  });

  it('移动到不存在的子目录 → 自动建父目录', async () => {
    await fs.writeFile(path.join(rootDir, 'f.txt'), 'data', 'utf8');
    const r = await moveFile.execute({ from: 'f.txt', to: 'sub/deep/f.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(rootDir, 'sub', 'deep', 'f.txt'), 'utf8')).toBe('data');
  });

  it('目标已存在 → ok:false（不覆盖），目标内容不变', async () => {
    await fs.writeFile(path.join(rootDir, 'src.txt'), 'src', 'utf8');
    await fs.writeFile(path.join(rootDir, 'dst.txt'), 'dst', 'utf8');
    const r = await moveFile.execute({ from: 'src.txt', to: 'dst.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/已存在/);
    // 副作用未发生：目标仍是原内容，源仍在。
    expect(await fs.readFile(path.join(rootDir, 'dst.txt'), 'utf8')).toBe('dst');
    await expect(fs.access(path.join(rootDir, 'src.txt'))).resolves.toBeUndefined();
  });

  it('源不存在 → ok:false', async () => {
    const r = await moveFile.execute({ from: 'ghost.txt', to: 'x.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/源.*不存在/);
  });

  it('源越界 → ok:false', async () => {
    const r = await moveFile.execute({ from: '../x.txt', to: 'y.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
  });

  it('目标越界 → ok:false', async () => {
    await fs.writeFile(path.join(rootDir, 'in.txt'), 'd', 'utf8');
    const r = await moveFile.execute({ from: 'in.txt', to: '../out.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/越界/);
    // 源未被移动。
    await expect(fs.access(path.join(rootDir, 'in.txt'))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase-10 T2：形参校验（malformed-args）—— 缺必填 / 类型错 → ok:false 且不执行副作用
// ---------------------------------------------------------------------------
describe('形参校验（Phase-10 T2 malformed-args）', () => {
  it('read_file 缺 path → ok:false（参数无效）', async () => {
    const r = await readFile.execute({}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/path 缺失/);
  });

  it('read_file path 传 number → ok:false（类型应为 string）', async () => {
    const r = await readFile.execute({ path: 123 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/path 类型应为 string/);
  });

  it('write_file content 非字符串 → ok:false 且不写文件', async () => {
    const r = await writeFile.execute({ path: 'bad.txt', content: 42 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/content 类型应为 string/);
    await expect(fs.access(path.join(rootDir, 'bad.txt'))).rejects.toBeTruthy();
  });

  it('edit_file 缺 old_string → ok:false', async () => {
    await fs.writeFile(path.join(rootDir, 'e.txt'), 'hello', 'utf8');
    const r = await editFile.execute({ path: 'e.txt', new_string: 'x' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/old_string 缺失/);
  });

  it('delete_file path 传 number → ok:false', async () => {
    const r = await deleteFile.execute({ path: 7 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/path 类型应为 string/);
  });

  it('move_file 缺 to → ok:false 且不移动源', async () => {
    await fs.writeFile(path.join(rootDir, 's.txt'), 'd', 'utf8');
    const r = await moveFile.execute({ from: 's.txt' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/to 缺失/);
    await expect(fs.access(path.join(rootDir, 's.txt'))).resolves.toBeUndefined();
  });
});
