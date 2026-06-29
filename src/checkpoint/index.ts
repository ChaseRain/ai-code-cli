// src/checkpoint/index.ts
// 本地 checkpoint/restore 支撑域。只负责项目根内文件快照与恢复，不认识 TUI / Provider。

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveInRoot } from '../tools/path-guard.js';

export type CheckpointTrigger = 'manual' | 'auto';

export interface CheckpointFileEntry {
  path: string;
  sha256: string;
  size: number;
  existed: boolean;
}

export interface CheckpointManifest {
  id: string;
  label?: string;
  createdAt: string;
  trigger: CheckpointTrigger;
  root: string;
  sessionLog?: string;
  gitHead?: string;
  gitStatusSummary?: string;
  files: CheckpointFileEntry[];
  excluded: string[];
}

export interface CreateCheckpointOptions {
  label?: string;
  trigger?: CheckpointTrigger;
  sessionLog?: string;
  /** 相对项目根路径；缺省表示扫描整个项目（排除项除外）。 */
  targets?: string[];
}

export interface RestoreResult {
  id: string;
  filesRestored: number;
  filesRemoved: number;
  filesSkipped: number;
  preRestoreCheckpoint?: string;
}

const CHECKPOINT_ROOT = path.join('.ai_history', 'checkpoints');
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist']);

// Phase-6 LH4 资源预算默认值（见 docs/product-specs/load-hardening.md）。
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 单文件上限 5 MiB
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 总快照上限 64 MiB
const MAX_FILES = 2000; // 最大文件数
// Phase-6 LH1 原子目录占位的最大重试次数（高熵 id 几乎不会冲突，留小上限兜底）。
const RESERVE_RETRIES = 8;

/** 资源预算（可注入，便于测试用极小值；缺省取上面默认常量）。 */
export interface CheckpointBudget {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export class CheckpointStore {
  readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;

  constructor(rootDir: string, budget: CheckpointBudget = {}) {
    this.rootDir = path.resolve(rootDir);
    this.maxFileBytes = budget.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxTotalBytes = budget.maxTotalBytes ?? MAX_TOTAL_BYTES;
    this.maxFiles = budget.maxFiles ?? MAX_FILES;
  }

  async create(opts: CreateCheckpointOptions = {}): Promise<CheckpointManifest> {
    const createdAt = new Date().toISOString();
    const excluded = new Set<string>();
    const candidates = await this.collectCandidates(opts.targets, excluded);

    // LH1：原子占位目录确认 id 唯一（不靠随机后缀的概率保证，不静默覆盖）。
    const { id, dir } = await this.reserveDir();
    // reserveDir 成功后，后续任何异常都清理已占位目录（避免留下无 manifest 的坏目录），再重抛原异常。
    try {
      const filesDir = path.join(dir, 'files');
      await fs.mkdir(filesDir, { recursive: true });

      const files: CheckpointFileEntry[] = [];
      let totalBytes = 0;
      for (const rel of candidates) {
        const abs = resolveInRoot(this.rootDir, rel);
        const nrel = normalizeRel(rel);
        let st: import('node:fs').Stats;
        try {
          st = await fs.stat(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // 目标不存在：记录为「曾不存在」，恢复时据此删除（不占预算）。
            files.push({ path: nrel, sha256: '', size: 0, existed: false });
            continue;
          }
          throw err;
        }
        if (!st.isFile()) continue;

        // LH4：资源预算——超限不复制，写入 excluded 并标明可读原因（不假装已保护）。
        if (st.size > this.maxFileBytes) {
          excluded.add(`${nrel} (file too large: ${st.size} > ${this.maxFileBytes} bytes)`);
          continue;
        }
        if (files.filter((f) => f.existed).length >= this.maxFiles) {
          excluded.add(`${nrel} (max files exceeded: ${this.maxFiles})`);
          continue;
        }
        if (totalBytes + st.size > this.maxTotalBytes) {
          excluded.add(`${nrel} (snapshot budget exceeded: ${this.maxTotalBytes} bytes)`);
          continue;
        }

        const body = await fs.readFile(abs);
        const dest = path.join(filesDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, body);
        totalBytes += st.size;
        files.push({ path: nrel, sha256: sha256(body), size: st.size, existed: true });
      }

      const manifest: CheckpointManifest = {
        id,
        label: opts.label,
        createdAt,
        trigger: opts.trigger ?? 'manual',
        root: this.rootDir,
        sessionLog: opts.sessionLog,
        gitHead: git(this.rootDir, ['rev-parse', '--short', 'HEAD']),
        gitStatusSummary: git(this.rootDir, ['status', '--short']),
        files,
        excluded: [...excluded].sort(),
      };

      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        'utf8',
      );
      return manifest;
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * 列出 checkpoint（新→旧）。LH6：给定 `limit` 时先按目录名（id 以时间戳起头、可排序）
   * 倒序选候选，**只读候选的 manifest**，避免一次解析全部。默认无参=全部（向后兼容）。
   */
  async list(opts: { limit?: number } = {}): Promise<CheckpointManifest[]> {
    const root = this.checkpointsRoot();
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    names.sort((a, b) => b.localeCompare(a)); // 倒序≈最新在前（id 时间前缀）

    const readOne = async (name: string): Promise<CheckpointManifest | null> => {
      try {
        return await this.readManifest(name);
      } catch {
        return null; // 坏目录（无/坏 manifest）跳过，不毒化列表
      }
    };

    let manifests: CheckpointManifest[];
    if (typeof opts.limit === 'number') {
      // R3：倒序逐个读，凑满 limit 个「有效」项即停——坏目录跳过且**不挤占** limit 名额。
      manifests = [];
      for (const name of names) {
        if (manifests.length >= opts.limit) break;
        const m = await readOne(name);
        if (m) manifests.push(m);
      }
    } else {
      // 无参：并行读全部，过滤坏目录（向后兼容）。
      manifests = (await Promise.all(names.map(readOne))).filter(
        (m): m is CheckpointManifest => m !== null,
      );
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 轻量计数：只 readdir，不读 manifest（供状态展示用，LH6）。 */
  async count(): Promise<number> {
    try {
      return (await fs.readdir(this.checkpointsRoot())).length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  async readManifest(id: string): Promise<CheckpointManifest> {
    assertSafeId(id);
    const raw = await fs.readFile(path.join(this.checkpointDir(id), 'manifest.json'), 'utf8');
    return JSON.parse(raw) as CheckpointManifest;
  }

  async restore(id: string): Promise<RestoreResult> {
    const manifest = await this.readManifest(id);
    const targets = manifest.files.map((f) => f.path);
    const pre = await this.create({
      label: `pre-restore ${id}`,
      trigger: 'auto',
      sessionLog: manifest.sessionLog,
      targets,
    });

    let filesRestored = 0;
    let filesRemoved = 0;
    let filesSkipped = 0;
    const filesDir = path.join(this.checkpointDir(id), 'files');

    for (const file of manifest.files) {
      const rel = normalizeRel(file.path);
      const dest = resolveInRoot(this.rootDir, rel);
      if (!file.existed) {
        try {
          await fs.rm(dest, { recursive: true, force: true });
          filesRemoved++;
        } catch {
          filesSkipped++;
        }
        continue;
      }

      const src = path.join(filesDir, rel);
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        filesRestored++;
      } catch {
        filesSkipped++;
      }
    }

    return {
      id,
      filesRestored,
      filesRemoved,
      filesSkipped,
      preRestoreCheckpoint: pre.id,
    };
  }

  /**
   * LH1：原子分配一个唯一的 checkpoint 目录。
   * 先确保根目录存在，再用 `mkdir(recursive:false)` 占位——同名已存在会抛 EEXIST，
   * 据此重试新 id。高熵 id + 原子占位双重保证：并发不碰撞、不静默覆盖、不返回同一 id。
   */
  private async reserveDir(): Promise<{ id: string; dir: string }> {
    await fs.mkdir(this.checkpointsRoot(), { recursive: true });
    for (let i = 0; i < RESERVE_RETRIES; i++) {
      const id = checkpointId();
      const dir = this.checkpointDir(id);
      try {
        await fs.mkdir(dir, { recursive: false });
        return { id, dir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
    }
    throw new Error(`无法为 checkpoint 分配唯一目录（连续 ${RESERVE_RETRIES} 次冲突）`);
  }

  private checkpointsRoot(): string {
    return path.join(this.rootDir, CHECKPOINT_ROOT);
  }

  private checkpointDir(id: string): string {
    assertSafeId(id);
    return path.join(this.checkpointsRoot(), id);
  }

  private async collectCandidates(
    targets: string[] | undefined,
    excluded: Set<string>,
  ): Promise<string[]> {
    const out = new Set<string>();
    if (targets?.length) {
      for (const target of targets) {
        const abs = resolveInRoot(this.rootDir, target);
        const rel = normalizeRel(path.relative(this.rootDir, abs) || '.');
        if (shouldExclude(rel)) {
          excluded.add(rel);
          continue;
        }
        await this.collectOne(rel, out, excluded);
      }
      return [...out].sort();
    }
    await this.walk('.', out, excluded);
    return [...out].sort();
  }

  private async collectOne(rel: string, out: Set<string>, excluded: Set<string>): Promise<void> {
    const abs = resolveInRoot(this.rootDir, rel);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        await this.walk(rel, out, excluded);
      } else if (st.isFile()) {
        out.add(normalizeRel(rel));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        out.add(normalizeRel(rel));
        return;
      }
      throw err;
    }
  }

  private async walk(relDir: string, out: Set<string>, excluded: Set<string>): Promise<void> {
    const absDir = resolveInRoot(this.rootDir, relDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      const rel = normalizeRel(path.join(relDir, ent.name));
      if (shouldExclude(rel)) {
        excluded.add(rel);
        continue;
      }
      if (ent.isDirectory()) {
        await this.walk(rel, out, excluded);
      } else if (ent.isFile()) {
        out.add(rel);
      }
    }
  }
}

export function checkpointTargetsForTool(name: string, args: unknown): string[] | undefined {
  const p = (args ?? {}) as Record<string, unknown>;
  if ((name === 'write_file' || name === 'edit_file') && typeof p.path === 'string') {
    return [p.path];
  }
  return undefined;
}

function shouldExclude(rel: string): boolean {
  const n = normalizeRel(rel);
  if (n === '.' || n === '') return false;
  const parts = n.split('/');
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return true;
  if (n === CHECKPOINT_ROOT || n.startsWith(CHECKPOINT_ROOT + '/')) return true;
  const base = parts.at(-1) ?? '';
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;
  return false;
}

function normalizeRel(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

function checkpointId(): string {
  // 时间戳前缀保留可读/可排序；唯一性由高熵 randomUUID + reserveDir 原子占位保证（LH1）。
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${randomUUID()}`;
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`非法 checkpoint id：${id}`);
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}
