// tests/config.test.ts
// 覆盖 docs/product-specs/config.md 的「验收（测试）」点。不依赖真实网络/真实家目录。
// 用临时目录隔离用户级与项目级配置，并劫持 os.homedir 指向临时家目录。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, redactSecret } from '../src/config/index.js';

let tmpRoot: string;
let fakeHome: string;
let projectCwd: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

/** 写用户级配置：<fakeHome>/.config/ai-code-cli/config.json */
function writeUserConfig(obj: unknown): void {
  const dir = join(fakeHome, '.config', 'ai-code-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(obj), 'utf8');
}

/** 写项目级配置：<projectCwd>/.ai-code-cli/config.json（content 可为非法字符串以测错误） */
function writeProjectConfig(content: unknown): void {
  const dir = join(projectCwd, '.ai-code-cli');
  mkdirSync(dir, { recursive: true });
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(dir, 'config.json'), body, 'utf8');
}

/** 统一 loadConfig 调用：固定 cwd、关闭 .env 加载以隔离环境。 */
function load() {
  return loadConfig({ cwd: projectCwd, loadEnv: false });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aicc-config-'));
  fakeHome = join(tmpRoot, 'home');
  projectCwd = join(tmpRoot, 'project');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(projectCwd, { recursive: true });

  // 劫持 os.homedir() 指向临时家目录：它在 *nix 读 $HOME，在 Windows 读 %USERPROFILE%。
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  // 清理可能影响密钥解析的环境变量。
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CODEPLAN_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadConfig — 默认值回落', () => {
  it('缺失任何配置文件时返回全部默认值', () => {
    const { config } = load();
    expect(config).toEqual({
      provider: 'anthropic',
      model: 'deepseek/deepseek-v4-pro',
      baseURL: 'https://ai-kas.kso.net/codeplan/anthropic',
      timeoutMs: 60000,
      maxTurns: 25,
      maxRetries: 2,
      // Phase-9 M3：记忆配置默认值。
      memory: {
        enabled: true,
        thresholdMsgs: 40,
        keepRecent: 16,
        thresholdTokens: 24000,
        keepRecentTokens: 8000,
        summarizer: 'heuristic',
      },
    });
  });
});

describe('loadConfig — 深合并优先级（默认 ← 用户 ← 项目）', () => {
  it('用户级覆盖默认值，未写字段保留默认', () => {
    writeUserConfig({ model: 'user-model', maxTurns: 10 });
    const { config } = load();
    expect(config.model).toBe('user-model');
    expect(config.maxTurns).toBe(10);
    // 未覆盖字段保留默认
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxRetries).toBe(2);
  });

  it('项目级覆盖用户级；用户级独有字段保留；默认值保留', () => {
    writeUserConfig({ model: 'user-model', timeoutMs: 30000, maxTurns: 10 });
    writeProjectConfig({ model: 'project-model', maxTurns: 40 });
    const { config } = load();

    // 项目级覆盖
    expect(config.model).toBe('project-model');
    expect(config.maxTurns).toBe(40);
    // 用户级独有、项目级未写 → 保留用户级
    expect(config.timeoutMs).toBe(30000);
    // 两层都没写 → 默认值
    expect(config.maxRetries).toBe(2);
    expect(config.baseURL).toBe('https://ai-kas.kso.net/codeplan/anthropic');
  });
});

describe('loadConfig — 校验失败给出清晰错误且不崩溃', () => {
  it('字段类型错误时抛出带字段名的错误', () => {
    writeProjectConfig({ timeoutMs: 'not-a-number' });
    expect(() => load()).toThrowError(/timeoutMs/);
  });

  it('未知字段被拒绝（strict）', () => {
    writeProjectConfig({ unknownField: 123 });
    expect(() => load()).toThrowError(/校验失败|unknownField|Unrecognized/i);
  });

  it('JSON 语法错误时抛出带路径的解析错误', () => {
    writeProjectConfig('{ this is not json');
    expect(() => load()).toThrowError(/JSON 解析失败/);
  });

  it('provider 非 anthropic 被拒绝', () => {
    writeUserConfig({ provider: 'openai' });
    expect(() => load()).toThrowError(/provider/);
  });

  it('baseURL 非 URL 被拒绝', () => {
    writeProjectConfig({ baseURL: 'not a url' });
    expect(() => load()).toThrowError(/baseURL/);
  });
});

describe('记忆配置 memory（Phase-9 M3 / A16）', () => {
  afterEach(() => {
    delete process.env.AI_CODE_MEMORY_ENABLED;
    delete process.env.AI_CODE_MEMORY_THRESHOLD;
    delete process.env.AI_CODE_MEMORY_KEEP_RECENT;
    delete process.env.AI_CODE_MEMORY_THRESHOLD_TOKENS;
    delete process.env.AI_CODE_MEMORY_KEEP_RECENT_TOKENS;
    delete process.env.AI_CODE_MEMORY_SUMMARIZER;
  });

  it('缺省回落记忆默认值', () => {
    const { config } = load();
    expect(config.memory).toEqual({
      enabled: true,
      thresholdMsgs: 40,
      keepRecent: 16,
      thresholdTokens: 24000,
      keepRecentTokens: 8000,
      summarizer: 'heuristic',
    });
  });

  it('memory 子字段：项目级覆盖用户级，未覆盖子字段保留下层（深合并）', () => {
    writeUserConfig({ memory: { thresholdMsgs: 30, summarizer: 'llm', keepRecent: 8 } });
    writeProjectConfig({ memory: { thresholdMsgs: 50 } });
    const { config } = load();
    // 项目级覆盖
    expect(config.memory.thresholdMsgs).toBe(50);
    // 用户级独有、项目级未写 → 保留用户级
    expect(config.memory.summarizer).toBe('llm');
    expect(config.memory.keepRecent).toBe(8);
    // 两层都没写 → 默认值
    expect(config.memory.thresholdTokens).toBe(24000);
    expect(config.memory.enabled).toBe(true);
  });

  it('AI_CODE_MEMORY_* 覆盖文件配置', () => {
    writeProjectConfig({ memory: { thresholdMsgs: 50, summarizer: 'heuristic' } });
    process.env.AI_CODE_MEMORY_THRESHOLD = '12';
    process.env.AI_CODE_MEMORY_THRESHOLD_TOKENS = '9000';
    process.env.AI_CODE_MEMORY_SUMMARIZER = 'auto';
    process.env.AI_CODE_MEMORY_ENABLED = 'false';
    const { config } = load();
    expect(config.memory.thresholdMsgs).toBe(12);
    expect(config.memory.thresholdTokens).toBe(9000);
    expect(config.memory.summarizer).toBe('auto');
    expect(config.memory.enabled).toBe(false);
    // 未被 env 覆盖的字段保留文件 / 默认
    expect(config.memory.keepRecent).toBe(16);
  });

  it('非法 summarizer 枚举报错并指出字段', () => {
    writeProjectConfig({ memory: { summarizer: 'gpt' } });
    expect(() => load()).toThrow(/summarizer/);
  });

  it('memory 数值超上限报错并指出字段', () => {
    writeProjectConfig({ memory: { thresholdTokens: 99_999_999 } });
    expect(() => load()).toThrow(/thresholdTokens/);
  });

  it('env 非法值（summarizer）经校验报错', () => {
    process.env.AI_CODE_MEMORY_SUMMARIZER = 'bad-kind';
    expect(() => load()).toThrow(/summarizer/);
  });
});

describe('密钥处理 — 环境优先、文件兜底、永不泄露', () => {
  it('优先 ANTHROPIC_AUTH_TOKEN', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token';
    writeUserConfig({ apiKey: 'file-key' });
    const loaded = load();
    expect(loaded.apiKey).toBe('env-token');
    expect(loaded.apiKeyConfigured).toBe(true);
  });

  it('兼容 CODEPLAN_API_KEY（次于 ANTHROPIC_AUTH_TOKEN）', () => {
    process.env.CODEPLAN_API_KEY = 'codeplan-token';
    const loaded = load();
    expect(loaded.apiKey).toBe('codeplan-token');
    expect(loaded.apiKeyConfigured).toBe(true);
  });

  it('环境缺失时回落配置文件 apiKey，项目级优先于用户级', () => {
    writeUserConfig({ apiKey: 'user-key' });
    writeProjectConfig({ apiKey: 'project-key' });
    const loaded = load();
    expect(loaded.apiKey).toBe('project-key');
    expect(loaded.apiKeyConfigured).toBe(true);
  });

  it('完全未配置密钥时 apiKeyConfigured=false', () => {
    const loaded = load();
    expect(loaded.apiKey).toBeUndefined();
    expect(loaded.apiKeyConfigured).toBe(false);
  });

  it('apiKey 不进入 config 结构（config 可安全打印）', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token';
    writeUserConfig({ apiKey: 'file-key' });
    const { config } = load();
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('env-token');
    expect(serialized).not.toContain('file-key');
    expect(config).not.toHaveProperty('apiKey');
  });

  it('redactSecret 永远返回 ***，不回显原文', () => {
    expect(redactSecret('super-secret-token')).toBe('***');
    expect(redactSecret(undefined)).toBe('***');
  });

  // Phase-7 P7-C：配置硬上限（Loop 不失控）
  it('P7-C：边界值（=上限）通过', () => {
    writeProjectConfig({ timeoutMs: 120000, maxTurns: 50, maxRetries: 5 });
    const { config } = load();
    expect(config.timeoutMs).toBe(120000);
    expect(config.maxTurns).toBe(50);
    expect(config.maxRetries).toBe(5);
  });

  it('P7-C：timeoutMs 超上限报错并指出字段', () => {
    writeProjectConfig({ timeoutMs: 999999999 });
    expect(() => load()).toThrow(/timeoutMs/);
  });

  it('P7-C：maxTurns 超上限报错并指出字段', () => {
    writeProjectConfig({ maxTurns: 1000000000 });
    expect(() => load()).toThrow(/maxTurns/);
  });

  it('P7-C：maxRetries 超上限报错并指出字段', () => {
    writeProjectConfig({ maxRetries: 999999 });
    expect(() => load()).toThrow(/maxRetries/);
  });
});
