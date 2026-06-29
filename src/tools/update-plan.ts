// src/tools/update-plan.ts
// update_plan 工具：让模型显式维护任务计划（步骤 + 状态）。
// 设计要点：
// - readOnly=true：只更新 harness 内存计划，不改任何文件，不触发权限弹窗。
// - 与 `/plan` 命令共享同一个注入的 PlanStore（由 cli 装配）。
// - 校验委托给 PlanStore.update（非法输入返回 ok:false 且不污染旧计划）。

import type { Tool, ToolResult } from '../core/types.js';
import { PlanStore, formatPlanSnapshot, PLAN_STATUSES } from '../plan/index.js';

/** 用注入的 PlanStore 生成 update_plan 工具实例。 */
export function makeUpdatePlanTool(store: PlanStore): Tool {
  return {
    name: 'update_plan',
    description:
      '更新任务计划：维护一组步骤及其状态（pending/in_progress/completed/blocked/canceled），' +
      '用于长任务的进度可观测。只更新会话内的计划状态，不修改任何文件，无需权限。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: '可选：本次计划更新的简要说明' },
        items: {
          type: 'array',
          description: '步骤列表（1-20 项），同一时刻至多一个 in_progress',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: '步骤描述（非空，<=200 字符）' },
              status: {
                type: 'string',
                enum: [...PLAN_STATUSES],
                description: '步骤状态',
              },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['items'],
    },
    async execute(args: unknown): Promise<ToolResult> {
      const res = store.update(args);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, content: formatPlanSnapshot(res.snapshot) };
    },
  };
}
