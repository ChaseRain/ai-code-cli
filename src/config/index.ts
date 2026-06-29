// src/config/index.ts
// 配置加载：默认值 ← 用户级 ← 项目级（深合并）→ zod 校验 → 返回 Config。
// 密钥从环境变量解析（dotenv 加载 .env），永不进入 Config 结构、永不打印。
// 唯一真相来源：src/core/types.ts 的 Config 与 docs/product-specs/config.md。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import type { Config } from '../core/types.js';

// ============================================================================
// 默认值（与 config.md「字段」一节一致）
// ============================================================================

const DEFAULTS: Config = {
  provider: 'anthropic',
  model: 'deepseek/deepseek-v4-pro',
  baseURL: 'https://ai-kas.kso.net/codeplan/anthropic',
  timeoutMs: 60000,
  maxTurns: 25,
  maxRetries: 2,
};

// ============================================================================
// zod schema —— 校验合并后的最终配置。
// 全部字段可缺省（缺失回落默认值），但出现时必须类型/取值正确。
// .strict() 用于拒绝未知字段，给出清晰错误而非静默吞掉拼写错误。
// ============================================================================

const ConfigSchema = z
  .object({
    provider: z.literal('anthropic'),
    model: z.string().min(1),
    baseURL: z.string().url(),
    // Phase-7 P7-C：硬上限，Loop 工程不能失控。
    timeoutMs: z.number().int().positive().max(120000, 'timeoutMs 不能超过 120000（120s）'),
    maxTurns: z.number().int().positive().max(50, 'maxTurns 不能超过 50'),
    maxRetries: z.number().int().nonnegative().max(5, 'maxRetries 不能超过 5'),
  })
  .strict();

/** 来自文件的「部分配置」：每个字段都可缺省，apiKey 作为兜底密钥被单独剥离。 */
const PartialFileSchema = ConfigSchema.partial()
  .extend({
    // 允许配置文件写 apiKey 作为兜底，但它不进入 Config，仅用于密钥解析。
    apiKey: z.string().optional(),
  })
  .strict();

// ============================================================================
// 路径
// ============================================================================

/** 用户级配置：~/.config/ai-code-cli/config.json */
function userConfigPath(): string {
  return join(homedir(), '.config', 'ai-code-cli', 'config.json');
}

/** 项目级配置：<cwd>/.ai-code-cli/config.json */
function projectConfigPath(cwd: string): string {
  return join(cwd, '.ai-code-cli', 'config.json');
}

// ============================================================================
// 读取与深合并
// ============================================================================

type PartialFileConfig = z.infer<typeof PartialFileSchema>;

/**
 * 读取并解析单个配置文件。
 * - 文件不存在：返回 {}（回落默认值，不报错）。
 * - JSON 语法错误或字段非法：抛出带路径的清晰错误。
 */
function readConfigFile(path: string): PartialFileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`无法读取配置文件 ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 JSON 解析失败 ${path}: ${(err as Error).message}`);
  }

  const result = PartialFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`配置文件校验失败 ${path}:\n${formatZodError(result.error)}`);
  }
  return result.data;
}

/**
 * 浅合并即可——Config 是扁平结构（无嵌套对象），后者覆盖前者。
 * 「深合并」语义在扁平结构上等价于「逐字段覆盖且未覆盖字段保留」，
 * 用 undefined 过滤确保「文件里没写的字段」不会冲掉上一层的值。
 */
function mergeLayer<T extends object>(base: T, override: Partial<T>): T {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** 把 zod 错误格式化为多行、按字段定位的可读文本。 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length ? i.path.join('.') : '(根)';
      return `  - ${path}: ${i.message}`;
    })
    .join('\n');
}

// ============================================================================
// 密钥解析（永不打印；脱敏由 redactSecret 负责）
// ============================================================================

/**
 * 解析 API Key：环境变量优先，配置文件 apiKey 兜底。
 * 顺序：ANTHROPIC_AUTH_TOKEN → CODEPLAN_API_KEY → 配置文件 apiKey。
 * 返回 undefined 表示未配置。永远不要把返回值写入日志/状态输出。
 */
function resolveApiKey(fileApiKey?: string): string | undefined {
  return (
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.CODEPLAN_API_KEY ||
    fileApiKey ||
    undefined
  );
}

/** 脱敏：任何密钥对外只显示 ***，绝不回显原文。 */
export function redactSecret(_secret: string | undefined): string {
  return '***';
}

// ============================================================================
// 公共入口
// ============================================================================

export interface LoadConfigOptions {
  /** 项目根（默认 process.cwd()）；用于定位项目级配置。 */
  cwd?: string;
  /** 是否加载 .env（默认 true）。测试中可关闭以隔离环境。 */
  loadEnv?: boolean;
}

/** loadConfig 的返回：校验通过的 Config + 密钥「是否已配置」标志。 */
export interface LoadedConfig {
  /** 校验后的配置（不含密钥，可安全打印）。 */
  config: Config;
  /** 密钥是否已配置（供 /status、/model 显示「已配置/未配置」）。 */
  apiKeyConfigured: boolean;
  /**
   * 解析出的密钥原文。仅供 Provider 直接使用；**永不打印**。
   * 未配置时为 undefined。
   */
  apiKey?: string;
}

/**
 * 加载配置：默认值 ← 用户级 ← 项目级 深合并，zod 校验，密钥环境优先。
 * @throws 当任一配置文件 JSON 非法或字段校验失败（含清晰路径与原因）。
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const loadEnv = options.loadEnv ?? true;

  // 从 .env 加载环境变量（不覆盖已存在的 process.env）。
  if (loadEnv) loadDotenv();

  const userFile = readConfigFile(userConfigPath());
  const projectFile = readConfigFile(projectConfigPath(cwd));

  // 剥离 apiKey：它不属于 Config，仅参与密钥解析。
  const { apiKey: userApiKey, ...userConfig } = userFile;
  const { apiKey: projectApiKey, ...projectConfig } = projectFile;

  // 深合并：默认值 ← 用户级 ← 项目级。
  let merged: Config = mergeLayer(DEFAULTS, userConfig);
  merged = mergeLayer(merged, projectConfig);

  // 终态再次完整校验（防御默认值漂移；同时把合并结果收敛到 Config 形态）。
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`配置校验失败:\n${formatZodError(result.error)}`);
  }

  // 项目级 apiKey 优先于用户级（与字段覆盖语义一致）。
  const apiKey = resolveApiKey(projectApiKey ?? userApiKey);

  return {
    config: result.data,
    apiKeyConfigured: apiKey !== undefined && apiKey.length > 0,
    apiKey,
  };
}
