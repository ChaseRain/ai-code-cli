// src/permission/index.ts
// 模块：权限控制（harness 安全边界）。
// 真相来源：docs/product-specs/permissions.md、src/core/types.ts。
//
// 职责：决定一次工具调用是否需要用户确认，并把「拒绝」转成可回喂模型的结果。
// 策略：
//   - readOnly === true 的工具：自动执行，直过，无需确认。
//   - 非只读工具：经一个可注入的 asker 决策（TUI 接管 / 测试 mock）。
// 会话级 allowlist：asker 返回 'always' 后，同名工具后续直过。
// 守护栏：权限确认由 harness 强制，模型无法绕过（core-beliefs B5）。

import type { Tool, ToolResult } from '../core/types.js';

/** 拒绝时回喂模型的统一错误文案（满足「拒绝结果进入会话」）。 */
export const DENIAL_ERROR = 'user denied permission';

/**
 * 权限询问器：对非只读工具发起一次决策。
 * - 'allow'  ：允许执行本次。
 * - 'deny'   ：拒绝，不执行。
 * - 'always' ：本会话始终允许该工具（加入 allowlist），并执行本次。
 *
 * 可被 TUI 接管（弹确认窗），也可被测试 mock。
 */
export type PermissionAsker = (
  tool: Tool,
  args: unknown,
) => Promise<'allow' | 'deny' | 'always'>;

/**
 * 权限控制器。conform docs/product-specs/permissions.md 的 Permission 接口：
 *   check(tool, args): Promise<'allow' | 'deny'>
 * 内部处理 allowlist 与（通过 asker 的）TUI 提问。
 */
export class Permission {
  /** 会话级 allowlist：已被「本会话始终允许」的工具名集合。 */
  private readonly allowlist = new Set<string>();

  constructor(private readonly asker: PermissionAsker) {}

  /**
   * 决策一次工具调用是否放行。
   * - 只读工具：直过（不触发 asker）。
   * - allowlist 内的工具：直过（不再提问）。
   * - 其余非只读工具：交给 asker；'always' 落 allowlist 并放行。
   */
  async check(tool: Tool, args: unknown): Promise<'allow' | 'deny'> {
    if (tool.readOnly) return 'allow';
    if (this.allowlist.has(tool.name)) return 'allow';

    const decision = await this.asker(tool, args);
    if (decision === 'always') {
      this.allowlist.add(tool.name);
      return 'allow';
    }
    return decision;
  }
}

/**
 * 生成一次「权限拒绝」的工具结果（错误即数据）。
 * Loop 在 check 返回 'deny' 时用它构造结果并写入会话上下文。
 */
export function denialResult(): ToolResult {
  return { ok: false, error: DENIAL_ERROR };
}
