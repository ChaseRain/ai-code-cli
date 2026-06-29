// src/tools/use-skill.ts
// use_skill 工具（L2 加载）：让模型按需把某技能的 SKILL.md 正文加载进上下文。
// 设计要点（见 docs/product-specs/skills.md「use_skill 工具」与 tools.md）：
// - 仿 makeUpdatePlanTool 的「绑定依赖工厂」模式：用注入的 SkillRegistry 生成工具实例。
// - readOnly=true：只读取**本地已安装**技能文件（与 read_file 同信任级别、同沙箱之下），
//   因此自动执行、不弹权限。技能内若要跑脚本 / 改文件，由模型显式走 run_shell / write_file
//   （仍受既有权限确认约束）——权限边界不被 skills 旁路。
// - 入参 { name } 经 validate-args 统一校验；返回 registry.load 结果（正文或带可用列表的错误）。

import type { Tool, ToolResult } from '../core/types.js';
import { validateArgs } from './validate-args.js';
import type { SkillRegistry } from '../skills/index.js';

/** 用注入的 SkillRegistry 生成 use_skill 工具实例。 */
export function makeUseSkillTool(registry: SkillRegistry): Tool {
  return {
    name: 'use_skill',
    description:
      '按需加载某个技能的完整说明（SKILL.md 正文）。当任务匹配 system prompt 中列出的某个技能时，' +
      '先用本工具加载它的完整指令再执行。只读取本地已安装的技能文件，不执行技能内的脚本，无需权限。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（system prompt「可用技能」一节列出的名字）' },
      },
      required: ['name'],
    },
    async execute(args: unknown): Promise<ToolResult> {
      const bad = validateArgs('use_skill', args, [{ name: 'name', type: 'string' }]);
      if (bad) return bad;
      const { name } = args as { name: string };
      return registry.load(name);
    },
  };
}
