// tests/task-plan.test.ts
// 覆盖 docs/product-specs/task-plan.md 验收（TP1-TP4，不依赖网络）：
//  TP1 PlanStore.update 正常更新（version 递增、snapshot 含 explanation/items）
//  TP2 多个 in_progress → 拒绝
//  TP3 空/过长列表、空/过长 step、非法 status → 拒绝且不污染旧计划
//  TP4 update_plan 工具：readOnly=true、更新 store、返回格式化结果

import { describe, it, expect } from 'vitest';

import { PlanStore, formatPlanSnapshot } from '../src/plan/index.js';
import { makeUpdatePlanTool } from '../src/tools/update-plan.js';
import type { ToolContext } from '../src/core/types.js';

function ctx(): ToolContext {
  return { rootDir: '/tmp', signal: new AbortController().signal };
}

describe('PlanStore.update —— 正常更新 (TP1)', () => {
  it('version 递增，snapshot 含 explanation/items', () => {
    const store = new PlanStore();
    expect(store.current()).toBeNull();

    const r1 = store.update({
      explanation: '先读后改',
      items: [
        { step: '读取文件', status: 'completed' },
        { step: '修改实现', status: 'in_progress' },
        { step: '跑测试', status: 'pending' },
      ],
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.snapshot.version).toBe(1);
      expect(r1.snapshot.explanation).toBe('先读后改');
      expect(r1.snapshot.items).toHaveLength(3);
    }

    const r2 = store.update({ items: [{ step: '完成', status: 'completed' }] });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.snapshot.version).toBe(2); // 递增

    // current 返回拷贝，外部修改不影响内部
    const snap = store.current()!;
    snap.items.push({ step: 'x', status: 'pending' });
    expect(store.current()!.items).toHaveLength(1);
  });
});

describe('PlanStore.update —— 校验拒绝 (TP2/TP3)', () => {
  it('TP2：多个 in_progress 被拒绝，错误清晰', () => {
    const store = new PlanStore();
    const r = store.update({
      items: [
        { step: 'a', status: 'in_progress' },
        { step: 'b', status: 'in_progress' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/in_progress/);
  });

  it('TP3：各类非法输入被拒绝，且不污染已有计划', () => {
    const store = new PlanStore();
    // 先放一个合法计划
    store.update({ items: [{ step: '初始', status: 'pending' }] });
    const before = store.current();

    const bad: unknown[] = [
      { items: [] }, // 空列表
      { items: Array.from({ length: 21 }, () => ({ step: 's', status: 'pending' })) }, // 过长
      { items: [{ step: '   ', status: 'pending' }] }, // 空 step
      { items: [{ step: 'x'.repeat(201), status: 'pending' }] }, // 过长 step
      { items: [{ step: 'ok', status: 'doing' }] }, // 非法 status
      { items: [{ step: 'ok' }] }, // 缺 status
      { items: 'nope' }, // items 非数组
      null, // 非对象
    ];
    for (const input of bad) {
      const r = store.update(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.error).toBe('string');
    }
    // 旧计划未被污染
    expect(store.current()).toEqual(before);
  });
});

describe('update_plan 工具 (TP4)', () => {
  it('readOnly=true，更新共享 store，返回格式化结果', async () => {
    const store = new PlanStore();
    const tool = makeUpdatePlanTool(store);

    expect(tool.name).toBe('update_plan');
    expect(tool.readOnly).toBe(true);

    const res = await tool.execute(
      { items: [{ step: '写代码', status: 'in_progress' }] },
      ctx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toContain('写代码');
    // 工具确实更新了同一个 store
    expect(store.current()?.items[0].step).toBe('写代码');
  });

  it('非法输入 → ok:false，且不污染 store', async () => {
    const store = new PlanStore();
    store.update({ items: [{ step: '保留', status: 'pending' }] });
    const tool = makeUpdatePlanTool(store);

    const res = await tool.execute({ items: [] }, ctx());
    expect(res.ok).toBe(false);
    expect(store.current()?.items[0].step).toBe('保留'); // 未污染
  });
});

describe('formatPlanSnapshot', () => {
  it('无计划时给出提示', () => {
    expect(formatPlanSnapshot(null)).toContain('没有任务计划');
  });
  it('有计划时列出步骤与状态', () => {
    const store = new PlanStore();
    store.update({ items: [{ step: '步骤一', status: 'completed' }] });
    const text = formatPlanSnapshot(store.current());
    expect(text).toContain('步骤一');
    expect(text).toContain('completed');
  });
});
