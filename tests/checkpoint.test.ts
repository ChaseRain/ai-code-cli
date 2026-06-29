// tests/checkpoint.test.ts
// M6 Checkpoint / Restore：覆盖 create/list/restore、排除项、路径越界、pre-restore checkpoint。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CheckpointStore } from '../src/checkpoint/index.js';

let rootDir: string;
let store: CheckpointStore;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-test-'));
  store = new CheckpointStore(rootDir);
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(rootDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(rootDir, rel), 'utf8');
}

describe('CheckpointStore', () => {
  it('create/list：创建 checkpoint 并按时间倒序列出', async () => {
    await write('a.txt', 'alpha');

    const cp = await store.create({ label: 'first', trigger: 'manual' });
    expect(cp.label).toBe('first');
    expect(cp.files.some((f) => f.path === 'a.txt' && f.existed)).toBe(true);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(cp.id);
  });

  it('排除项：不快照 .git/node_modules/dist/.env/.ai_history/checkpoints', async () => {
    await write('src/a.ts', 'ok');
    await write('.env', 'SECRET=1');
    await write('dist/b.js', 'build');
    await write('node_modules/pkg/index.js', 'dep');
    await write('.git/config', 'git');
    await write('.ai_history/checkpoints/old/manifest.json', '{}');

    const cp = await store.create();
    const paths = cp.files.map((f) => f.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('.env');
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.ai_history/checkpoints/'))).toBe(false);
  });

  it('restore：恢复已存在文件，并生成 pre-restore checkpoint', async () => {
    await write('a.txt', 'before');
    const cp = await store.create({ targets: ['a.txt'] });
    await write('a.txt', 'after');

    const r = await store.restore(cp.id);
    expect(r.filesRestored).toBe(1);
    expect(r.preRestoreCheckpoint).toBeTruthy();
    expect(await read('a.txt')).toBe('before');

    const list = await store.list();
    expect(list.some((x) => x.id === r.preRestoreCheckpoint)).toBe(true);
  });

  it('restore：checkpoint 时不存在的文件会被删除，manifest 外新文件保留', async () => {
    const cp = await store.create({ targets: ['new.txt'] });
    await write('new.txt', 'created later');
    await write('other.txt', 'keep me');

    const r = await store.restore(cp.id);
    expect(r.filesRemoved).toBe(1);
    await expect(fs.readFile(path.join(rootDir, 'new.txt'), 'utf8')).rejects.toThrow();
    expect(await read('other.txt')).toBe('keep me');
  });

  it('路径越界：target 或 restore manifest 越界会被拒绝', async () => {
    await expect(store.create({ targets: ['../escape.txt'] })).rejects.toThrow(/越界/);
    await expect(store.restore('../bad')).rejects.toThrow(/非法 checkpoint id/);
  });

  // Phase-6 LH1：并发唯一性（即便固定时间，id 也不碰撞、目录不被覆盖）
  it('P6-A1：100 并发 create 全部唯一（id/目录/manifest 齐全）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z')); // 固定时间，制造同前缀
    try {
      await write('a.txt', 'x');
      const results = await Promise.all(
        Array.from({ length: 100 }, () => store.create({ targets: ['a.txt'] })),
      );
      expect(results).toHaveLength(100);
      const ids = new Set(results.map((m) => m.id));
      expect(ids.size).toBe(100); // 100 个唯一 id

      // 100 个目录 + manifest 都存在
      const root = path.join(rootDir, '.ai_history', 'checkpoints');
      const dirs = await fs.readdir(root);
      expect(dirs).toHaveLength(100);
      for (const m of results) {
        const mf = path.join(root, m.id, 'manifest.json');
        expect((await fs.stat(mf)).isFile()).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // Phase-6 LH4：资源预算——大文件超单文件上限不复制，excluded 带原因
  it('P6-A4：超单文件上限的大文件不快照，manifest excluded 标明原因', async () => {
    await write('small.txt', 'ok');
    // 6 MiB > 5 MiB 上限
    await write('big.bin', 'B'.repeat(6 * 1024 * 1024));

    const cp = await store.create();
    expect(cp.files.some((f) => f.path === 'small.txt' && f.existed)).toBe(true);
    expect(cp.files.some((f) => f.path === 'big.bin')).toBe(false); // 未快照
    expect(cp.excluded.some((e) => e.startsWith('big.bin') && /file too large/.test(e))).toBe(true);
  });

  // P6-A4：用注入的极小预算低成本覆盖 maxFiles / maxTotalBytes 超限跳过
  it('P6-A4：超 maxFiles 的文件被跳过并写入 excluded（原因：max files exceeded）', async () => {
    for (const n of ['a', 'b', 'c', 'd']) await write(`${n}.txt`, n);
    const limited = new CheckpointStore(rootDir, { maxFiles: 2 });
    const cp = await limited.create();
    expect(cp.files.filter((f) => f.existed)).toHaveLength(2);
    expect(cp.excluded.filter((e) => /max files exceeded/.test(e)).length).toBeGreaterThanOrEqual(1);
  });

  it('P6-A4：超 maxTotalBytes 的文件被跳过并写入 excluded（原因：snapshot budget exceeded）', async () => {
    await write('f1.txt', 'X'.repeat(800));
    await write('f2.txt', 'Y'.repeat(800));
    const limited = new CheckpointStore(rootDir, { maxTotalBytes: 1000 }); // 仅够一个 800B 文件
    const cp = await limited.create();
    expect(cp.files.filter((f) => f.existed)).toHaveLength(1);
    expect(cp.excluded.some((e) => /snapshot budget exceeded/.test(e))).toBe(true);
  });

  // reserveDir 风险取舍：无 manifest 的坏目录不毒化 list（list 跳过、不抛）
  it('坏 checkpoint 目录（无 manifest）不影响 list', async () => {
    await write('a.txt', 'x');
    const good = await store.create({ targets: ['a.txt'] });
    // 手工制造一个无 manifest 的坏目录
    await fs.mkdir(path.join(rootDir, '.ai_history', 'checkpoints', 'broken-dir'), { recursive: true });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(good.id);
  });

  // Phase-6 LH6 / R3：坏目录排在倒序最前也不得挤占有效结果
  it('P6-B4/R3：5 个坏目录排在最前 + 60 合法，list({limit:50}) 仍返回 50', async () => {
    const cpRoot = path.join(rootDir, '.ai_history', 'checkpoints');
    // 60 个合法 checkpoint
    for (let i = 0; i < 60; i++) {
      const id = `2026-06-28T00-00-00-000Z-${String(i).padStart(3, '0')}`;
      const dir = path.join(cpRoot, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ id, createdAt: id, trigger: 'manual', root: rootDir, files: [], excluded: [] }),
      );
    }
    // 5 个坏目录（无 manifest），命名 zzzz-* 使其在倒序中排在最前——必须被跳过且不挤占 limit
    for (let i = 0; i < 5; i++) {
      await fs.mkdir(path.join(cpRoot, `zzzz-bad-${i}`), { recursive: true });
    }

    const limited = await store.list({ limit: 50 });
    expect(limited).toHaveLength(50); // 坏目录在前也不少返回
    expect(limited.every((m) => m.id.startsWith('2026-'))).toBe(true);
    expect(limited[0].id.endsWith('-059')).toBe(true); // 最新有效项在前

    const all = await store.list();
    expect(all).toHaveLength(60); // 无参返回全部有效项，坏目录跳过、不抛

    expect(await store.count()).toBe(65); // count 含坏目录（轻量 readdir）
  });
});
