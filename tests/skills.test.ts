// tests/skills.test.ts
// 覆盖 docs/product-specs/skills.md「验收」节：
//   parseFrontmatter（各情形）/ SkillRegistry（discover/覆盖/容错/load）/
//   use_skill 工具 / buildSystemPrompt（有/无技能）。
// 风格与既有测试一致：临时目录隔离、错误即数据断言、不依赖网络。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFrontmatter } from '../src/skills/parse.js';
import { SkillRegistry } from '../src/skills/index.js';
import { makeUseSkillTool } from '../src/tools/use-skill.js';
import { buildSystemPrompt, SYSTEM_PROMPT } from '../src/core/system-prompt.js';
import { MAX_TOOL_FILE_BYTES } from '../src/tools/limits.js';
import type { ToolContext } from '../src/core/types.js';

// ============================================================================
// parseFrontmatter（纯函数）
// ============================================================================

describe('parseFrontmatter', () => {
  it('正常解析围栏内 key: value + 正文', () => {
    const raw = '---\nname: foo\ndescription: 一个技能\n---\n# 标题\n正文内容';
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBe('foo');
    expect(meta.description).toBe('一个技能');
    expect(body).toBe('# 标题\n正文内容');
  });

  it('缺围栏：整文为正文，meta 空对象', () => {
    const raw = '# 没有 frontmatter\n直接正文';
    const { meta, body } = parseFrontmatter(raw);
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });

  it('有开无收（无收尾围栏）：按缺围栏处理，整文为正文', () => {
    const raw = '---\nname: foo\n没有收尾';
    const { meta, body } = parseFrontmatter(raw);
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });

  it('缺 name：meta 无 name（调用方回落目录名）', () => {
    const { meta } = parseFrontmatter('---\ndescription: 仅描述\n---\n正文');
    expect(meta.name).toBeUndefined();
    expect(meta.description).toBe('仅描述');
  });

  it('多余字段保留', () => {
    const { meta } = parseFrontmatter('---\nname: a\nauthor: x\nversion: 1\n---\n');
    expect(meta).toEqual({ name: 'a', author: 'x', version: '1' });
  });

  it('行内无 : 的行忽略；key 为空的行忽略', () => {
    const { meta } = parseFrontmatter('---\nname: a\n这是一行没有冒号\n: 空key\n---\n');
    expect(meta).toEqual({ name: 'a' });
  });

  it('同名 key 后者覆盖前者', () => {
    const { meta } = parseFrontmatter('---\nname: first\nname: second\n---\n');
    expect(meta.name).toBe('second');
  });

  it('按第一个冒号切分（value 内含冒号保留）', () => {
    const { meta } = parseFrontmatter('---\ndescription: a: b: c\n---\n');
    expect(meta.description).toBe('a: b: c');
  });

  it('容忍 CRLF 换行', () => {
    const { meta, body } = parseFrontmatter('---\r\nname: foo\r\n---\r\n正文');
    expect(meta.name).toBe('foo');
    expect(body).toBe('正文');
  });
});

// ============================================================================
// SkillRegistry —— 临时两级目录
// ============================================================================

describe('SkillRegistry', () => {
  let root: string;
  let userDir: string;
  let projectDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-test-'));
    userDir = join(root, 'user', 'skills');
    projectDir = join(root, 'project', 'skills');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 在某层目录写一个技能。 */
  function writeSkill(baseDir: string, name: string, content: string): void {
    const dir = join(baseDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
  }

  function mkRegistry(): SkillRegistry {
    return new SkillRegistry({ userDir, projectDir });
  }

  it('发现用户级 + 项目级技能', () => {
    writeSkill(userDir, 'alpha', '---\nname: alpha\ndescription: A\n---\n正文A');
    writeSkill(projectDir, 'beta', '---\nname: beta\ndescription: B\n---\n正文B');
    const reg = mkRegistry();
    const { warnings } = reg.discover();
    expect(warnings).toEqual([]);
    const names = reg.list().map((s) => s.name);
    expect(names).toEqual(['alpha', 'beta']); // 按 name 稳定排序
    expect(reg.list().find((s) => s.name === 'alpha')!.source).toBe('user');
    expect(reg.list().find((s) => s.name === 'beta')!.source).toBe('project');
  });

  it('同名技能：项目级覆盖用户级', () => {
    writeSkill(userDir, 'dup', '---\nname: dup\ndescription: 用户级\n---\n用户正文');
    writeSkill(projectDir, 'dup', '---\nname: dup\ndescription: 项目级\n---\n项目正文');
    const reg = mkRegistry();
    reg.discover();
    const metas = reg.list();
    expect(metas).toHaveLength(1);
    expect(metas[0].source).toBe('project');
    expect(metas[0].description).toBe('项目级');
    expect(reg.load('dup')).toEqual({ ok: true, content: '项目正文' });
  });

  it('name 缺失 → 回落目录名', () => {
    writeSkill(userDir, 'no-name', '---\ndescription: 无名\n---\n正文');
    const reg = mkRegistry();
    reg.discover();
    const meta = reg.list()[0];
    expect(meta.name).toBe('no-name');
    expect(meta.description).toBe('无名');
  });

  it('忽略无 SKILL.md 的目录并计 warnings', () => {
    mkdirSync(join(userDir, 'empty-dir'), { recursive: true });
    writeSkill(userDir, 'good', '---\nname: good\n---\n正文');
    const reg = mkRegistry();
    const { warnings } = reg.discover();
    expect(reg.list().map((s) => s.name)).toEqual(['good']);
    expect(warnings.some((w) => w.includes('empty-dir'))).toBe(true);
  });

  it('目录不存在不报错（无技能不是错误）', () => {
    const reg = new SkillRegistry({
      userDir: join(root, 'nope-user'),
      projectDir: join(root, 'nope-project'),
    });
    const { warnings } = reg.discover();
    expect(reg.list()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('容错坏技能：超大 SKILL.md 跳过并计 warnings', () => {
    const big = 'x'.repeat(MAX_TOOL_FILE_BYTES + 10);
    writeSkill(userDir, 'huge', `---\nname: huge\n---\n${big}`);
    writeSkill(userDir, 'ok', '---\nname: ok\n---\n正文');
    const reg = mkRegistry();
    const { warnings } = reg.discover();
    expect(reg.list().map((s) => s.name)).toEqual(['ok']);
    expect(warnings.some((w) => w.includes('huge'))).toBe(true);
  });

  it('load 正常：剥离 frontmatter 返回正文', () => {
    writeSkill(projectDir, 'c', '---\nname: c\ndescription: d\n---\n# 正文标题\n内容');
    const reg = mkRegistry();
    reg.discover();
    expect(reg.load('c')).toEqual({ ok: true, content: '# 正文标题\n内容' });
  });

  it('load 未知技能：ok:false 且带可用列表', () => {
    writeSkill(userDir, 'a', '---\nname: a\n---\n正文');
    const reg = mkRegistry();
    reg.discover();
    const res = reg.load('missing');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('未知技能');
      expect(res.error).toContain('a'); // 可用列表
    }
  });

  it('load 穿越名：拒绝且不触磁盘（../、a/b、绝对路径、..）', () => {
    const reg = mkRegistry();
    reg.discover();
    for (const bad of ['../secret', 'a/b', '/etc/passwd', '..', 'a\\b']) {
      const res = reg.load(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('技能名非法');
    }
  });

  it('load 超大正文：discover 已跳过 → load 返回未知技能', () => {
    const big = 'x'.repeat(MAX_TOOL_FILE_BYTES + 10);
    writeSkill(userDir, 'huge', `---\nname: huge\n---\n${big}`);
    const reg = mkRegistry();
    reg.discover();
    // 超大技能在 discover 阶段被跳过，故 load 视为未知技能。
    const res = reg.load('huge');
    expect(res.ok).toBe(false);
  });

  it('buildSkillCatalog：有技能多行、无技能空串', () => {
    const empty = mkRegistry();
    empty.discover();
    expect(empty.buildSkillCatalog()).toBe('');

    writeSkill(userDir, 'a', '---\nname: a\ndescription: 描述A\n---\n');
    writeSkill(userDir, 'b', '---\nname: b\n---\n'); // 无描述
    const reg = mkRegistry();
    reg.discover();
    const cat = reg.buildSkillCatalog();
    expect(cat).toContain('- a — 描述A');
    expect(cat).toContain('- b');
  });
});

// ============================================================================
// use_skill 工具
// ============================================================================

describe('use_skill 工具', () => {
  let root: string;
  let reg: SkillRegistry;

  const ctx: ToolContext = { rootDir: '/', signal: new AbortController().signal };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'use-skill-test-'));
    const userDir = join(root, 'skills');
    const dir = join(userDir, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\n---\n演示正文', 'utf8');
    reg = new SkillRegistry({ userDir, projectDir: join(root, 'none') });
    reg.discover();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('工具元信息：name=use_skill、readOnly=true', () => {
    const tool = makeUseSkillTool(reg);
    expect(tool.name).toBe('use_skill');
    expect(tool.readOnly).toBe(true);
  });

  it('存在技能 → ok:true 返回正文', async () => {
    const tool = makeUseSkillTool(reg);
    const res = await tool.execute({ name: 'demo' }, ctx);
    expect(res).toEqual({ ok: true, content: '演示正文' });
  });

  it('缺失技能 → ok:false 带可用列表', async () => {
    const tool = makeUseSkillTool(reg);
    const res = await tool.execute({ name: 'nope' }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('未知技能');
  });

  it('缺 name → 形参校验失败（不抛）', async () => {
    const tool = makeUseSkillTool(reg);
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('name 缺失');
  });

  it('name 类型错 → 形参校验失败', async () => {
    const tool = makeUseSkillTool(reg);
    const res = await tool.execute({ name: 123 }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('类型应为 string');
  });
});

// ============================================================================
// buildSystemPrompt
// ============================================================================

describe('buildSystemPrompt', () => {
  it('无技能（省略 / 空串）→ 等于 SYSTEM_PROMPT', () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({ skills: '' })).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({ skills: '   ' })).toBe(SYSTEM_PROMPT);
  });

  it('有技能 → 含「可用技能」节 + 使用指令 + 目录文本', () => {
    const out = buildSystemPrompt({ skills: '- a — 描述A\n- b — 描述B' });
    expect(out.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(out).toContain('# 可用技能');
    expect(out).toContain('use_skill');
    expect(out).toContain('- a — 描述A');
    expect(out).toContain('- b — 描述B');
  });
});
