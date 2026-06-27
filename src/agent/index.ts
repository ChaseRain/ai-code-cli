// src/agent/index.ts
// agent 模块出口。上层（cli/tui）只从这里导入编排入口与 UI 事件契约。

export { runAgent } from './loop.js';
export type {
  AgentDeps,
  RunOpts,
  UIEvent,
  AgentPhase,
  EndReason,
} from './loop.js';
