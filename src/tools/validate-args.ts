// src/tools/validate-args.ts
// 轻量统一形参校验（Phase-10 T2）——只做「必填字段存在 + 基本类型正确」。
// 取舍（less is more）：不引入完整 schema 校验框架（zod 虽是依赖，但工具入参只需
//   极薄一层「字段在不在 / 类型对不对」即可），不做业务级深校验（路径合法性仍由
//   realpath 沙箱负责）。失败一律返回清晰 ok:false 文案（错误即数据，不抛异常），
//   可直接回喂模型自我纠正。

import type { ToolResult } from '../core/types.js';

/** 支持校验的基本类型（与 JSONSchema 暴露给模型的类型对齐）。 */
export type ArgType = 'string' | 'number' | 'boolean';

/** 单字段校验声明：字段名 + 期望类型 + 是否必填（缺省必填）。 */
export interface FieldSpec {
  name: string;
  type: ArgType;
  /** 默认为 true（必填）。可选字段仅在「存在时」校验类型。 */
  required?: boolean;
}

/**
 * 校验工具入参。返回 ToolResult{ok:false} 表示校验失败（含清晰原因），
 * 返回 null 表示校验通过（调用方继续执行）。
 * - 必填字段缺失 → `<tool> 参数无效：<字段> 缺失`
 * - 字段类型不符 → `<tool> 参数无效：<字段> 类型应为 <type>`
 * 可选字段为 undefined 视为「未提供」直接跳过；提供了则仍按类型校验。
 */
export function validateArgs(
  tool: string,
  args: unknown,
  fields: FieldSpec[],
): Extract<ToolResult, { ok: false }> | null {
  const obj = (args ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    const required = f.required !== false;
    const value = obj[f.name];
    if (value === undefined || value === null) {
      if (required) {
        return { ok: false, error: `${tool} 参数无效：${f.name} 缺失` };
      }
      continue; // 可选且未提供 → 跳过类型校验。
    }
    if (typeof value !== f.type) {
      return { ok: false, error: `${tool} 参数无效：${f.name} 类型应为 ${f.type}` };
    }
  }
  return null;
}
