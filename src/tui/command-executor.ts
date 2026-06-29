// src/tui/command-executor.ts
// 内置命令执行器（Phase-10 Q1）——把原先内嵌在 App.tsx handleSubmit 里的命令副作用
// （IO + 状态查询）下沉到一个**可单测的纯逻辑模块**：
//   `ParsedInput + 注入 deps → CommandOutcome`。
//
// 职责边界（tui.md「内置命令执行器」）：
//   - 执行命令副作用：checkpoint 创建/列举、session.resume 目标解析、workspace 状态/diff
//     查询、plan 查看/清空、memory 状态格式化、sessions 列举。
//   - **不引用 React、不直接 push/setState、不渲染**：把「要展示的消息」「要触发的副作用」
//     作为数据返回（CommandOutcome），由 App.tsx 落到 UI。
//   - 所有错误以 CommandOutcome 数据返回（错误即数据），不向上抛。
//
// App.tsx 只保留运行时才能做的事：confirm-restore 的弹窗按键流、open-session-picker 的
//   picker state、set-model/clear-session/exit/resume/run-task 的 React/Ink 运行时副作用。
//   执行器只负责「算出该做什么 + 查好数据」。

import type { ParsedInput } from './command.js';
import { HELP_TEXT } from './command.js';
import type { MemoryCompactionOptions } from '../agent/index.js';
import type { CheckpointManifest, CheckpointStore } from '../checkpoint/index.js';
import type { PlanStore } from '../plan/index.js';
import { formatPlanSnapshot } from '../plan/index.js';
import type { Session } from '../session/index.js';
import { listSessions, resolveSessionLog } from '../session/index.js';
import type { SessionSummary } from '../session/index.js';
import type { SkillRegistry } from '../skills/index.js';
import {
  findLatestAutoCheckpoint,
  formatDiffResult,
  formatWorkspaceStatus,
  getWorkspaceDiff,
  getWorkspaceStatus,
} from '../workspace/index.js';

// ============================================================================
// 注入依赖：执行器只认这些「能力」，不认 React。便于测试注入 fake。
// ============================================================================

/** /status /model 展示所需的运行时上下文（由 App 提供当前值）。 */
export interface CommandStatusContext {
  model: string;
  baseURL: string;
  maxTurns: number;
  turn: number;
  apiKeyConfigured: boolean;
}

export interface CommandDeps {
  session: Session;
  checkpointStore: CheckpointStore;
  planStore: PlanStore;
  /** 提供 /status /model 的运行时上下文（getter，避免捕获过期值）。 */
  status: () => CommandStatusContext;
  /**
   * /memory 生效配置：undefined 表示自动压缩关闭（config.memory.enabled=false）；
   * summarizerLabel 为摘要器展示标签（由 App 据实例类型推导）。
   */
  memory?: MemoryCompactionOptions;
  summarizerLabel: string;
  /**
   * 技能注册表（Phase-11）：供 /skills 列目录 / 看正文。
   * undefined 表示 skills 已禁用（config.skills.enabled=false）→ /skills 给出「已禁用」提示。
   */
  skills?: SkillRegistry;
  // 以下为可注入的查询函数（默认用真实实现，测试可注入 fake）。
  listSessions?: typeof listSessions;
  getWorkspaceStatus?: typeof getWorkspaceStatus;
  getWorkspaceDiff?: typeof getWorkspaceDiff;
  findLatestAutoCheckpoint?: typeof findLatestAutoCheckpoint;
}

// ============================================================================
// 返回结构：消息 + 副作用（纯数据，便于断言）
// ============================================================================

/** 要 push 的消息（与 MessageList 的 system/error kind 对齐）。 */
export type OutMessage = { kind: 'system' | 'error'; text: string };

/** 要 App 触发的副作用（描述，不是执行）——纯数据，便于断言。 */
export type CommandEffect =
  | { type: 'none' }
  | { type: 'clear-session' } // session.clear + permission.reset + 重置 turn
  | { type: 'set-model'; id: string }
  | { type: 'open-session-picker'; items: SessionSummary[]; index: number }
  | { type: 'open-checkpoint-picker'; items: CheckpointManifest[]; index: number }
  | { type: 'resume'; target: string } // 已解析好的日志目标
  | { type: 'confirm-restore'; id: string } // /restore /undo-last → 进入确认态
  | { type: 'run-task'; text: string } // 非命令：落到 Agent
  | { type: 'exit' };

/** 单次执行的结构化结果：echoUser 决定是否回显原始输入，再给消息 + 一个副作用。 */
export interface CommandOutcome {
  echoUser: boolean;
  messages: OutMessage[];
  effect: CommandEffect;
}

export interface CommandExecutor {
  run(parsed: ParsedInput, raw: string): Promise<CommandOutcome>;
}

// ── 小工具：构造结果 ────────────────────────────────────────────────────────
function sys(text: string): OutMessage {
  return { kind: 'system', text };
}
function err(text: string): OutMessage {
  return { kind: 'error', text };
}
const NONE: CommandEffect = { type: 'none' };

const SESSIONS_LIMIT = 50;
const CHECKPOINTS_LIMIT = 50;

// ============================================================================
// 工厂
// ============================================================================

export function createCommandExecutor(deps: CommandDeps): CommandExecutor {
  const {
    session,
    checkpointStore,
    planStore,
    status,
    memory,
    summarizerLabel,
    skills,
  } = deps;
  // 查询函数默认用真实实现，测试可覆盖。
  const _listSessions = deps.listSessions ?? listSessions;
  const _getWorkspaceStatus = deps.getWorkspaceStatus ?? getWorkspaceStatus;
  const _getWorkspaceDiff = deps.getWorkspaceDiff ?? getWorkspaceDiff;
  const _findLatestAutoCheckpoint = deps.findLatestAutoCheckpoint ?? findLatestAutoCheckpoint;

  /** 列举会话并构造「打开选择器」结果（/resume 无参 与 /sessions 共用）。 */
  function openSessionPicker(): CommandOutcome {
    try {
      const items = _listSessions(session.rootDir, session.logFile, { limit: SESSIONS_LIMIT });
      if (items.length === 0) {
        return { echoUser: true, messages: [sys('暂无历史会话。')], effect: NONE };
      }
      const cur = items.findIndex((s) => s.current);
      return {
        echoUser: true,
        messages: [],
        effect: { type: 'open-session-picker', items, index: cur >= 0 ? cur : 0 },
      };
    } catch (e) {
      return { echoUser: true, messages: [err(`会话列表读取失败：${msg(e)}`)], effect: NONE };
    }
  }

  async function run(parsed: ParsedInput, raw: string): Promise<CommandOutcome> {
    switch (parsed.kind) {
      // ── 纯展示命令（echo 用户输入 + 系统消息）────────────────────────────
      case 'help':
        return { echoUser: true, messages: [sys(HELP_TEXT)], effect: NONE };

      case 'clear':
        // 运行时副作用（session.clear + permission.reset + 重置 turn）由 App 执行；
        //   消息亦由 App 在副作用后给出（保持「清屏」语义：整条消息流被替换）。
        return { echoUser: false, messages: [], effect: { type: 'clear-session' } };

      case 'status': {
        const s = status();
        return {
          echoUser: true,
          messages: [sys(formatStatus(s, session.logFile))],
          effect: NONE,
        };
      }

      case 'model': {
        const s = status();
        if (!parsed.id) {
          return { echoUser: true, messages: [sys(`当前模型：${s.model}`)], effect: NONE };
        }
        return {
          echoUser: true,
          messages: [sys(`已切换模型：${parsed.id}`)],
          effect: { type: 'set-model', id: parsed.id },
        };
      }

      case 'memory':
        return {
          echoUser: true,
          messages: [
            sys(formatMemoryStatus(session.memoryStats(), memory, summarizerLabel)),
          ],
          effect: NONE,
        };

      // ── resume：主流约定（如 Claude Code）——无参打开交互选择器；带参直接恢复指定日志 ──
      case 'resume': {
        if (!parsed.file) {
          // 无参：打开会话选择器（↑/↓ 选 + Enter 恢复），与 /sessions 同。
          return openSessionPicker();
        }
        const target = resolveSessionLog(session.rootDir, parsed.file, session.logFile);
        if (!target) {
          return {
            echoUser: true,
            messages: [sys('没有可恢复的历史会话日志。')],
            effect: NONE,
          };
        }
        return { echoUser: true, messages: [], effect: { type: 'resume', target } };
      }

      // ── sessions：/resume 的别名，同样打开交互选择器 ──────────────────────
      case 'sessions':
        return openSessionPicker();

      // ── checkpoint：创建（IO）────────────────────────────────────────────
      case 'checkpoint': {
        try {
          const cp = await checkpointStore.create({
            label: parsed.label,
            trigger: 'manual',
            sessionLog: session.logFile,
          });
          session.logCheckpoint({
            id: cp.id,
            trigger: cp.trigger,
            label: cp.label,
            files: cp.files.length,
          });
          return {
            echoUser: true,
            messages: [
              sys(
                `已创建 checkpoint ${cp.id}（${cp.files.length} 个文件，排除 ${cp.excluded.length} 项）。`,
              ),
            ],
            effect: NONE,
          };
        } catch (e) {
          return {
            echoUser: true,
            messages: [err(`checkpoint 创建失败：${msg(e)}`)],
            effect: NONE,
          };
        }
      }

      // ── checkpoints：列举（IO）──────────────────────────────────────────
      case 'checkpoints': {
        try {
          const cps = await checkpointStore.list({ limit: CHECKPOINTS_LIMIT });
          if (cps.length === 0) {
            return { echoUser: true, messages: [sys('暂无 checkpoint。')], effect: NONE };
          }
          const total = await checkpointStore.count();
          const lines = cps.map(
            (c) =>
              `${c.id} · ${c.trigger} · ${c.label ?? '-'} · ${c.files.length} files · ${c.createdAt}`,
          );
          if (total > cps.length) {
            lines.push(`（共 ${total} 个，仅展示最近 ${cps.length} 个）`);
          }
          return { echoUser: true, messages: [sys(lines.join('\n'))], effect: NONE };
        } catch (e) {
          return {
            echoUser: true,
            messages: [err(`checkpoint 列表读取失败：${msg(e)}`)],
            effect: NONE,
          };
        }
      }

      // ── rewind：主流约定（如 Claude Code）的回滚入口。无参打开快照选择器；
      //    带 id 直接进入确认态（与 /restore <id> 等价）。────────────────────
      case 'rewind': {
        if (parsed.id) {
          return {
            echoUser: true,
            messages: [sys(`确认回滚到 checkpoint ${parsed.id}？按 y 确认，n/Esc 取消。`)],
            effect: { type: 'confirm-restore', id: parsed.id },
          };
        }
        try {
          const items = await checkpointStore.list({ limit: CHECKPOINTS_LIMIT });
          if (items.length === 0) {
            return { echoUser: true, messages: [sys('暂无可回滚的 checkpoint。')], effect: NONE };
          }
          return {
            echoUser: true,
            messages: [],
            effect: { type: 'open-checkpoint-picker', items, index: 0 },
          };
        } catch (e) {
          return {
            echoUser: true,
            messages: [err(`checkpoint 列表读取失败：${msg(e)}`)],
            effect: NONE,
          };
        }
      }

      // ── restore：缺 id 报错；有 id 进入确认态 ────────────────────────────
      case 'restore': {
        if (!parsed.id) {
          return {
            echoUser: true,
            messages: [err('restore 缺少 checkpoint id。')],
            effect: NONE,
          };
        }
        return {
          echoUser: true,
          messages: [
            sys(`确认恢复 checkpoint ${parsed.id}？按 y 确认，n/Esc 取消。`),
          ],
          effect: { type: 'confirm-restore', id: parsed.id },
        };
      }

      // ── changes：工作区状态查询（IO）+ 格式化 ────────────────────────────
      case 'changes': {
        try {
          const wsStatus = await _getWorkspaceStatus(session.rootDir, checkpointStore);
          return {
            echoUser: true,
            messages: [sys(formatWorkspaceStatus(wsStatus))],
            effect: NONE,
          };
        } catch (e) {
          return {
            echoUser: true,
            messages: [err(`工作区状态读取失败：${msg(e)}`)],
            effect: NONE,
          };
        }
      }

      // ── diff：工作区 diff 查询（IO）+ 格式化 ─────────────────────────────
      case 'diff': {
        try {
          const diff = await _getWorkspaceDiff(session.rootDir, parsed.path);
          return {
            echoUser: true,
            messages: [sys(formatDiffResult(diff))],
            effect: NONE,
          };
        } catch (e) {
          return { echoUser: true, messages: [err(`diff 读取失败：${msg(e)}`)], effect: NONE };
        }
      }

      // ── undo-last：查最近自动 checkpoint（IO）→ 无则提示，有则进入确认态 ──
      case 'undo-last': {
        try {
          const cp = await _findLatestAutoCheckpoint(checkpointStore);
          if (!cp) {
            return {
              echoUser: true,
              messages: [sys('暂无可恢复的自动 checkpoint。')],
              effect: NONE,
            };
          }
          return {
            echoUser: true,
            messages: [
              sys(`确认恢复最近自动 checkpoint ${cp.id}？按 y 确认，n/Esc 取消。`),
            ],
            effect: { type: 'confirm-restore', id: cp.id },
          };
        } catch (e) {
          return {
            echoUser: true,
            messages: [err(`自动 checkpoint 查询失败：${msg(e)}`)],
            effect: NONE,
          };
        }
      }

      // ── plan：查看 / 清空 ───────────────────────────────────────────────
      case 'plan': {
        if (parsed.sub === 'clear') {
          planStore.clear();
          return {
            echoUser: true,
            messages: [sys('已清空当前任务计划。')],
            effect: NONE,
          };
        }
        return {
          echoUser: true,
          messages: [sys(formatPlanSnapshot(planStore.current()))],
          effect: NONE,
        };
      }

      // ── skills：列目录 / 看正文（Phase-11，纯展示无副作用）──────────────────
      case 'skills': {
        if (!skills) {
          return {
            echoUser: true,
            messages: [sys('技能功能已禁用（config.skills.enabled=false）。')],
            effect: NONE,
          };
        }
        if (!parsed.name) {
          const list = skills.list();
          if (list.length === 0) {
            return {
              echoUser: true,
              messages: [
                sys(
                  '暂无可用技能。把 SKILL.md 放进 ~/.config/ai-code-cli/skills/<name>/ 或 <项目>/.ai-code-cli/skills/<name>/ 即可。',
                ),
              ],
              effect: NONE,
            };
          }
          const lines = list.map(
            (s) => `${s.name} — ${s.description || '（无描述）'}  [${s.source}]`,
          );
          return {
            echoUser: true,
            messages: [sys(['可用技能：', ...lines].join('\n'))],
            effect: NONE,
          };
        }
        const res = skills.load(parsed.name);
        return {
          echoUser: true,
          messages: [res.ok ? sys(res.content) : err(res.error)],
          effect: NONE,
        };
      }

      case 'exit':
        return { echoUser: false, messages: [], effect: { type: 'exit' } };

      case 'unknown':
        return {
          echoUser: true,
          messages: [sys(`未知命令 /${parsed.name}，输入 /help 查看可用命令。`)],
          effect: NONE,
        };

      case 'task':
        // 非命令：落到 Agent（是否能跑由 App 据 Provider 是否就绪决定）。
        return { echoUser: false, messages: [], effect: { type: 'run-task', text: parsed.text } };
    }
  }

  return { run };
}

// ============================================================================
// 文案格式化（纯函数，App 与执行器共享单一真相；从 App.tsx 迁入）
// ============================================================================

function msg(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

/** 组装 `/status` 展示文本。 */
export function formatStatus(s: CommandStatusContext, logFile: string): string {
  return [
    `模型：${s.model}`,
    `baseURL：${s.baseURL}`,
    `轮次：${s.turn}/${s.maxTurns}`,
    `API Key：${s.apiKeyConfigured ? '已配置' : '未配置'}`,
    `会话日志：${logFile}`,
  ].join('\n');
}

/**
 * 组装 `/memory` 展示文本（Phase-9 M3）。
 * memory 为 undefined 表示自动压缩关闭（config.memory.enabled=false）。
 */
export function formatMemoryStatus(
  st: { messages: number; system: number; hasSummary: boolean; logFile: string },
  memory: MemoryCompactionOptions | undefined,
  summarizerLabel: string,
): string {
  const cfgLines = memory
    ? [
        `  自动压缩：开启`,
        `  消息阈值：${memory.thresholdMsgs}（近窗保留 ${memory.keepRecent} 条）`,
        `  token 阈值：${memory.thresholdTokens ?? '未设'}（近窗预算 ${memory.keepRecentTokens ?? '未设'}）`,
        `  摘要器：${summarizerLabel}`,
      ]
    : [`  自动压缩：关闭`];
  return [
    `记忆状态：`,
    `  消息数：${st.messages}（system ${st.system}）`,
    `  含历史摘要：${st.hasSummary ? '是' : '否'}`,
    `  当前会话日志：${st.logFile}`,
    `记忆配置：`,
    ...cfgLines,
  ].join('\n');
}
