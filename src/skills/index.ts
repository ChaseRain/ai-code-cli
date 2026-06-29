// src/skills/index.ts
// Skills 限界上下文（支撑域）：把本地 SKILL.md 沉淀的「工作流 / 领域知识」以三级渐进式
//   披露供给模型（L1 目录注入 system prompt / L2 use_skill 加载正文 / L3 资源由模型自行读取）。
// 依赖边界（ARCHITECTURE）：agent/loop 不认识 skills；技能仅经 system prompt(L1) 与
//   use_skill 工具(L2) 进入上下文。本模块只做发现 / 读取，不做 system prompt 拼接（那在
//   core/system-prompt.ts）、不做工具注册（那在 tools/use-skill.ts）。
// 错误即数据：发现阶段坏 / 超大技能跳过并计 warnings，不崩溃；load 失败返回 ok:false。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '../core/types.js';
import { MAX_TOOL_FILE_BYTES, humanBytes } from '../tools/limits.js';
import { parseFrontmatter } from './parse.js';

/** 一个技能的目录元信息（L1：只含名字 + 描述 + 来源 + 路径，不含正文）。 */
export interface SkillMeta {
  /** frontmatter.name ?? 目录名。 */
  name: string;
  /** frontmatter.description ?? ''。 */
  description: string;
  /** 来源层：项目级覆盖用户级。 */
  source: 'user' | 'project';
  /** 该技能 SKILL.md 的绝对路径。 */
  path: string;
}

/** discover() 的返回：本次发现累积的告警（坏 / 超大 / 无 SKILL.md 等）。 */
export interface DiscoverResult {
  warnings: string[];
}

/** 技能目录内约定的清单文件名。 */
const SKILL_FILE = 'SKILL.md';

/**
 * 技能注册表。构造注入两级目录（由 cli 计算，复用 config 路径约定），构造里不做 IO。
 * - discover()：扫描两级目录，只读 frontmatter（L1）；项目级同名覆盖用户级；容错。
 * - list()：已发现技能（按 name 稳定排序）。
 * - load(name)：读取正文（剥 frontmatter），校验技能名 + 大小；错误即数据。
 * - buildSkillCatalog()：格式化 L1 目录文本；无技能返回空串。
 */
export class SkillRegistry {
  private readonly userDir: string;
  private readonly projectDir: string;
  /** 已发现技能：name → SkillMeta（项目级覆盖用户级后的最终视图）。 */
  private skills = new Map<string, SkillMeta>();

  constructor(opts: { userDir: string; projectDir: string }) {
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  /**
   * 扫描两级目录、只读每个 SKILL.md 的 frontmatter（不读正文，省 IO/内存）。
   * 先扫用户级、再扫项目级（项目级同名覆盖）；解析失败 / 缺 SKILL.md / 超大文件 → 跳过
   * 并把原因追加进 warnings，不影响其他技能。可重复调用（每次重建内部视图）。
   */
  discover(): DiscoverResult {
    const warnings: string[] = [];
    this.skills = new Map();
    // 顺序：用户级在前、项目级在后 → 后写入者覆盖（项目级优先）。
    this.scanDir(this.userDir, 'user', warnings);
    this.scanDir(this.projectDir, 'project', warnings);
    return { warnings };
  }

  /** 已发现技能目录，按 name 稳定排序（L1 目录与 /skills 输出确定）。 */
  list(): SkillMeta[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 读取某技能正文（剥离 frontmatter）。错误即数据：
   * - 技能名非单段（含 `/`、`\`、`..`、绝对路径前缀）→ ok:false，不触磁盘（防穿越）。
   * - 未知技能 → ok:false，附「可用技能列表」提示。
   * - 正文超 MAX_TOOL_FILE_BYTES → ok:false（与 read_file 一致）。
   * - 读取失败 → ok:false（含原因）。
   */
  load(name: string): ToolResult {
    // ① 技能名单段校验（防穿越）：拒绝任何路径分隔 / `..` / 绝对路径。
    if (!isSingleSegment(name)) {
      return { ok: false, error: `技能名非法：${name}（只允许单段技能名，不能含路径）` };
    }
    // ② 必须命中已发现集合，避免用技能名拼出任意路径。
    const meta = this.skills.get(name);
    if (!meta) {
      const avail = this.list().map((s) => s.name);
      const hint = avail.length ? avail.join(', ') : '（无）';
      return { ok: false, error: `未知技能：${name}。可用：${hint}` };
    }
    // ③ 大小上限（防超大文件整块读入内存，与 read_file 一致）。
    let size: number;
    try {
      size = statSync(meta.path).size;
    } catch (e) {
      return { ok: false, error: `读取技能失败：${name}（${(e as Error).message}）` };
    }
    if (size > MAX_TOOL_FILE_BYTES) {
      return {
        ok: false,
        error: `技能过大：${name}（${humanBytes(size)} 超过上限 ${humanBytes(MAX_TOOL_FILE_BYTES)}）`,
      };
    }
    // ④ 读取并剥离 frontmatter，返回正文。
    let raw: string;
    try {
      raw = readFileSync(meta.path, 'utf8');
    } catch (e) {
      return { ok: false, error: `读取技能失败：${name}（${(e as Error).message}）` };
    }
    const { body } = parseFrontmatter(raw);
    return { ok: true, content: body.trim().length ? body : raw };
  }

  /**
   * 格式化 L1 目录文本（每技能一行 `- <name> — <description>`）。
   * 无技能 → 返回空串（调用方据此省略 system prompt 的「可用技能」节）。
   */
  buildSkillCatalog(metas?: SkillMeta[]): string {
    const list = metas ?? this.list();
    if (list.length === 0) return '';
    return list
      .map((s) => (s.description ? `- ${s.name} — ${s.description}` : `- ${s.name}`))
      .join('\n');
  }

  // ── 内部：扫描单层目录 ────────────────────────────────────────────────────
  /**
   * 扫描一层 skills 目录。每个子目录视作一个技能：读取其 SKILL.md frontmatter。
   * 目录不存在 → 静默跳过（不是错误）。子项异常逐个容错并计 warnings，不中断整体。
   */
  private scanDir(dir: string, source: 'user' | 'project', warnings: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // 目录不存在 / 不可读 → 跳过（无技能不是错误）。
    }
    for (const entry of entries) {
      const skillDir = path.join(dir, entry);
      // 只认目录；非目录子项忽略。
      let isDir = false;
      try {
        isDir = statSync(skillDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const file = path.join(skillDir, SKILL_FILE);
      let size: number;
      try {
        const st = statSync(file);
        if (!st.isFile()) {
          // 子目录内无 SKILL.md → 忽略该目录（不是技能）。
          warnings.push(`忽略 ${source} 技能目录「${entry}」：缺少 ${SKILL_FILE}`);
          continue;
        }
        size = st.size;
      } catch {
        warnings.push(`忽略 ${source} 技能目录「${entry}」：缺少 ${SKILL_FILE}`);
        continue;
      }
      // 超大技能：发现阶段即跳过并计 warnings（load 也会再次拦）。
      if (size > MAX_TOOL_FILE_BYTES) {
        warnings.push(
          `跳过 ${source} 技能「${entry}」：${SKILL_FILE} 过大（${humanBytes(size)}）`,
        );
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (e) {
        warnings.push(`跳过 ${source} 技能「${entry}」：读取失败（${(e as Error).message}）`);
        continue;
      }
      const { meta } = parseFrontmatter(raw);
      const name = (meta.name ?? '').trim() || entry; // name 缺失回落目录名。
      // 回落出的名字仍须单段（防目录名含异常字符；正常目录名天然单段）。
      if (!isSingleSegment(name)) {
        warnings.push(`跳过 ${source} 技能「${entry}」：技能名非法（${name}）`);
        continue;
      }
      this.skills.set(name, {
        name,
        description: (meta.description ?? '').trim(),
        source,
        path: file,
      });
    }
  }
}

/** 技能名是否为「单段标识」：非空、不含路径分隔 / `..` / 绝对路径前缀。 */
function isSingleSegment(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  if (path.isAbsolute(name)) return false;
  return true;
}
