// src/tools/index.ts
// tools 模块对外出口：注册表 + 9 个文件/Shell 原子工具 + 一个预装默认注册表的工厂。

import { ToolRegistry } from './registry.js';
import { listDir } from './list-dir.js';
import { readFile } from './read-file.js';
import { glob } from './glob.js';
import { grep } from './grep.js';
import { writeFile } from './write-file.js';
import { editFile } from './edit-file.js';
import { deleteFile } from './delete-file.js';
import { moveFile } from './move-file.js';
import { runShell } from './run-shell.js';
import { makeUpdatePlanTool } from './update-plan.js';
import { makeUseSkillTool } from './use-skill.js';
import { PlanStore } from '../plan/index.js';
import type { SkillRegistry } from '../skills/index.js';
import type { Tool } from '../core/types.js';

export { ToolRegistry } from './registry.js';
export { PathEscapeError, resolveInRoot } from './path-guard.js';
export { validateArgs } from './validate-args.js';
export { listDir, readFile, glob, grep, writeFile, editFile, deleteFile, moveFile, runShell };
export { makeUpdatePlanTool } from './update-plan.js';
export { makeUseSkillTool } from './use-skill.js';

/** 9 个原子文件/Shell 工具（4 只读 + 5 敏感），注册顺序固定。 */
export const builtinTools: Tool[] = [
  listDir,
  readFile,
  glob,
  grep,
  writeFile,
  editFile,
  deleteFile,
  moveFile,
  runShell,
];

/**
 * 创建预装注册表：9 个内置工具 + `update_plan`（绑定到注入的 PlanStore），
 * 当注入 `skillRegistry` 时再追加 `use_skill`（绑定到该技能注册表）。
 * cli 装配时传入与 `/plan` 命令共享的同一个 PlanStore；省略则内部新建（隔离场景/测试用）。
 * `skillRegistry` 省略时**不注册** use_skill —— 保持工具集在无技能 / 关闭开关时确定。
 * 原文件/Shell 工具的权限语义不退化（update_plan / use_skill 均为 readOnly）。
 */
export function createDefaultRegistry(
  planStore: PlanStore = new PlanStore(),
  skillRegistry?: SkillRegistry,
): ToolRegistry {
  const tools: Tool[] = [...builtinTools, makeUpdatePlanTool(planStore)];
  if (skillRegistry) tools.push(makeUseSkillTool(skillRegistry));
  return new ToolRegistry(tools);
}
