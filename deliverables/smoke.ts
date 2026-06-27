// deliverables/smoke.ts
// 真实 API 冒烟：headless 直接装配 runAgent 跑一个只读任务（"读取并总结 package.json"）。
// TUI 是 Ink 交互式、无法 headless 驱动，故此脚本绕过 TUI，直接调用 src 里的
// AnthropicProvider / ToolRegistry / Permission / Session / runAgent 完成并存档。
// 不打印密钥；只用 .env 里的环境变量（运行前请 `set -a; source .env; set +a`）。
//
// 运行：npx tsx deliverables/smoke.ts
//
// 注意：本脚本只放在 deliverables/（交付脚本），不进 src/，不改动核心代码。

import { loadConfig } from '../src/config/index.js';
import { AnthropicProvider } from '../src/provider/index.js';
import { createDefaultRegistry } from '../src/tools/index.js';
import { Permission } from '../src/permission/index.js';
import { Session } from '../src/session/index.js';
import { runAgent } from '../src/agent/index.js';
import { SYSTEM_PROMPT } from '../src/core/system-prompt.js';

async function main(): Promise<void> {
  const cwd = process.cwd();
  const { config, apiKey, apiKeyConfigured } = loadConfig({ cwd });

  if (!apiKeyConfigured || !apiKey) {
    console.error('未检测到 API Key（ANTHROPIC_AUTH_TOKEN）。请先 `set -a; source .env; set +a`。');
    process.exit(2);
  }

  const provider = new AnthropicProvider({
    baseURL: config.baseURL,
    apiKey: apiKey!,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });

  const tools = createDefaultRegistry();
  // headless：所有敏感工具一律拒绝（本任务只读，不应触发；保守守护栏）。
  const permission = new Permission(async () => 'deny');
  const session = new Session({ rootDir: cwd });
  session.append({ role: 'system', content: SYSTEM_PROMPT });

  const ac = new AbortController();
  // 整体兜底超时：避免脚本永久挂起。
  const hardTimeout = setTimeout(() => ac.abort(new Error('smoke hard timeout')), 120_000);

  const out: string[] = [];
  const log = (s: string) => {
    out.push(s);
    process.stdout.write(s + '\n');
  };

  log('=== ai-code-cli 真实 API 冒烟 ===');
  log(`时间: ${new Date().toISOString()}`);
  log(`模型: ${config.model}`);
  log(`baseURL: ${config.baseURL}`);
  log(`API Key: 已配置（脱敏：***）`);
  log('任务: 读取并总结 package.json');
  log('');

  let assistantBuf = '';
  await runAgent(
    '请用 read_file 工具读取本项目根目录的 package.json，然后用三到五句话总结这个项目（名称、用途、关键脚本、主要依赖）。',
    { provider, tools, permission, session },
    {
      model: config.model,
      maxTurns: config.maxTurns,
      signal: ac.signal,
      onEvent: (e) => {
        switch (e.type) {
          case 'phase':
            log(`[phase] ${e.phase} (turn ${e.turn}/${e.maxTurns})`);
            break;
          case 'assistant_delta':
            assistantBuf += e.delta;
            break;
          case 'assistant_done':
            if (e.content) log(`\n[assistant]\n${e.content}\n`);
            assistantBuf = '';
            break;
          case 'tool_call':
            log(`[tool_call] ${e.name} args=${JSON.stringify(e.args)}`);
            break;
          case 'tool_result':
            log(
              `[tool_result] ${e.name} ok=${e.result.ok} ` +
                (e.result.ok
                  ? `(${e.result.content.length} chars)`
                  : `error=${e.result.error}`),
            );
            break;
          case 'error':
            log(`[error] ${e.message}`);
            break;
          case 'end':
            log(`\n[end] reason=${e.reason}`);
            break;
        }
      },
    },
  );

  clearTimeout(hardTimeout);
  log(`\n会话日志: ${session.logFile}`);
}

main().catch((err) => {
  console.error('smoke 失败:', (err as Error)?.message ?? err);
  process.exit(1);
});
