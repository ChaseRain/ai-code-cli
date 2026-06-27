// src/tui/index.ts
// tui 模块出口。cli.tsx 从这里取 App 与命令解析；测试取 parseInput。

export { App } from './App.js';
export type { AppProps } from './App.js';
export { parseInput, HELP_TEXT } from './command.js';
export type { ParsedInput } from './command.js';
export type { ViewMessage } from './messages.js';
