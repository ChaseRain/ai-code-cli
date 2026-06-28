// deliverables/screenshots.ts
// 生成 TUI 运行的真实截图 + smoke 帧文本（可复现）。
// 方法：ink-testing-library 渲染 App 真正使用的同一批组件得到终端帧（含 ANSI）
//   → 帧文本存 deliverables/tui-frames/*.txt（smoke 证据）
//   → ANSI 转 HTML（ansi-to-html）→ headless Chrome --screenshot 出 PNG。
//   snake.html 用 headless Chrome 直接截图。
// 用法：
//   npx tsx deliverables/screenshots.ts          # 全部
//   npx tsx deliverables/screenshots.ts 03 04    # 仅指定（小步重试，避免长时间卡住）
import React from 'react';
import { render } from 'ink-testing-library';
import Convert from 'ansi-to-html';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { App, MessageList, PermissionPrompt } from '../src/tui/App.js';
import { MockProvider } from '../src/provider/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Session } from '../src/session/index.js';
import type { ViewMessage } from '../src/tui/messages.js';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'deliverables', 'screenshots');
const FRAMES = join(ROOT, 'deliverables', 'tui-frames');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(FRAMES, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const conv = new Convert({ fg: '#d6d6d6', bg: '#0b0b0b', newline: true, escapeXML: true });
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

function frameToHtml(frame: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#0b0b0b}
    pre{font:14px/1.4 Menlo,Monaco,monospace;color:#d6d6d6;padding:16px;white-space:pre}
  </style></head><body><pre>${conv.toHtml(frame)}</pre></body></html>`;
}

/** 单张 Chrome 截图：硬超时 10s；忽略非零退出/告警；以文件存在为成功判据。 */
function chromeShot(url: string, out: string, w: number, h: number): void {
  const profile = mkdtempSync(join(tmpdir(), 'cc-shot-'));
  if (existsSync(out)) rmSync(out);
  try {
    execFileSync(
      CHROME,
      [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        '--run-all-compositor-stages-before-draw', '--virtual-time-budget=1000',
        `--user-data-dir=${profile}`,
        '--force-device-scale-factor=2',
        `--window-size=${w},${h}`,
        `--screenshot=${out}`,
        url,
      ],
      { stdio: 'ignore', timeout: 10000 }, // 硬超时 10s，绝不无限等
    );
  } catch {
    /* 忽略超时/非零退出，下面以文件存在性判定 */
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  if (!existsSync(out)) throw new Error(`Chrome 未能生成截图：${out}`);
}

function report(out: string): void {
  const kb = (statSync(out).size / 1024).toFixed(1);
  console.log(`✓ ${out.replace(ROOT + '/', '')} (${kb} KB)`);
}

function shotFromFrame(name: string, frame: string, w: number, h: number): void {
  const txt = join(FRAMES, `${name}.txt`);
  writeFileSync(txt, stripAnsi(frame), 'utf8'); // smoke 文本证据
  console.log(`✓ ${txt.replace(ROOT + '/', '')}`);
  const html = join(tmpdir(), `${name}.html`);
  writeFileSync(html, frameToHtml(frame), 'utf8');
  const out = join(SHOTS, `${name}.png`);
  chromeShot(`file://${html}`, out, w, h);
  report(out);
}

// ── 各张截图（按 key 注册，支持单独运行）──────────────────────────────────
const shots: Record<string, () => void> = {
  '01': () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cc-shot-root-'));
    const app = render(
      React.createElement(App, {
        tools: new ToolRegistry([]),
        session: new Session({ rootDir: tmpRoot, id: 'shot' }),
        initialModel: 'deepseek/deepseek-v4-pro',
        baseURL: 'https://ai-kas.kso.net/codeplan/anthropic',
        maxTurns: 25,
        apiKeyConfigured: true,
        makeProvider: () => new MockProvider({ scripts: [] }),
      }),
    );
    shotFromFrame('01-tui-startup', app.lastFrame() ?? '', 1100, 360);
    app.unmount();
    rmSync(tmpRoot, { recursive: true, force: true });
  },
  '02': () => {
    const messages: ViewMessage[] = [
      { kind: 'system', text: 'ai-code-cli —— 终端编码 Agent' },
      { kind: 'user', text: '读取并总结 package.json' },
      { kind: 'assistant', text: '我来读取 package.json。', streaming: false },
      { kind: 'tool-call', id: 'r1', name: 'read_file', args: { path: 'package.json' } },
      { kind: 'tool-result', id: 'r1', name: 'read_file', result: { ok: true, content: '{ name: ai-code-cli, ... } (730 chars)' } },
      { kind: 'assistant', text: '这是一个基于 Anthropic 协议的 TUI 编码 Agent…', streaming: false },
    ];
    const m = render(React.createElement(MessageList, { messages }));
    shotFromFrame('02-task-with-toolcall', m.lastFrame() ?? '', 1100, 320);
    m.unmount();
  },
  '03': () => {
    const p = render(
      React.createElement(PermissionPrompt, { tool: 'write_file', args: { path: 'snake.html' } }),
    );
    shotFromFrame('03-permission-prompt', p.lastFrame() ?? '', 900, 220);
    p.unmount();
  },
  '04': () => {
    const snake = join(ROOT, 'deliverables', 'snake', 'snake.html');
    const out = join(SHOTS, '04-snake-running.png');
    chromeShot(`file://${snake}`, out, 640, 760);
    report(out);
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(shots);
let hadFailure = false;
for (const k of want) {
  const key = k.replace(/\D/g, '').padStart(2, '0');
  const fn = shots[key] ?? shots[k];
  if (!fn) { console.log(`✗ 未知 key: ${k}`); hadFailure = true; continue; }
  try { fn(); } catch (e) { console.log(`✗ ${k} 失败：${(e as Error).message}`); hadFailure = true; }
}

// 校验本次涉及的目标 PNG 是否都已实际存在（哪怕之前轮已生成）。
const expected: Record<string, string> = {
  '01': '01-tui-startup.png',
  '02': '02-task-with-toolcall.png',
  '03': '03-permission-prompt.png',
  '04': '04-snake-running.png',
};
for (const k of want) {
  const key = k.replace(/\D/g, '').padStart(2, '0');
  const png = expected[key];
  if (png && !existsSync(join(SHOTS, png))) {
    console.log(`✗ 缺少 ${png}`);
    hadFailure = true;
  }
}

if (hadFailure) {
  console.log('done（有失败）');
  process.exitCode = 1; // 让 CI/评审能发现生成失败
} else {
  console.log('done（全部成功）');
}
