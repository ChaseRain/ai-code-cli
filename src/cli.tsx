#!/usr/bin/env node
// src/cli.tsx
// 入口：装配 config / provider / tools / permission / session，启动 Ink TUI。
// 职责单一（ARCHITECTURE：cli.tsx = 装配 + 启动）。不含业务逻辑——
//   决策在 agent/loop，IO 在各模块；这里只把它们接起来并 render(App)。
//
// 流程：dotenv（loadConfig 内部已 loadDotenv）→ loadConfig → 有 Key 用 AnthropicProvider，
//   否则友好提示但仍进入 TUI（本地命令 /help /status /model /clear 可用）→ render。

import React from 'react';
import { render } from 'ink';

import { loadConfig } from './config/index.js';
import { AnthropicProvider } from './provider/index.js';
import type { Provider } from './core/types.js';
import { createDefaultRegistry } from './tools/index.js';
import { Session } from './session/index.js';
import { CheckpointStore } from './checkpoint/index.js';
import { PlanStore } from './plan/index.js';
import { App } from './tui/index.js';
import { SYSTEM_PROMPT } from './core/system-prompt.js';

function main(): void {
  const cwd = process.cwd();

  // ── 配置 ──────────────────────────────────────────────────────────────
  // loadConfig 内部加载 .env、深合并三层、zod 校验，并解析（不打印）密钥。
  let loaded;
  try {
    loaded = loadConfig({ cwd });
  } catch (err) {
    // 配置非法是「致命且需用户修正」的场景：清晰报错并退出，不进入 TUI。
    process.stderr.write(`配置加载失败：\n${(err as Error).message}\n`);
    process.exit(1);
    return;
  }

  const { config, apiKey, apiKeyConfigured } = loaded;

  // ── 会话 ──────────────────────────────────────────────────────────────
  // 注入系统提示作为上下文首条（system role → Provider 提取为顶层 system 字段）。
  const session = new Session({ rootDir: cwd });
  session.append({ role: 'system', content: SYSTEM_PROMPT });

  // ── 工具注册表（7 个内置原子工具 + update_plan）─────────────────────────
  // PlanStore 在 cli 创建并同时注入工具与 TUI，保证 update_plan 工具与 /plan 命令共享同一计划。
  const planStore = new PlanStore();
  const tools = createDefaultRegistry(planStore);
  const checkpointStore = new CheckpointStore(cwd);

  // ── Provider 工厂 ──────────────────────────────────────────────────────
  // /model 切换时按新 model 重建 Provider。未配置 Key 时返回 null（仅本地命令可用）。
  const makeProvider = (model: string): Provider | null => {
    if (!apiKey) return null;
    return new AnthropicProvider({
      baseURL: config.baseURL,
      apiKey,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    });
    // 说明：AnthropicProvider 从 ChatRequest.model 取模型；model 由 Loop 经 RunOpts 注入，
    // 故工厂无需把 model 传进构造器，切换 model 只需让 App 用新值发起 runAgent。
  };

  if (!apiKeyConfigured) {
    process.stderr.write(
      '提示：未检测到 API Key（环境变量 ANTHROPIC_AUTH_TOKEN）。\n' +
        '可在项目根的 .env 写入 ANTHROPIC_AUTH_TOKEN=... 后重启。\n' +
        '当前可使用本地命令：/help /status /model /clear /exit。\n\n',
    );
  }

  // ── 启动 TUI ────────────────────────────────────────────────────────────
  const { waitUntilExit } = render(
    React.createElement(App, {
      tools,
      session,
      initialModel: config.model,
      baseURL: config.baseURL,
      maxTurns: config.maxTurns,
      apiKeyConfigured,
      makeProvider,
      checkpointStore,
      planStore,
    }),
  );

  waitUntilExit().then(() => process.exit(0));
}

main();
