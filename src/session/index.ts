// src/session/index.ts
// session 模块出口。
export {
  Session,
  SUMMARY_PREFIX,
  DEFAULT_MEMORY_KEEP_RECENT,
  DEFAULT_MEMORY_THRESHOLD_MSGS,
  HeuristicSummarizer,
  createHeuristicSummarizer,
} from './session.js';
export { listSessions, resolveSessionLog, summarizeLog } from './browser.js';
export type {
  SessionOptions,
  LogKind,
  LogRecord,
  Summarizer,
} from './session.js';
export type { SessionSummary } from './browser.js';
