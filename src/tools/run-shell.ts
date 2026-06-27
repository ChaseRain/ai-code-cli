// src/tools/run-shell.ts
// run_shell：执行 Shell 命令（非只读，需权限）。带超时；捕获 stdout/stderr/exit。
// 非零退出码收敛为 ok:false 并附 stderr。工作目录固定为 rootDir（沙箱边界）。

import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';

interface RunShellArgs {
  /** 要执行的 Shell 命令 */
  command?: string;
  /** 超时毫秒，缺省 30000，上限 120000 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;
/** 输出截断上限（字符）。 */
const MAX_OUTPUT = 30_000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…(输出过长已截断)' : s;
}

export const runShell: Tool = {
  name: 'run_shell',
  description:
    '在项目根目录执行 Shell 命令，捕获 stdout/stderr 与退出码。带超时；非零退出会作为失败返回。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 Shell 命令' },
      timeoutMs: { type: 'integer', description: '超时毫秒，缺省 30000，上限 120000' },
    },
    required: ['command'],
  },
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command, timeoutMs } = (args ?? {}) as RunShellArgs;
    if (!command) return Promise.resolve({ ok: false, error: 'run_shell 缺少参数：command' });

    const timeout = Math.min(Math.max(1, timeoutMs ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(command, {
        cwd: ctx.rootDir,
        shell: true,
        signal: ctx.signal,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        // 包含 AbortSignal 触发的中断
        if ((err as NodeJS.ErrnoException).name === 'AbortError') {
          finish({ ok: false, error: 'run_shell 被中断' });
          return;
        }
        finish({ ok: false, error: `命令启动失败：${err.message}` });
      });

      child.on('close', (code, sig) => {
        if (timedOut) {
          finish({
            ok: false,
            error: `命令超时（${timeout}ms）被终止\n--- stdout ---\n${clip(stdout)}\n--- stderr ---\n${clip(stderr)}`,
          });
          return;
        }
        if (code === 0) {
          const body = clip(stdout) || '(无输出)';
          finish({ ok: true, content: body });
          return;
        }
        // 非零退出 → 失败，附 stderr
        const codeDesc = code === null ? `信号 ${sig}` : `退出码 ${code}`;
        finish({
          ok: false,
          error: `命令失败（${codeDesc}）\n--- stdout ---\n${clip(stdout)}\n--- stderr ---\n${clip(stderr)}`,
        });
      });
    });
  },
};
