// tests/command-executor.test.ts
// 覆盖 tui.md「命令执行单测（Phase-10 Q1）」：注入 fake deps，断言各命令的 CommandOutcome
//   （echoUser / messages / effect），IO 失败收敛为 error 消息（不抛）。纯逻辑，无渲染依赖。

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandExecutor } from '../src/tui/command-executor.js';
import type { CommandDeps } from '../src/tui/command-executor.js';
import { parseInput } from '../src/tui/command.js';
import { PlanStore } from '../src/plan/index.js';
import { SkillRegistry } from '../src/skills/index.js';
import type { SessionSummary } from '../src/session/index.js';

// ── fake session：只实现执行器用到的成员 ────────────────────────────────────
function fakeSession(over: Partial<Record<string, unknown>> = {}) {
  return {
    rootDir: '/proj',
    logFile: '/proj/.ai_history/logs/cur.jsonl',
    memoryStats: () => ({
      messages: 3,
      system: 1,
      hasSummary: false,
      logFile: '/proj/.ai_history/logs/cur.jsonl',
    }),
    logCheckpoint: vi.fn(),
    ...over,
  } as unknown as CommandDeps['session'];
}

// ── fake checkpointStore ────────────────────────────────────────────────────
function fakeCheckpointStore(over: Partial<Record<string, unknown>> = {}) {
  return {
    create: vi.fn(),
    list: vi.fn(),
    count: vi.fn(),
    restore: vi.fn(),
    ...over,
  } as unknown as CommandDeps['checkpointStore'];
}

const STATUS = (): ReturnType<CommandDeps['status']> => ({
  model: 'claude-x',
  baseURL: 'https://api.example',
  maxTurns: 20,
  turn: 2,
  apiKeyConfigured: true,
});

function mkExecutor(deps: Partial<CommandDeps> = {}) {
  return createCommandExecutor({
    session: deps.session ?? fakeSession(),
    checkpointStore: deps.checkpointStore ?? fakeCheckpointStore(),
    planStore: deps.planStore ?? new PlanStore(),
    status: deps.status ?? STATUS,
    summarizerLabel: deps.summarizerLabel ?? 'heuristic',
    memory: deps.memory,
    skills: deps.skills,
    listSessions: deps.listSessions,
    getWorkspaceStatus: deps.getWorkspaceStatus,
    getWorkspaceDiff: deps.getWorkspaceDiff,
    findLatestAutoCheckpoint: deps.findLatestAutoCheckpoint,
  });
}

async function run(exec: ReturnType<typeof mkExecutor>, raw: string) {
  return exec.run(parseInput(raw), raw);
}

describe('CommandExecutor —— 纯展示命令', () => {
  it('/help 回显输入 + 输出帮助', async () => {
    const o = await run(mkExecutor(), '/help');
    expect(o.echoUser).toBe(true);
    expect(o.effect).toEqual({ type: 'none' });
    expect(o.messages[0].text).toMatch(/可用命令/);
  });

  it('/status 输出模型 / baseURL / 轮次 / Key', async () => {
    const o = await run(mkExecutor(), '/status');
    const t = o.messages[0].text;
    expect(t).toMatch(/claude-x/);
    expect(t).toMatch(/https:\/\/api\.example/);
    expect(t).toMatch(/2\/20/);
    expect(t).toMatch(/已配置/);
  });

  it('/model 无参 → 展示当前模型，effect none', async () => {
    const o = await run(mkExecutor(), '/model');
    expect(o.messages[0].text).toMatch(/当前模型：claude-x/);
    expect(o.effect).toEqual({ type: 'none' });
  });

  it('/model <id> → set-model 副作用', async () => {
    const o = await run(mkExecutor(), '/model claude-new');
    expect(o.effect).toEqual({ type: 'set-model', id: 'claude-new' });
    expect(o.messages[0].text).toMatch(/已切换模型：claude-new/);
  });

  it('/clear → clear-session 副作用、不回显、无消息', async () => {
    const o = await run(mkExecutor(), '/clear');
    expect(o.echoUser).toBe(false);
    expect(o.messages).toEqual([]);
    expect(o.effect).toEqual({ type: 'clear-session' });
  });

  it('/exit → exit 副作用', async () => {
    const o = await run(mkExecutor(), '/exit');
    expect(o.effect).toEqual({ type: 'exit' });
  });

  it('未知命令 → 友好提示，effect none', async () => {
    const o = await run(mkExecutor(), '/wat');
    expect(o.messages[0].text).toMatch(/未知命令 \/wat/);
    expect(o.effect).toEqual({ type: 'none' });
  });

  it('自然语言任务 → run-task 副作用、不回显', async () => {
    const o = await run(mkExecutor(), '帮我重构 foo.ts');
    expect(o.echoUser).toBe(false);
    expect(o.effect).toEqual({ type: 'run-task', text: '帮我重构 foo.ts' });
  });
});

describe('CommandExecutor —— /memory', () => {
  it('未注入 memory → 展示自动压缩关闭', async () => {
    const o = await run(mkExecutor(), '/memory');
    const t = o.messages[0].text;
    expect(t).toMatch(/记忆状态/);
    expect(t).toMatch(/自动压缩：关闭/);
  });

  it('注入 memory → 展示阈值与摘要器', async () => {
    const o = await run(
      mkExecutor({
        memory: { thresholdMsgs: 40, keepRecent: 6 } as unknown as CommandDeps['memory'],
        summarizerLabel: 'llm',
      }),
      '/memory',
    );
    const t = o.messages[0].text;
    expect(t).toMatch(/自动压缩：开启/);
    expect(t).toMatch(/消息阈值：40/);
    expect(t).toMatch(/摘要器：llm/);
  });
});

describe('CommandExecutor —— /resume（无参打开选择器；带参直接恢复）', () => {
  it('/resume 无参 → 打开会话选择器（与 /sessions 同）', async () => {
    const items: SessionSummary[] = [mkSummary('a', false), mkSummary('b', true)];
    const o = await run(mkExecutor({ listSessions: () => items }), '/resume');
    expect(o.effect).toEqual({ type: 'open-session-picker', items, index: 1 });
  });

  it('/resume 无参且无历史 → 提示，effect none', async () => {
    const o = await run(mkExecutor({ listSessions: () => [] as SessionSummary[] }), '/resume');
    expect(o.messages[0].text).toMatch(/暂无历史会话/);
    expect(o.effect).toEqual({ type: 'none' });
  });

  it('/resume <path> 带参 → resume 副作用（解析出目标）', async () => {
    const o = await run(mkExecutor(), '/resume some-session.jsonl');
    expect(o.effect.type).toBe('resume');
    if (o.effect.type === 'resume') expect(o.effect.target).toMatch(/some-session\.jsonl/);
  });
});

describe('CommandExecutor —— /sessions', () => {
  it('空列表 → 提示，effect none', async () => {
    const o = await run(mkExecutor({ listSessions: () => [] as SessionSummary[] }), '/sessions');
    expect(o.messages[0].text).toMatch(/暂无历史会话/);
    expect(o.effect).toEqual({ type: 'none' });
  });

  it('有数据 → open-session-picker，高亮 current 项', async () => {
    const items: SessionSummary[] = [
      mkSummary('a', false),
      mkSummary('b', true),
      mkSummary('c', false),
    ];
    const o = await run(mkExecutor({ listSessions: () => items }), '/sessions');
    expect(o.effect).toEqual({ type: 'open-session-picker', items, index: 1 });
  });

  it('listSessions 抛错 → error 消息（不抛）', async () => {
    const o = await run(
      mkExecutor({
        listSessions: () => {
          throw new Error('boom');
        },
      }),
      '/sessions',
    );
    expect(o.messages[0].kind).toBe('error');
    expect(o.messages[0].text).toMatch(/boom/);
  });
});

describe('CommandExecutor —— checkpoint 家族', () => {
  it('/checkpoint 创建成功 → 成功消息 + 记日志', async () => {
    const logCheckpoint = vi.fn();
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'cp1', trigger: 'manual', label: 'x', files: [1, 2], excluded: [] });
    const o = await run(
      mkExecutor({
        session: fakeSession({ logCheckpoint }),
        checkpointStore: fakeCheckpointStore({ create }),
      }),
      '/checkpoint x',
    );
    expect(create).toHaveBeenCalled();
    expect(logCheckpoint).toHaveBeenCalled();
    expect(o.messages[0].text).toMatch(/已创建 checkpoint cp1（2 个文件/);
  });

  it('/checkpoint 创建失败 → error 消息（不抛）', async () => {
    const create = vi.fn().mockRejectedValue(new Error('disk full'));
    const o = await run(mkExecutor({ checkpointStore: fakeCheckpointStore({ create }) }), '/checkpoint');
    expect(o.messages[0].kind).toBe('error');
    expect(o.messages[0].text).toMatch(/disk full/);
  });

  it('/checkpoints 空 → 提示', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const o = await run(mkExecutor({ checkpointStore: fakeCheckpointStore({ list }) }), '/checkpoints');
    expect(o.messages[0].text).toMatch(/暂无 checkpoint/);
  });

  it('/checkpoints 有数据 → 列出，超量给出截断提示', async () => {
    const list = vi
      .fn()
      .mockResolvedValue([
        { id: 'cp1', trigger: 'manual', label: 'l', files: [1], createdAt: 't1' },
      ]);
    const count = vi.fn().mockResolvedValue(3);
    const o = await run(
      mkExecutor({ checkpointStore: fakeCheckpointStore({ list, count }) }),
      '/checkpoints',
    );
    expect(o.messages[0].text).toMatch(/cp1 · manual/);
    expect(o.messages[0].text).toMatch(/共 3 个，仅展示最近 1 个/);
  });

  it('/restore 缺 id → error，effect none', async () => {
    const o = await run(mkExecutor(), '/restore');
    expect(o.messages[0].kind).toBe('error');
    expect(o.messages[0].text).toMatch(/缺少 checkpoint id/);
    expect(o.effect).toEqual({ type: 'none' });
  });

  it('/restore <id> → confirm-restore 副作用 + 确认提示', async () => {
    const o = await run(mkExecutor(), '/restore cp9');
    expect(o.effect).toEqual({ type: 'confirm-restore', id: 'cp9' });
    expect(o.messages[0].text).toMatch(/确认恢复 checkpoint cp9/);
  });

  it('/undo-last 无自动 checkpoint → 提示，effect none', async () => {
    const o = await run(
      mkExecutor({ findLatestAutoCheckpoint: async () => null }),
      '/undo-last',
    );
    expect(o.messages[0].text).toMatch(/暂无可恢复的自动 checkpoint/);
    expect(o.effect).toEqual({ type: 'none' });
  });

  it('/undo-last 有自动 checkpoint → confirm-restore', async () => {
    const o = await run(
      mkExecutor({
        findLatestAutoCheckpoint: async () =>
          ({ id: 'auto1' }) as unknown as Awaited<
            ReturnType<NonNullable<CommandDeps['findLatestAutoCheckpoint']>>
          >,
      }),
      '/undo-last',
    );
    expect(o.effect).toEqual({ type: 'confirm-restore', id: 'auto1' });
    expect(o.messages[0].text).toMatch(/确认恢复最近自动 checkpoint auto1/);
  });

  it('/rewind 无参 空列表 → 提示，effect none', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const o = await run(mkExecutor({ checkpointStore: fakeCheckpointStore({ list }) }), '/rewind');
    expect(o.messages[0].text).toMatch(/暂无可回滚的 checkpoint/);
    expect(o.effect).toEqual({ type: 'none' });
  });

  it('/rewind 无参 有数据 → open-checkpoint-picker（index 0）', async () => {
    const items = [
      { id: 'cp2', trigger: 'manual', label: 'b', files: [1], createdAt: 't2' },
      { id: 'cp1', trigger: 'auto', label: undefined, files: [1, 2], createdAt: 't1' },
    ];
    const list = vi.fn().mockResolvedValue(items);
    const o = await run(mkExecutor({ checkpointStore: fakeCheckpointStore({ list }) }), '/rewind');
    expect(o.effect).toEqual({ type: 'open-checkpoint-picker', items, index: 0 });
    expect(o.messages).toEqual([]);
  });

  it('/rewind <id> → confirm-restore（等价 /restore <id>）', async () => {
    const o = await run(mkExecutor(), '/rewind cp9');
    expect(o.effect).toEqual({ type: 'confirm-restore', id: 'cp9' });
    expect(o.messages[0].text).toMatch(/确认回滚到 checkpoint cp9/);
  });

  it('/rewind 列举失败 → error（不抛）', async () => {
    const list = vi.fn().mockRejectedValue(new Error('io boom'));
    const o = await run(mkExecutor({ checkpointStore: fakeCheckpointStore({ list }) }), '/rewind');
    expect(o.messages[0].kind).toBe('error');
    expect(o.messages[0].text).toMatch(/io boom/);
  });
});

describe('CommandExecutor —— /changes /diff', () => {
  it('/changes 调 getWorkspaceStatus 并格式化', async () => {
    const getWorkspaceStatus = vi.fn().mockResolvedValue({
      isGitRepo: false,
      branch: undefined,
      changedFiles: [],
      untrackedFiles: [],
      filesTruncated: false,
      checkpointCount: 0,
      latestCheckpoint: undefined,
      raw: '',
    } as unknown as Awaited<ReturnType<NonNullable<CommandDeps['getWorkspaceStatus']>>>);
    const o = await run(mkExecutor({ getWorkspaceStatus }), '/changes');
    expect(getWorkspaceStatus).toHaveBeenCalled();
    expect(o.messages[0].kind).toBe('system');
    expect(o.messages[0].text).toMatch(/工作区/);
  });

  it('/changes 抛错 → error 消息', async () => {
    const getWorkspaceStatus = vi.fn().mockRejectedValue(new Error('git fail'));
    const o = await run(mkExecutor({ getWorkspaceStatus }), '/changes');
    expect(o.messages[0].kind).toBe('error');
    expect(o.messages[0].text).toMatch(/git fail/);
  });

  it('/diff [path] 把 path 透传给 getWorkspaceDiff', async () => {
    const getWorkspaceDiff = vi.fn().mockResolvedValue({
      path: 'src/a.ts',
      source: 'git',
      additions: 0,
      deletions: 0,
      truncated: false,
      content: '',
    } as unknown as Awaited<ReturnType<NonNullable<CommandDeps['getWorkspaceDiff']>>>);
    await run(mkExecutor({ getWorkspaceDiff }), '/diff src/a.ts');
    expect(getWorkspaceDiff).toHaveBeenCalledWith('/proj', 'src/a.ts');
  });
});

describe('CommandExecutor —— /plan', () => {
  it('/plan 空计划 → 提示无计划', async () => {
    const o = await run(mkExecutor(), '/plan');
    expect(o.messages[0].text).toMatch(/当前没有任务计划/);
  });

  it('/plan 有计划 → 展示快照', async () => {
    const planStore = new PlanStore();
    planStore.update({ items: [{ step: '写代码', status: 'in_progress' }] });
    const o = await run(mkExecutor({ planStore }), '/plan');
    expect(o.messages[0].text).toMatch(/任务计划/);
    expect(o.messages[0].text).toMatch(/写代码/);
  });

  it('/plan clear → 清空并提示', async () => {
    const planStore = new PlanStore();
    planStore.update({ items: [{ step: 'x', status: 'pending' }] });
    const o = await run(mkExecutor({ planStore }), '/plan clear');
    expect(o.messages[0].text).toMatch(/已清空当前任务计划/);
    expect(planStore.current()).toBeNull();
  });
});

// ── /skills（Phase-11）────────────────────────────────────────────────────────
describe('CommandExecutor —— /skills', () => {
  let root: string;
  let reg: SkillRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cmd-skills-'));
    const userDir = join(root, 'skills');
    const dir = join(userDir, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n演示正文', 'utf8');
    reg = new SkillRegistry({ userDir, projectDir: join(root, 'none') });
    reg.discover();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('未注入 registry → 提示已禁用', async () => {
    const o = await run(mkExecutor(), '/skills');
    expect(o.effect).toEqual({ type: 'none' });
    expect(o.messages[0].text).toMatch(/已禁用/);
  });

  it('/skills 列目录（含 name/description/source）', async () => {
    const o = await run(mkExecutor({ skills: reg }), '/skills');
    expect(o.effect).toEqual({ type: 'none' });
    expect(o.messages[0].kind).toBe('system');
    expect(o.messages[0].text).toMatch(/可用技能/);
    expect(o.messages[0].text).toMatch(/demo/);
    expect(o.messages[0].text).toMatch(/演示技能/);
    expect(o.messages[0].text).toMatch(/user/);
  });

  it('/skills <name> → 看正文', async () => {
    const o = await run(mkExecutor({ skills: reg }), '/skills demo');
    expect(o.messages[0].kind).toBe('system');
    expect(o.messages[0].text).toBe('演示正文');
  });

  it('/skills <missing> → error 带可用列表', async () => {
    const o = await run(mkExecutor({ skills: reg }), '/skills nope');
    expect(o.messages[0].kind).toBe('error');
    expect(o.messages[0].text).toMatch(/未知技能/);
  });

  it('启用但无技能 → 友好提示', async () => {
    const empty = new SkillRegistry({
      userDir: join(root, 'empty-u'),
      projectDir: join(root, 'empty-p'),
    });
    empty.discover();
    const o = await run(mkExecutor({ skills: empty }), '/skills');
    expect(o.messages[0].text).toMatch(/暂无可用技能/);
  });
});

// ── helper ──────────────────────────────────────────────────────────────────
function mkSummary(id: string, current: boolean): SessionSummary {
  return {
    id,
    logPath: `/proj/.ai_history/logs/${id}.jsonl`,
    startedAt: 't0',
    updatedAt: 't1',
    title: id,
    messages: 1,
    toolCalls: 0,
    current,
    warnings: 0,
  };
}
