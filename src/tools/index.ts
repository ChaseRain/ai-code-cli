// src/tools/index.ts
// tools 模块对外出口：注册表 + 7 个原子工具 + 一个预装默认注册表的工厂。

import { ToolRegistry } from './registry.js';
import { listDir } from './list-dir.js';
import { readFile } from './read-file.js';
import { glob } from './glob.js';
import { grep } from './grep.js';
import { writeFile } from './write-file.js';
import { editFile } from './edit-file.js';
import { runShell } from './run-shell.js';
import { makeUpdatePlanTool } from './update-plan.js';
import { PlanStore } from '../plan/index.js';
import type { Tool } from '../core/types.js';

export { ToolRegistry } from './registry.js';
export { PathEscapeError, resolveInRoot } from './path-guard.js';
export { listDir, readFile, glob, grep, writeFile, editFile, runShell };
export { makeUpdatePlanTool } from './update-plan.js';

/** 首期 7 个原子文件/Shell 工具（4 只读 + 3 敏感），注册顺序固定。 */
export const builtinTools: Tool[] = [
  listDir,
  readFile,
  glob,
  grep,
  writeFile,
  editFile,
  runShell,
];

/**
 * 创建预装注册表：7 个内置工具 + `update_plan`（绑定到注入的 PlanStore）。
 * cli 装配时传入与 `/plan` 命令共享的同一个 PlanStore；省略则内部新建（隔离场景/测试用）。
 * 原 7 个文件/Shell 工具的权限语义不退化（update_plan 为 readOnly）。
 */
export function createDefaultRegistry(planStore: PlanStore = new PlanStore()): ToolRegistry {
  return new ToolRegistry([...builtinTools, makeUpdatePlanTool(planStore)]);
}
