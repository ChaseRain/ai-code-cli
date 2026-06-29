// src/workspace/index.ts
// 工作区观测域：集中处理 Git 状态、diff、写前变更摘要与 undo-last 的 checkpoint 查询。
// TUI / Agent Loop 只消费结构化结果，不直接执行 git。

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { CheckpointManifest, CheckpointStore } from '../checkpoint/index.js';
import { resolveInRoot } from '../tools/path-guard.js';

export interface WorkspaceStatus {
  isGitRepo: boolean;
  branch?: string;
  changedFiles: string[];
  untrackedFiles: string[];
  /** LH5：变更/未跟踪文件数超过上限时被截断展示。 */
  filesTruncated: boolean;
  /** LH5：git status 超时/溢出/错误时的可见诊断（成功时 undefined）。 */
  statusWarning?: string;
  raw: string;
  checkpointCount: number;
  latestCheckpoint?: {
    id: string;
    trigger: CheckpointManifest['trigger'];
    createdAt: string;
    label?: string;
  };
}

export interface DiffResult {
  path?: string;
  source: 'git' | 'fallback';
  content: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface ToolChangePreview {
  ok: boolean;
  tool: string;
  target?: string;
  summary: string;
}

export interface DiffOptions {
  maxChars?: number;
}

export const DEFAULT_DIFF_MAX_CHARS = 12_000;
// Phase-6 LH5：git 调用上限（见 load-hardening.md）。
// 默认 10s / 16MiB；可经环境变量覆盖（运维逃生阀 + 测试旋钮，每次调用读取，无需重载模块）。
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_STATUS_FILES = 500;

function gitLimits(): { timeout: number; maxBuffer: number } {
  const timeout = Number(process.env.AICODE_GIT_TIMEOUT_MS) || DEFAULT_GIT_TIMEOUT_MS;
  const maxBuffer = Number(process.env.AICODE_GIT_MAX_BUFFER) || DEFAULT_GIT_MAX_BUFFER;
  return { timeout, maxBuffer };
}

type CheckpointListStore = Pick<CheckpointStore, 'list'> & {
  count?: () => Promise<number>;
};

/** git 调用结果（区分成功 / 超时 / 输出溢出 / 其它错误，避免「失败=干净」的静默歧义）。 */
type GitRun =
  | { ok: true; stdout: string }
  | { ok: false; kind: 'timeout' | 'overflow' | 'error'; message: string };

export async function getWorkspaceStatus(
  rootDir: string,
  checkpointStore?: CheckpointListStore,
): Promise<WorkspaceStatus> {
  // LH6：只取最近 1 个 manifest + 轻量计数，不全量解析所有 checkpoint。
  const recent = checkpointStore ? await checkpointStore.list({ limit: 1 }) : [];
  const checkpointCount = checkpointStore
    ? checkpointStore.count
      ? await checkpointStore.count()
      : recent.length
    : 0;
  const latest = recent[0]
    ? {
        id: recent[0].id,
        trigger: recent[0].trigger,
        createdAt: recent[0].createdAt,
        label: recent[0].label,
      }
    : undefined;

  if (!isGitRepo(rootDir)) {
    return {
      isGitRepo: false,
      changedFiles: [],
      untrackedFiles: [],
      filesTruncated: false,
      raw: '非 Git 仓库；已降级为 checkpoint 摘要。',
      checkpointCount,
      latestCheckpoint: latest,
    };
  }

  // LH5/R1：用 runGit 读 status——失败不静默成「无变更」，而是返回可见诊断。
  const statusRun = runGit(rootDir, ['status', '--short', '--branch']);
  if (!statusRun.ok) {
    const label =
      statusRun.kind === 'timeout' ? '超时' : statusRun.kind === 'overflow' ? '输出过大' : '失败';
    return {
      isGitRepo: true,
      changedFiles: [],
      untrackedFiles: [],
      filesTruncated: false,
      statusWarning: `git status ${label}：${statusRun.message}（无法读取工作区变更，请重试）`,
      raw: '',
      checkpointCount,
      latestCheckpoint: latest,
    };
  }
  const raw = statusRun.stdout;
  const lines = raw.split('\n').filter(Boolean);
  const branch = parseBranch(lines.find((line) => line.startsWith('## ')));
  const changedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) continue;
    const file = line.slice(3).trim();
    if (!file) continue;
    if (line.startsWith('?? ')) untrackedFiles.push(file);
    else changedFiles.push(file);
  }

  // LH5：文件数上限——不把几万文件全 join 进 TUI。
  const filesTruncated =
    changedFiles.length > MAX_STATUS_FILES || untrackedFiles.length > MAX_STATUS_FILES;

  return {
    isGitRepo: true,
    branch,
    changedFiles: changedFiles.slice(0, MAX_STATUS_FILES),
    untrackedFiles: untrackedFiles.slice(0, MAX_STATUS_FILES),
    filesTruncated,
    raw,
    checkpointCount,
    latestCheckpoint: latest,
  };
}

export async function getWorkspaceDiff(
  rootDir: string,
  targetPath?: string,
  opts: DiffOptions = {},
): Promise<DiffResult> {
  const rel = normalizeTarget(rootDir, targetPath);
  const maxChars = opts.maxChars ?? DEFAULT_DIFF_MAX_CHARS;

  if (!isGitRepo(rootDir)) {
    const content = fallbackDiffSummary(rootDir, rel);
    const truncated = truncateContent(content, maxChars);
    return {
      path: rel,
      source: 'fallback',
      content: truncated.content,
      additions: 0,
      deletions: 0,
      truncated: truncated.truncated,
    };
  }

  const args = rel ? ['diff', '--', rel] : ['diff'];
  const run = runGit(rootDir, args);
  if (!run.ok) {
    // LH5：不静默变「干净」——超时/输出溢出返回用户可见诊断。
    return {
      path: rel,
      source: 'git',
      content: `（diff 不可用：${run.message}）`,
      additions: 0,
      deletions: 0,
      truncated: false,
    };
  }
  let full = run.stdout;
  if (rel && !full && isUntracked(rootDir, rel)) {
    full = untrackedFileDiff(rootDir, rel, maxChars);
  } else if (!rel) {
    const untracked = listUntracked(rootDir);
    if (untracked.length) {
      full = appendUntrackedSummary(full, untracked);
    }
  }
  const counted = countChanges(full);
  const alreadyTruncated = full.includes('... diff truncated ...');
  const truncated = truncateContent(full || '无 diff；工作区是干净的。', maxChars);
  return {
    path: rel,
    source: 'git',
    content: truncated.content,
    additions: counted.additions,
    deletions: counted.deletions,
    truncated: truncated.truncated || alreadyTruncated,
  };
}

export async function findLatestAutoCheckpoint(
  checkpointStore: CheckpointListStore,
): Promise<CheckpointManifest | null> {
  // LH6：只在最近一批里找自动 checkpoint，不全量解析所有 manifest。
  const checkpoints = await checkpointStore.list({ limit: 50 });
  return checkpoints.find((checkpoint) => checkpoint.trigger === 'auto') ?? null;
}

export function previewToolChange(rootDir: string, tool: string, args: unknown): ToolChangePreview {
  const obj = isRecord(args) ? args : {};
  const target = typeof obj.path === 'string' ? safeRelative(rootDir, obj.path) : undefined;
  if (target && !target.ok) {
    return {
      ok: false,
      tool,
      summary: `无法生成变更预览：${target.error}`,
    };
  }

  const rel = target?.path;
  if (tool === 'write_file') {
    const bytes = typeof obj.content === 'string' ? Buffer.byteLength(obj.content, 'utf8') : 0;
    return {
      ok: true,
      tool,
      target: rel,
      summary: `写前预览：write_file 将写入 ${rel ?? '(未知路径)'}（${bytes} bytes）。`,
    };
  }

  if (tool === 'edit_file') {
    const oldChars = typeof obj.old_string === 'string' ? obj.old_string.length : 0;
    const newChars = typeof obj.new_string === 'string' ? obj.new_string.length : 0;
    return {
      ok: true,
      tool,
      target: rel,
      summary: `写前预览：edit_file 将编辑 ${rel ?? '(未知路径)'}（old ${oldChars} chars → new ${newChars} chars）。`,
    };
  }

  if (tool === 'run_shell') {
    const command = typeof obj.command === 'string' ? obj.command : '(未知命令)';
    return {
      ok: true,
      tool,
      summary: `写前预览：run_shell 将执行命令：${command}`,
    };
  }

  if (rel) {
    return {
      ok: true,
      tool,
      target: rel,
      summary: `写前预览：${tool} 将影响 ${rel}。`,
    };
  }

  return {
    ok: false,
    tool,
    summary: `无法生成具体变更预览：${tool} 没有可识别的 path 参数。`,
  };
}

export function formatWorkspaceStatus(status: WorkspaceStatus): string {
  const lines = [
    status.isGitRepo
      ? `工作区：Git 仓库${status.branch ? `（branch: ${status.branch}）` : ''}`
      : '工作区：非 Git 仓库（checkpoint 降级）',
    ...(status.statusWarning ? [`⚠ ${status.statusWarning}`] : []),
    `变更文件：${status.changedFiles.length ? status.changedFiles.join(', ') : '无'}`,
    `未跟踪文件：${status.untrackedFiles.length ? status.untrackedFiles.join(', ') : '无'}`,
    ...(status.filesTruncated ? [`（文件过多，列表已截断，仅展示前 ${MAX_STATUS_FILES} 项）`] : []),
    `checkpoint：${status.checkpointCount}`,
  ];
  if (status.latestCheckpoint) {
    lines.push(
      `最近 checkpoint：${status.latestCheckpoint.id} · ${status.latestCheckpoint.trigger} · ${status.latestCheckpoint.createdAt}`,
    );
  }
  if (status.raw.trim()) {
    // LH5/R5：raw status 预览也受控——只展示前 MAX_STATUS_FILES 行，绝不泄漏 cap 外文件名。
    const rawLines = status.raw.trim().split('\n');
    lines.push('', ...rawLines.slice(0, MAX_STATUS_FILES));
    if (rawLines.length > MAX_STATUS_FILES) {
      lines.push(`...（status 原文过长，已截断，仅展示前 ${MAX_STATUS_FILES} 行）`);
    }
  }
  return lines.join('\n');
}

export function formatDiffResult(diff: DiffResult): string {
  return [
    `Diff${diff.path ? ` ${diff.path}` : ''} · source=${diff.source} · +${diff.additions}/-${diff.deletions}${diff.truncated ? ' · 已截断' : ''}`,
    diff.content,
  ].join('\n');
}

function isGitRepo(rootDir: string): boolean {
  return (git(rootDir, ['rev-parse', '--is-inside-work-tree']) ?? '').trim() === 'true';
}

/** 执行 git，带 timeout + maxBuffer（LH5）；区分超时/溢出/其它错误。 */
function runGit(rootDir: string, args: string[]): GitRun {
  const { timeout, maxBuffer } = gitLimits();
  try {
    const stdout = execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer,
    });
    return { ok: true, stdout };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { signal?: string; killed?: boolean };
    if (err.code === 'ENOBUFS' || /maxBuffer/i.test(String(err.message))) {
      return { ok: false, kind: 'overflow', message: `git ${args[0]} 输出超过上限（${maxBuffer} bytes）` };
    }
    if (err.killed || err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
      return { ok: false, kind: 'timeout', message: `git ${args[0]} 超时（${timeout}ms）` };
    }
    return { ok: false, kind: 'error', message: err.message ?? 'git 调用失败' };
  }
}

/** 简单包装：成功返回 stdout，失败返回 null（用于不需要区分失败原因的内部查询）。 */
function git(rootDir: string, args: string[]): string | null {
  const r = runGit(rootDir, args);
  return r.ok ? r.stdout : null;
}

function listUntracked(rootDir: string): string[] {
  return (git(rootDir, ['ls-files', '--others', '--exclude-standard']) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function isUntracked(rootDir: string, rel: string): boolean {
  return listUntracked(rootDir).includes(rel);
}

function appendUntrackedSummary(diff: string, untracked: string[]): string {
  const summary = ['未跟踪文件（未展开，使用 /diff <path> 查看单文件预览）：', ...untracked.map((f) => `?? ${f}`)].join('\n');
  return diff.trim() ? `${diff.trimEnd()}\n\n${summary}\n` : `${summary}\n`;
}

function untrackedFileDiff(rootDir: string, rel: string, maxChars: number): string {
  const abs = resolveInRoot(rootDir, rel);
  const st = statSync(abs);
  if (st.isDirectory()) return `未跟踪路径 ${rel} 是目录；请指定具体文件。`;
  const body = readFileSync(abs);
  if (body.includes(0)) {
    return [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', `Binary files /dev/null and b/${rel} differ`].join('\n');
  }
  const text = body.toString('utf8');
  const additions = text.length ? text.split('\n').map((line) => `+${line}`).join('\n') : '+';
  const diff = [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`, '@@', additions].join('\n');
  return truncateContent(diff, maxChars).content;
}

function parseBranch(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const body = line.slice(3).trim();
  const noCommits = body.match(/^No commits yet on (.+)$/);
  if (noCommits) return noCommits[1];
  return body.split('...')[0]?.split(/\s+/)[0] || undefined;
}

function normalizeTarget(rootDir: string, targetPath?: string): string | undefined {
  if (!targetPath?.trim()) return undefined;
  const abs = resolveInRoot(rootDir, targetPath);
  return normalizeRel(path.relative(path.resolve(rootDir), abs) || '.');
}

function safeRelative(
  rootDir: string,
  targetPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: normalizeTarget(rootDir, targetPath) ?? '.' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function fallbackDiffSummary(rootDir: string, rel: string | undefined): string {
  if (!rel) {
    return '非 Git 仓库，无法生成 unified diff；可先创建 checkpoint，再用 /changes 查看本地快照摘要。';
  }
  try {
    const st = statSync(resolveInRoot(rootDir, rel));
    if (st.isDirectory()) return `非 Git 仓库：${rel} 是目录，无法生成 unified diff。`;
    return `非 Git 仓库：${rel} 当前大小 ${st.size} bytes，mtime ${st.mtime.toISOString()}。`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `非 Git 仓库：${rel} 不存在。`;
    throw err;
  }
}

function countChanges(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  return {
    content: `${content.slice(0, maxChars)}\n... diff truncated ...`,
    truncated: true,
  };
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
