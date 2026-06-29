# Exec Plan: Phase 11 — Skills（渐进式加载技能系统）

> 状态：done（代码 + 测试已落地，npm run build && npm test = 335/335、build exit 0） · 最后更新：2026-06-29
> 承接 Phase-10：`npm run build && npm test` = 291/291、build exit 0、真实 API 冒烟跑通。
> 纪律：**docs-first** → implement → verify。当前分支、不开 worktree、不破坏既有 291 测试；`src/cli.tsx` 仍只做 composition root。
> 设计真相：[`../../product-specs/skills.md`](../../product-specs/skills.md)（三级披露 / frontmatter / 安全边界）。已批准设计见 `/Users/linlixin/.claude/plans/crispy-gliding-nebula.md`。

## 目标（一句话）

新增 **Skills 能力扩展**：把可复用工作流沉淀为本地 `SKILL.md`，以三级渐进式披露供给模型
（L1 目录注入 system prompt / L2 `use_skill` 加载正文 / L3 资源由模型自行 read_file·run_shell），
平时只占 1 行/技能，按需才加载正文。

## 设计要点（评审锚点）

| 决策 | 取舍 |
|---|---|
| 三级披露 | L1 启动注入名+描述；L2 `use_skill` 按需加载正文；L3 资源不自动加载，模型显式走既有工具 |
| 两级目录 + 项目优先 | 用户级 `~/.config/ai-code-cli/skills/`、项目级 `<cwd>/.ai-code-cli/skills/`；同名项目覆盖用户 |
| frontmatter | **不引入 YAML 依赖**，自写最小 `key: value` 解析；`name` 缺失回落目录名；解析失败计 warnings |
| use_skill `readOnly` | 只读本地已安装技能文件 → 自动执行不弹窗；技能内脚本仍须模型显式 `run_shell`（权限不旁路） |
| 安全 | 技能名单段防穿越；正文 ≤ `MAX_TOOL_FILE_BYTES`；技能正文按数据处理 |
| 依赖边界 | `agent/loop` 不认识 skills；技能仅经 system prompt(L1) 与 use_skill 工具(L2) 进入上下文 |

## 里程碑

- [x] **D（docs-first）**：本计划 + 新 spec `skills.md` 评审通过；更新 index.md（登记 + 测试矩阵）、ARCHITECTURE.md（`src/skills/` 行 + 依赖规则）、AGENTS.md（一行指针）、domain-model.md（支撑域 Skills 一句 + 统一语言）、tui.md（/skills）、tools.md（use_skill）、config.md（skills.enabled）。
- [x] **S1 parse + registry**：`src/skills/parse.ts`（`parseFrontmatter` 纯函数）+ `src/skills/index.ts`（`SkillMeta` / `SkillRegistry.discover/list/load/buildSkillCatalog`）；两级目录发现、项目级覆盖、坏技能容错、技能名校验 + 大小上限。
- [x] **S2 use_skill 工具**：`src/tools/use-skill.ts` `makeUseSkillTool(registry)`（`readOnly:true`，`{name}` 经 validate-args 校验，返回 `registry.load` 结果）；`createDefaultRegistry(planStore, skillRegistry?)` 在传入 registry 时注册。
- [x] **S3 buildSystemPrompt 注入（L1）**：`src/core/system-prompt.ts` 新增 `buildSystemPrompt({ skills }): string`（既有正文 + 「# 可用技能（按需用 use_skill 加载）」节，列 `name — description` + 使用指令；无技能省略该节）；保留 `SYSTEM_PROMPT` 常量。
- [x] **S4 /skills 命令**：`command.ts` 加 `{ kind:'skills'; name? }` 解析 + `HELP_TEXT` 一行；`command-executor.ts` 加 `case 'skills'`（列目录 / 看正文 / 缺失提示，`effect:none`）；`CommandDeps` 注入 `skills`。
- [x] **S5 config 开关**：`src/config/index.ts` 加可选 `skills?:{ enabled?:boolean }`（默认 true，沿用 memory 子对象合并/校验）；关闭时不注入目录、不注册 use_skill。
- [x] **S6 cli 装配**：`src/cli.tsx` 在 Session 前构造 `SkillRegistry`（计算 user/project skills 目录）→ `discover()` → 用 catalog 构 system prompt → （enabled 时）注册 use_skill → 注入 App/executor。cli 仍只装配、无业务逻辑。
- [x] **S7 示例技能**：`<cwd>/.ai-code-cli/skills/` 放 2 个示例（`commit-message`、`code-review`），让评审直接看到 L1 目录 + `use_skill` 加载效果。
- [x] **S8 测试**：`tests/skills.test.ts`（parse / registry / use_skill / buildSystemPrompt，27）+ 既有文件补充（command 解析 + HELP_TEXT、command-executor 列表/正文/缺失/禁用/空、config skills.enabled 合并、工具计数同步）。
- [x] **回归**：`npm run build` exit 0；`npm test` 全绿（291 基线 + 新增 44 = **335**）；既有 TUI 渲染冒烟行为不变。

## 验收

1. `npm run build` exit 0；`npm test` 全绿（291 + 新增）。
2. 放示例技能 → `npm run dev` → `/skills` 列出它 → `/skills <name>` 看正文。
3. 真实 API 冒烟：给匹配技能的任务，观察模型自主调 `use_skill` 加载正文后再执行（`.ai_history/logs` 可复盘）。
4. 关 `skills.enabled` → L1 目录不注入、`use_skill` 不在工具集、`/skills` 提示已禁用。

## 不做（本轮）

远程技能市场 / 安装；技能脚本自动执行；技能版本管理；frontmatter 高级语法（YAML 库）；L3 资源自动加载；技能依赖/继承。
（与 [`skills.md`](../../product-specs/skills.md)「不做（首期）」一致。）
