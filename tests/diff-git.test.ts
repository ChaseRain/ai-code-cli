// tests/diff-git.test.ts
// M8：工作区状态 / diff / undo-last 支撑域。真实 git 仅在临时目录运行。

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../src/checkpoint/index.js';
import {
  findLatestAutoCheckpoint,
  formatWorkspaceStatus,
  getWorkspaceDiff,
  getWorkspaceStatus,
  previewToolChange,
} from '../src/workspace/index.js';

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtemp('ai-code-cli-diff-');
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('M8 Diff / Git-aware', () => {
  it('D1：Git repo /changes 返回 branch、changedFiles 与 untrackedFiles', async () => {
    initGit(rootDir);
    writeFileSync(join(rootDir, 'tracked.txt'), 'one\ntwo changed\n', 'utf8');
    writeFileSync(join(rootDir, 'new.txt'), 'new\n', 'utf8');

    const status = await getWorkspaceStatus(rootDir);

    expect(status.isGitRepo).toBe(true);
    expect(status.branch).toBeTruthy();
    expect(status.changedFiles).toContain('tracked.txt');
    expect(status.untrackedFiles).toContain('new.txt');
    expect(status.raw).toContain('tracked.txt');
  });

  it('D2：非 Git repo 不崩溃，并返回 checkpoint 降级摘要', async () => {
    writeFileSync(join(rootDir, 'a.txt'), 'a', 'utf8');
    const store = new CheckpointStore(rootDir);
    await store.create({ label: 'manual baseline' });

    const status = await getWorkspaceStatus(rootDir, store);

    expect(status.isGitRepo).toBe(false);
    expect(status.checkpointCount).toBe(1);
    expect(status.latestCheckpoint?.label).toBe('manual baseline');
    expect(status.raw).toContain('非 Git 仓库');
  });

  it('D3：/diff [path] 返回指定文件 unified diff 与增删统计', async () => {
    initGit(rootDir);
    writeFileSync(join(rootDir, 'tracked.txt'), 'one\ntwo changed\n', 'utf8');

    const diff = await getWorkspaceDiff(rootDir, 'tracked.txt');

    expect(diff.source).toBe('git');
    expect(diff.path).toBe('tracked.txt');
    expect(diff.content).toContain('-two');
    expect(diff.content).toContain('+two changed');
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
  });

  it('D4：path guard 拒绝越界 diff', async () => {
    await expect(getWorkspaceDiff(rootDir, '../escape.txt')).rejects.toThrow('路径越界');
  });

  it('D5：长 diff 会截断并保留完整增删统计', async () => {
    initGit(rootDir);
    writeFileSync(
      join(rootDir, 'tracked.txt'),
      Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n',
      'utf8',
    );

    const diff = await getWorkspaceDiff(rootDir, 'tracked.txt', { maxChars: 120 });

    expect(diff.truncated).toBe(true);
    expect(diff.content).toContain('diff truncated');
    expect(diff.additions).toBeGreaterThan(50);
  });

  it('D6：写前 preview 给出摘要；路径越界时返回明确失败原因', () => {
    const ok = previewToolChange(rootDir, 'write_file', {
      path: 'src/a.txt',
      content: 'hello',
    });
    expect(ok.ok).toBe(true);
    expect(ok.target).toBe('src/a.txt');
    expect(ok.summary).toContain('write_file 将写入 src/a.txt');

    const bad = previewToolChange(rootDir, 'write_file', {
      path: '../escape.txt',
      content: 'hello',
    });
    expect(bad.ok).toBe(false);
    expect(bad.summary).toContain('路径越界');
  });

  it('D7：/undo-last 使用最近自动 checkpoint', async () => {
    writeFileSync(join(rootDir, 'a.txt'), 'a', 'utf8');
    const store = new CheckpointStore(rootDir);
    await store.create({ trigger: 'manual', label: 'manual' });
    await store.create({ trigger: 'auto', label: 'before write_file' });

    const checkpoint = await findLatestAutoCheckpoint(store);

    expect(checkpoint?.trigger).toBe('auto');
    expect(checkpoint?.label).toBe('before write_file');
  });
});

describe('Phase-4 Diff/Git 质量硬化', () => {
  it('P4-A1：/diff <untracked-file> 展示 new file 预览与新增行统计', async () => {
    initGit(rootDir);
    writeFileSync(join(rootDir, 'new.txt'), 'alpha\nbeta\n', 'utf8');

    const diff = await getWorkspaceDiff(rootDir, 'new.txt');

    expect(diff.content).toContain('new file mode');
    expect(diff.content).toContain('--- /dev/null');
    expect(diff.content).toContain('+++ b/new.txt');
    expect(diff.content).toContain('+alpha');
    expect(diff.content).toContain('+beta');
    expect(diff.additions).toBe(3); // alpha、beta、末尾空行
    expect(diff.deletions).toBe(0);
  });

  it('P4-A2：/diff 总览列出未跟踪文件', async () => {
    initGit(rootDir);
    writeFileSync(join(rootDir, 'new.txt'), 'alpha\n', 'utf8');

    const diff = await getWorkspaceDiff(rootDir);

    expect(diff.content).toContain('未跟踪文件');
    expect(diff.content).toContain('?? new.txt');
  });

  it('P4-A3：未跟踪二进制文件不展开内容', async () => {
    initGit(rootDir);
    writeFileSync(join(rootDir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));

    const diff = await getWorkspaceDiff(rootDir, 'blob.bin');

    expect(diff.content).toContain('Binary files /dev/null and b/blob.bin differ');
    expect(diff.content).not.toContain('+');
    expect(diff.additions).toBe(0);
  });

  it('P4-A4：run_shell 写前 preview 使用真实 command 参数', () => {
    const preview = previewToolChange(rootDir, 'run_shell', {
      command: 'npm test',
    });

    expect(preview.ok).toBe(true);
    expect(preview.summary).toContain('npm test');
    expect(preview.summary).not.toContain('未知命令');
  });
});

// Phase-6 LH5：git timeout / maxBuffer / status 文件数上限（用 PATH 注入 fake git）。
describe('Phase-6 LH5 — git 超时/输出上限', () => {
  let bin: string;
  let savedPath: string | undefined;
  let savedTimeout: string | undefined;
  let savedMaxBuffer: string | undefined;

  beforeEach(() => {
    bin = mkdtemp('ai-code-cli-fakegit-');
    savedPath = process.env.PATH;
    savedTimeout = process.env.AICODE_GIT_TIMEOUT_MS;
    savedMaxBuffer = process.env.AICODE_GIT_MAX_BUFFER;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    restoreEnv('AICODE_GIT_TIMEOUT_MS', savedTimeout);
    restoreEnv('AICODE_GIT_MAX_BUFFER', savedMaxBuffer);
    rmSync(bin, { recursive: true, force: true });
  });

  function fakeGit(body: string): void {
    const p = join(bin, 'git');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }

  it('P6-B1：fake git diff 超时 → 可见诊断，不静默变干净', async () => {
    // 解耦 root 判定与 diff 超时：超时放宽到 4000ms（rev-parse 进程启动有充足余量，
    // 即便全量并行 CPU 争用也不会被误判超时 → isGitRepo 稳定为 true），diff 睡 10s 仍必然超时。
    fakeGit('case "$1" in\n  rev-parse) echo true ;;\n  diff) sleep 10 ;;\n  *) ;;\nesac');
    process.env.AICODE_GIT_TIMEOUT_MS = '4000';
    const diff = await getWorkspaceDiff(rootDir);
    expect(diff.content).toContain('diff 不可用');
    expect(diff.content).toContain('超时');
    expect(diff.content).not.toContain('干净');
  });

  it('P6-B3：git diff 输出超过 maxBuffer → 可见诊断', async () => {
    fakeGit('case "$1" in\n  rev-parse) echo true ;;\n  diff) printf "%0.sX" $(seq 1 1000) ;;\n  *) ;;\nesac');
    process.env.AICODE_GIT_MAX_BUFFER = '100'; // 100 bytes 上限，1000 字符输出必溢出
    const diff = await getWorkspaceDiff(rootDir);
    expect(diff.content).toContain('diff 不可用');
    expect(diff.content).toContain('超过上限');
  });

  it('R1：status 超时 → 展示诊断，不静默显示成「无变更」', async () => {
    fakeGit('case "$1" in\n  rev-parse) echo true ;;\n  status) sleep 3 ;;\n  *) ;;\nesac');
    process.env.AICODE_GIT_TIMEOUT_MS = '1000';
    const status = await getWorkspaceStatus(rootDir);
    expect(status.isGitRepo).toBe(true);
    expect(status.statusWarning).toBeTruthy();
    const text = formatWorkspaceStatus(status);
    expect(text).toMatch(/超时|不可用|失败/);
  });

  it('R5：status raw 也受控——2000 文件时格式化输出不泄漏 cap 外文件名', async () => {
    fakeGit(
      'case "$1" in\n  rev-parse) echo true ;;\n  status) echo "## main"; i=1; while [ $i -le 2000 ]; do echo " M f$i.txt"; i=$((i+1)); done ;;\n  *) ;;\nesac',
    );
    const status = await getWorkspaceStatus(rootDir);
    expect(status.changedFiles).toHaveLength(500);
    const text = formatWorkspaceStatus(status);
    expect(text).toContain('已截断');
    expect(text).not.toContain('f2000.txt'); // cap 外文件名不得泄漏
    expect(text.split('\n').length).toBeLessThan(700); // 行数受控
    expect(text.length).toBeLessThan(20_000); // 总长受控
  });

  it('P6-B2：status 文件数超上限被 cap 到 500 并标注截断', async () => {
    fakeGit(
      'case "$1" in\n  rev-parse) echo true ;;\n  status) echo "## main"; i=1; while [ $i -le 600 ]; do echo " M f$i.txt"; i=$((i+1)); done ;;\n  *) ;;\nesac',
    );
    const status = await getWorkspaceStatus(rootDir);
    expect(status.isGitRepo).toBe(true);
    expect(status.changedFiles).toHaveLength(500);
    expect(status.filesTruncated).toBe(true);
  });
});

function restoreEnv(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

function initGit(root: string): void {
  writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'init']);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function mkdtemp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
