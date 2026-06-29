// src/session/index.ts
// session 模块出口。
export {
  Session,
  SUMMARY_PREFIX,
  DEFAULT_MEMORY_KEEP_RECENT,
  DEFAULT_MEMORY_THRESHOLD_MSGS,
  DEFAULT_MEMORY_THRESHOLD_TOKENS,
  DEFAULT_MEMORY_KEEP_RECENT_TOKENS,
  HeuristicSummarizer,
  createHeuristicSummarizer,
  estimateTokens,
  estimateTokensTotal,
} from './session.js';
export {
  LLMSummarizer,
  FallbackSummarizer,
  createSummarizer,
} from './llm-summarizer.js';
export { listSessions, resolveSessionLog, summarizeLog } from './browser.js';
export type {
  SessionOptions,
  LogKind,
  LogRecord,
  Summarizer,
} from './session.js';
export type { LLMSummarizerOptions, SummarizerKind } from './llm-summarizer.js';
export type { SessionSummary } from './browser.js';
