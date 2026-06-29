// src/plan/index.ts
// Task Plan 领域（见 docs/product-specs/task-plan.md）。
// 计划是 **harness 内存状态**：用于长任务的步骤/进度可观测，不写任何项目文件、不自动执行工具。
// 强校验：非法输入返回 ok:false 且**不污染**已有计划，避免模型异常输出导致 TUI 崩溃。

/** 步骤状态。 */
export type PlanStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'canceled';

/** 合法状态集合（校验 + 工具 schema enum 共用单一真相）。 */
export const PLAN_STATUSES: PlanStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'canceled',
];

/** 单个计划项。 */
export interface PlanItem {
  step: string;
  status: PlanStatus;
}

/** 计划快照（值对象）。version 每次成功更新自增。 */
export interface PlanSnapshot {
  version: number;
  explanation?: string;
  items: PlanItem[];
  updatedAt: string;
}

/** 更新结果：错误即数据，失败带清晰文案。 */
export type PlanUpdateResult =
  | { ok: true; snapshot: PlanSnapshot }
  | { ok: false; error: string };

const MAX_ITEMS = 20;
const MIN_ITEMS = 1;
const MAX_STEP_LEN = 200;

/** 状态展示图标（TUI / 工具结果共用）。 */
const STATUS_ICON: Record<PlanStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
  blocked: '⛔',
  canceled: '✗',
};

/**
 * PlanStore：会话内的计划状态持有者。
 * - update：强校验后整体替换计划（version 自增）；校验失败不改变旧计划。
 * - current：返回当前快照的拷贝（外部不可篡改内部状态）。
 * - clear：清空计划。
 */
export class PlanStore {
  private version = 0;
  private snapshot: PlanSnapshot | null = null;

  /** 当前计划快照（拷贝）；无计划返回 null。 */
  current(): PlanSnapshot | null {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  /** 用任意输入更新计划。校验通过则替换并自增 version；否则返回错误且不污染旧计划。 */
  update(input: unknown): PlanUpdateResult {
    const parsed = validate(input);
    if (!parsed.ok) return parsed; // 旧计划保持不变
    this.version += 1;
    this.snapshot = {
      version: this.version,
      explanation: parsed.explanation,
      items: parsed.items,
      updatedAt: new Date().toISOString(),
    };
    return { ok: true, snapshot: cloneSnapshot(this.snapshot) };
  }

  /** 清空计划（version 计数保留，便于复盘更新次数）。 */
  clear(): void {
    this.snapshot = null;
  }
}

/** 把计划快照格式化为可读文本（TUI 展示 / 工具结果共用）。 */
export function formatPlanSnapshot(snapshot: PlanSnapshot | null): string {
  if (!snapshot || snapshot.items.length === 0) return '当前没有任务计划。';
  const lines: string[] = [`任务计划（v${snapshot.version}）：`];
  if (snapshot.explanation) lines.push(snapshot.explanation);
  snapshot.items.forEach((it, i) => {
    lines.push(`  ${STATUS_ICON[it.status]} ${i + 1}. ${it.step}  [${it.status}]`);
  });
  return lines.join('\n');
}

// ── 内部 ─────────────────────────────────────────────────────────────────

type ValidateOk = { ok: true; explanation?: string; items: PlanItem[] };
type ValidateErr = { ok: false; error: string };

function err(error: string): ValidateErr {
  return { ok: false, error };
}

function validate(input: unknown): ValidateOk | ValidateErr {
  if (typeof input !== 'object' || input === null) {
    return err('update_plan 需要一个对象参数 { explanation?, items[] }');
  }
  const obj = input as Record<string, unknown>;

  if (obj.explanation !== undefined && typeof obj.explanation !== 'string') {
    return err('explanation 必须是字符串');
  }
  if (!Array.isArray(obj.items)) {
    return err('items 必须是数组');
  }
  const items = obj.items as unknown[];
  if (items.length < MIN_ITEMS) {
    return err('items 不能为空（至少 1 项）');
  }
  if (items.length > MAX_ITEMS) {
    return err(`items 过多（最多 ${MAX_ITEMS} 项，当前 ${items.length}）`);
  }

  const normalized: PlanItem[] = [];
  let inProgress = 0;
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (typeof raw !== 'object' || raw === null) {
      return err(`第 ${i + 1} 项必须是对象 { step, status }`);
    }
    const { step, status } = raw as Record<string, unknown>;
    if (typeof step !== 'string' || step.trim().length === 0) {
      return err(`第 ${i + 1} 项 step 不能为空`);
    }
    if (step.length > MAX_STEP_LEN) {
      return err(`第 ${i + 1} 项 step 过长（最多 ${MAX_STEP_LEN} 字符，当前 ${step.length}）`);
    }
    if (typeof status !== 'string' || !PLAN_STATUSES.includes(status as PlanStatus)) {
      return err(`第 ${i + 1} 项 status 非法：${String(status)}（须为 ${PLAN_STATUSES.join('/')}）`);
    }
    if (status === 'in_progress') inProgress += 1;
    normalized.push({ step, status: status as PlanStatus });
  }
  if (inProgress > 1) {
    return err(`同一时刻最多一个 in_progress（当前 ${inProgress} 个）`);
  }

  return {
    ok: true,
    explanation: obj.explanation as string | undefined,
    items: normalized,
  };
}

function cloneSnapshot(s: PlanSnapshot): PlanSnapshot {
  return {
    version: s.version,
    explanation: s.explanation,
    items: s.items.map((it) => ({ ...it })),
    updatedAt: s.updatedAt,
  };
}
