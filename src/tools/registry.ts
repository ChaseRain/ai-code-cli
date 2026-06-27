// src/tools/registry.ts
// ToolRegistry：登记工具、按名取用、把工具集派生为 ToolSchema[] 序列化给 Provider。
// 注册表不认识 Provider；Loop 用 toSchemas() 取 schema，用 get()/execute() 跑工具。

import type { Tool, ToolSchema, ToolContext, ToolResult } from '../core/types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  /** 登记一个工具；重名报错（避免覆盖造成的隐性歧义）。 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重名：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 按名取工具，不存在返回 undefined。 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 是否存在某工具。 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 全部工具（注册顺序）。 */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 派生序列化给 Provider 的 schema 列表（Anthropic: name/description/input_schema）。 */
  toSchemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * 按名执行工具。工具不存在归一为 ToolResult{ok:false}（错误即数据，不抛异常）。
   * 工具自身抛出的异常也兜底收敛为 ok:false。
   */
  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `未知工具：${name}` };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      return { ok: false, error: `工具执行异常：${(err as Error).message}` };
    }
  }
}
