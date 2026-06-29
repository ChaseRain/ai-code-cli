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

/** 记忆配置默认值（Phase-9 M3，与 config.md / memory.md 一致）。 */
const MEMORY_DEFAULTS: Config['memory'] = {
  enabled: true,
  thresholdMsgs: 40,
  keepRecent: 16,
  thresholdTokens: 24000,
  keepRecentTokens: 8000,
  summarizer: 'heuristic',
};

const DEFAULTS: Config = {
  provider: 'anthropic',
  model: 'deepseek/deepseek-v4-pro',
  baseURL: 'https://ai-kas.kso.net/codeplan/anthropic',
  timeoutMs: 60000,
  maxTurns: 25,
  maxRetries: 2,
  memory: MEMORY_DEFAULTS,
};

// ============================================================================
// zod schema —— 校验合并后的最终配置。
// 全部字段可缺省（缺失回落默认值），但出现时必须类型/取值正确。
// .strict() 用于拒绝未知字段，给出清晰错误而非静默吞掉拼写错误。
// ============================================================================

/**
 * 记忆配置 schema（Phase-9 M3）。所有子字段可缺省（缺省回落 MEMORY_DEFAULTS），
 * 出现时必须类型/取值正确并设硬上限（防 Loop / 压缩失控，与现有 .max() 风格一致）。
 * 终态用 .strict()；终态 memory 整体经 .default() 补齐为完整对象。
 */
const MemorySchema = z
  .object({
    enabled: z.boolean(),
    thresholdMsgs: z.number().int().positive().max(2000, 'memory.thresholdMsgs 不能超过 2000'),
    keepRecent: z.number().int().positive().max(2000, 'memory.keepRecent 不能超过 2000'),
    thresholdTokens: z
      .number()
      .int()
      .positive()
      .max(1_000_000, 'memory.thresholdTokens 不能超过 1000000'),
    keepRecentTokens: z
      .number()
      .int()
      .positive()
      .max(1_000_000, 'memory.keepRecentTokens 不能超过 1000000'),
    summarizer: z.enum(['heuristic', 'llm', 'auto']),
  })
  .strict();

const ConfigSchema = z
  .object({
    provider: z.literal('anthropic'),
    model: z.string().min(1),
    baseURL: z.string().url(),
    // Phase-7 P7-C：硬上限，Loop 工程不能失控。
    timeoutMs: z.number().int().positive().max(120000, 'timeoutMs 不能超过 120000（120s）'),
    maxTurns: z.number().int().positive().max(50, 'maxTurns 不能超过 50'),
    maxRetries: z.number().int().nonnegative().max(5, 'maxRetries 不能超过 5'),
    memory: MemorySchema,
  })
  .strict();

/**
 * 来自文件的「部分配置」：每个字段都可缺省，apiKey 作为兜底密钥被单独剥离。
 * memory 子字段亦可逐项缺省（深合并：未写子字段保留下层值），故用 MemorySchema.partial()。
 */
const PartialFileSchema = ConfigSchema.partial()
  .extend({
    memory: MemorySchema.partial().strict().optional(),
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
// 记忆配置环境变量覆盖（Phase-9 M3）—— 优先级高于文件配置。
// 仅覆盖「已设置且非空」的变量；非法值留给后续 zod 校验报错（不静默吞）。
// ============================================================================

/** 把字符串解析为整数；非整数返回 NaN（交给 zod 报错）。 */
function parseIntEnv(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 把字符串解析为布尔：'true'/'1' → true，'false'/'0' → false，其它原样返回（交给 zod 报错）。 */
function parseBoolEnv(v: string): boolean | string {
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return v;
}

/**
 * 应用 AI_CODE_MEMORY_* 环境变量覆盖。返回新对象（不改入参）。
 * 覆盖后的值仍需经 ConfigSchema 校验（含上限 / 枚举），非法值会报错并指出字段。
 */
function applyMemoryEnvOverrides(memory: Partial<Config['memory']>): Config['memory'] {
  const out = { ...memory } as Record<string, unknown>;
  const env = process.env;
  if (env.AI_CODE_MEMORY_ENABLED) out.enabled = parseBoolEnv(env.AI_CODE_MEMORY_ENABLED);
  if (env.AI_CODE_MEMORY_THRESHOLD) out.thresholdMsgs = parseIntEnv(env.AI_CODE_MEMORY_THRESHOLD);
  if (env.AI_CODE_MEMORY_KEEP_RECENT) out.keepRecent = parseIntEnv(env.AI_CODE_MEMORY_KEEP_RECENT);
  if (env.AI_CODE_MEMORY_THRESHOLD_TOKENS)
    out.thresholdTokens = parseIntEnv(env.AI_CODE_MEMORY_THRESHOLD_TOKENS);
  if (env.AI_CODE_MEMORY_KEEP_RECENT_TOKENS)
    out.keepRecentTokens = parseIntEnv(env.AI_CODE_MEMORY_KEEP_RECENT_TOKENS);
  if (env.AI_CODE_MEMORY_SUMMARIZER) out.summarizer = env.AI_CODE_MEMORY_SUMMARIZER;
  // 这里只做「字段覆盖」，类型正确性由后续 ConfigSchema 校验保证；故经 unknown 收敛。
  return out as unknown as Config['memory'];
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
  const { apiKey: userApiKey, memory: userMemory, ...userConfig } = userFile;
  const { apiKey: projectApiKey, memory: projectMemory, ...projectConfig } = projectFile;

  // 深合并：默认值 ← 用户级 ← 项目级（顶层扁平字段）。
  let merged: Config = mergeLayer(DEFAULTS, userConfig);
  merged = mergeLayer(merged, projectConfig);

  // memory 子对象单独深合并（逐子字段覆盖，未覆盖项保留下层值）。
  let memory = mergeLayer(MEMORY_DEFAULTS, userMemory ?? {});
  memory = mergeLayer(memory, projectMemory ?? {});
  // 环境变量覆盖（优先级最高）。
  memory = applyMemoryEnvOverrides(memory);
  merged.memory = memory;

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
