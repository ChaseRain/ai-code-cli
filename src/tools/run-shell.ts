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
/** 输出内存硬上限（字符）。stdout / stderr 各自独立计上限。 */
const MAX_OUTPUT = 30_000;
const TRUNCATED_NOTE = '\n…(输出过长已截断)';

/**
 * 有上限的输出缓冲：边读边截断，达到 MAX_OUTPUT 后丢弃后续内容（继续消费流但不再累积），
 * 因此进程内存不会随高输出命令无限增长（Phase-6 LH2）。
 */
class CappedBuffer {
  private buf = '';
  truncated = false;
  push(chunk: string): void {
    if (this.buf.length >= MAX_OUTPUT) {
      this.truncated = true;
      return; // 已满：丢弃，避免 OOM
    }
    const room = MAX_OUTPUT - this.buf.length;
    if (chunk.length > room) {
      this.buf += chunk.slice(0, room);
      this.truncated = true;
    } else {
      this.buf += chunk;
    }
  }
  /** 渲染为文本，截断时附提示。 */
  render(): string {
    return this.truncated ? this.buf + TRUNCATED_NOTE : this.buf;
  }
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
      // P7-D：detached 让 child 成为进程组组长（pgid=pid），便于杀**整组**——
      // 否则 shell 派生的后台子进程会被 reparent、持有 pipe，导致超时守护失效、Promise 悬挂。
      const child = spawn(command, {
        cwd: ctx.rootDir,
        shell: true,
        detached: true,
      });

      const stdout = new CappedBuffer();
      const stderr = new CappedBuffer();
      let timedOut = false;
      let aborted = false;
      let settled = false;

      /** 杀整个进程组（POSIX）；失败回退杀 child 本身。 */
      const killTree = (sig: NodeJS.Signals): void => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* 进程已退出 */
          }
        }
      };

      const onAbort = (): void => {
        aborted = true;
        killTree('SIGKILL');
      };

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGKILL');
      }, timeout);

      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (d) => {
        stdout.push(d.toString());
      });
      child.stderr?.on('data', (d) => {
        stderr.push(d.toString());
      });

      child.on('error', (err) => {
        finish({ ok: false, error: `命令启动失败：${err.message}` });
      });

      child.on('close', (code, sig) => {
        if (aborted) {
          finish({ ok: false, error: 'run_shell 被中断' });
          return;
        }
        if (timedOut) {
          finish({
            ok: false,
            error: `命令超时（${timeout}ms）被终止\n--- stdout ---\n${stdout.render()}\n--- stderr ---\n${stderr.render()}`,
          });
          return;
        }
        if (code === 0) {
          const body = stdout.render() || '(无输出)';
          finish({ ok: true, content: body });
          return;
        }
        // 非零退出 → 失败，附 stderr
        const codeDesc = code === null ? `信号 ${sig}` : `退出码 ${code}`;
        finish({
          ok: false,
          error: `命令失败（${codeDesc}）\n--- stdout ---\n${stdout.render()}\n--- stderr ---\n${stderr.render()}`,
        });
      });
    });
  },
};
