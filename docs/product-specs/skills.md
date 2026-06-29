# Spec: Skills（渐进式加载技能系统）

> 状态：implemented（代码 + 测试已落地） · 最后更新：2026-06-29 · 模块：`src/skills/`（tests/skills.test.ts 覆盖）
> 评审维度：扩展方向 / 加分项（对应 L2 命题第五节）。核心思想：**渐进式披露**——平时只占 1 行/技能，按需才加载正文。

## 职责

把可复用的「工作流 / 领域知识」沉淀为本地 `SKILL.md` 文件，并以**三级渐进式披露**供给给模型：
平时只把技能的「名字 + 描述」放进 system prompt（L1，极省 context），任务匹配时模型才用 `use_skill` 工具加载完整指令（L2），
技能引用的附加资源由模型自行用既有 `read_file` / `run_shell` 读取（L3）。

这与本项目两大基石一致：**Harness 工程**（按需供给上下文）与**渐进式披露**（地图 → 细节，见 AGENTS.md）。

## 三级渐进式披露（核心契约）

| 级别 | 进上下文的内容 | 触发 | 成本 |
|---|---|---|---|
| **L1 目录** | 全部技能的 `name — description`（每技能 1 行）注入 system prompt | 启动即有 | 极低 |
| **L2 加载** | 某技能 `SKILL.md` 正文（剥离 frontmatter） | 模型判断相关 → 调 `use_skill({ name })` 工具 | 按需 |
| **L3 资源** | 技能引用的附加文件 / 脚本 | 模型用既有 `read_file` / `run_shell` 自行读取/执行 | 按需（不自动，保持 less is more） |

> L3 刻意**不自动加载**：技能正文可在 markdown 中引用相对路径资源，由模型显式走既有只读/敏感工具获取，
> 复用既有路径沙箱与权限确认，不为 skills 另开 IO 通道。

## 存储与发现（沿用 config 两级 + 项目优先）

- **用户级**：`~/.config/ai-code-cli/skills/<name>/SKILL.md`
- **项目级**：`<cwd>/.ai-code-cli/skills/<name>/SKILL.md`
- 同名技能**项目级覆盖用户级**（与 `loadConfig` 的「项目级优先」深合并方向一致，见 [`config.md`](config.md)）。
- 一个技能 = 一个目录 + 目录内一个 `SKILL.md`；目录名即技能名的回落值（见 frontmatter）。
- 无 `SKILL.md` 的目录被忽略；坏/超大技能跳过并计入 warnings（**错误即数据，不崩溃**）。

## SKILL.md 格式（极简 frontmatter，不引入 YAML 依赖）

```markdown
---
name: commit-message
description: 根据暂存区改动生成符合规范的提交信息
---

# 生成提交信息

正文是任意 markdown 指令……（被 use_skill 加载为 L2 内容）
```

### frontmatter 解析规则（`parseFrontmatter`，自写最小解析）

> **不引入 YAML 库**——只支持「`---` 围栏内的简单 `key: value` 行」，够用即声明清楚。

- 必须以首行 `---` 开围栏，遇下一行 `---` 收尾；围栏之间逐行解析。
- 每行按**第一个 `:`** 切分为 `key` / `value`，两侧 trim；`key` 为空或行内无 `:` 的行**忽略**（不报错）。
- **只支持单行简单标量**：不支持嵌套、列表、多行值、引号转义、锚点等 YAML 高级特性（明确不做）。
- 同名 key 后者覆盖前者（最后一次为准）。
- **缺围栏**：整文件视作正文，`meta` 为空对象（`name` 走回落）。
- **`name` 缺失 → 回落目录名**；`description` 缺失 → 空串（L1 只显示名字）。
- 返回 `{ meta: Record<string,string>, body: string }`（`body` = 围栏之后的正文；无围栏时为整文）。纯函数、可单测、不抛。

## 接口（草案）

```ts
// src/skills/parse.ts —— 纯函数，可单测
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string };

// src/skills/index.ts
export interface SkillMeta {
  name: string;                 // frontmatter.name ?? 目录名
  description: string;          // frontmatter.description ?? ''
  source: 'user' | 'project';   // 来源层（项目级覆盖用户级）
  path: string;                 // 该技能 SKILL.md 的绝对路径
}

export class SkillRegistry {
  // 构造注入两级目录（由 cli 计算，复用 config 路径约定）；不在构造里做 IO。
  constructor(opts: { userDir: string; projectDir: string });

  discover(): { warnings: string[] };          // 扫描两级目录，只读 frontmatter（L1）；项目级覆盖用户级；容错
  list(): SkillMeta[];                          // 已发现的技能目录（稳定排序）
  load(name: string): ToolResult;              // 读取正文（剥 frontmatter）；校验技能名 + 大小；错误即数据
  buildSkillCatalog(metas?: SkillMeta[]): string; // 格式化 L1 目录文本；无技能返回空串
}
```

- `discover()`：先扫用户级、再扫项目级（项目级同名覆盖）；只读每个 `SKILL.md` 的 frontmatter（**不读正文**，省 IO/内存）；
  解析失败、缺 `SKILL.md`、超大文件 → 跳过并把原因追加进 `warnings`，不影响其他技能。
- `list()`：返回 `discover()` 收集的 `SkillMeta[]`，按 `name` 稳定排序，便于 L1 目录与 `/skills` 输出确定。
- `load(name)`：见下「安全边界」；成功返回 `{ ok:true, content: <正文> }`，未知技能返回 `{ ok:false, error: '未知技能：<name>。可用：a, b, c' }`。
- `buildSkillCatalog()`：无技能 → 返回空串（system prompt 不加该节）；有技能 → 多行 `- <name> — <description>`。

## use_skill 工具（L2 加载）

> 新建 `src/tools/use-skill.ts`：`makeUseSkillTool(registry): Tool`，仿 `makeUpdatePlanTool` 的「绑定依赖工厂」模式
> （见 [`tools.md`](tools.md) 与 `src/tools/update-plan.ts`）。

- **`readOnly: true`（关键决策）**：`use_skill` 只读取**本地已安装**的技能文件（与 `read_file` 同信任级别、同沙箱根之下的受控目录），
  因此**自动执行、不弹权限**。技能里若要跑脚本/改文件，由模型显式走 `run_shell` / `write_file`（仍受既有权限确认约束）——
  权限边界不被 skills 旁路。
- **入参**：`{ name: string }`（必填），经 `src/tools/validate-args.ts` 统一校验（缺/类型错 → `ok:false` 清晰文案，见 tools.md T2）。
- **返回**：`registry.load(name)` 的结果——正文（`ok:true`）或带「可用技能列表」的错误（`ok:false`）。错误即数据，回喂模型自我纠正。
- **注册**：在 `createDefaultRegistry(planStore, skillRegistry?)` 注册（见 tools.md）；`skillRegistry` 省略时**不注册** `use_skill`，
  保持工具集在无技能/关闭开关时确定。

## /skills 命令（用户可见性）

> 命令解析唯一真相在 `src/tui/command.ts`，执行在 `src/tui/command-executor.ts`（见 [`tui.md`](tui.md)）。

- `ParsedInput` 新增判别分支 `{ kind: 'skills'; name?: string }`；`parseInput` 识别 `/skills`（列目录）与 `/skills <name>`（看正文）。
- `command-executor.ts`：`CommandDeps` 注入 `skills: SkillRegistry`，新增 `case 'skills'`：
  - 无名 → 列 `SkillMeta`（名字 + 描述 + 来源）；无技能给友好提示。
  - 有名 → `registry.load(name)`，返回正文或带可用列表的错误。
  - 返回 `messages` + `effect:{ type:'none' }`（纯展示，无副作用）。
- `HELP_TEXT` 增一行 `/skills`（与表格防漂移）。

## config 开关

- `config.skills?.{ enabled?: boolean }`，默认 `enabled=true`；沿用 memory 子对象的合并/校验模式（项目级覆盖用户级，见 [`config.md`](config.md)）。
- **关闭时**：cli 不 `discover`、不注入 L1 目录、不注册 `use_skill` 工具（工具集回到无 skills 形态）；`/skills` 给出「已禁用」提示。

## 安全边界

- 技能**仅**从两级 skills 目录加载，别处不认。
- **技能名校验（防穿越）**：`load(name)` 要求技能名为**单段标识**——拒绝含 `/`、`\`、`..`、绝对路径前缀的名字（返回 `ok:false`，不触磁盘）；
  仅允许在已发现的技能集合内命中，避免用技能名拼出任意路径。
- **大小上限**：技能正文读取受 `MAX_TOOL_FILE_BYTES`（`src/tools/limits.ts`，5 MiB）约束；超限跳过/拒绝并提示（与 read_file 一致）。
- **技能正文按数据处理**：项目级 `SKILL.md` 可能来自他人、含提示注入，信任级别等同 AGENTS.md——spec 明示「**按数据处理**」，
  不赋予技能正文超出普通工具结果的特权；技能不能自动执行脚本（L3 须模型显式走受控工具）。
- `use_skill` 只读自动执行**仅限读取本地已安装技能文件**；不发起网络、不执行技能内脚本。

## 验收（测试，tests/skills.test.ts + 既有文件补充）

- **`parseFrontmatter`**：正常 / 缺围栏（整文为正文、meta 空）/ 缺 `name`（调用方回落目录名）/ 多余字段保留 / 行内无 `:` 忽略 / 同名后覆盖。
- **`SkillRegistry`**：发现用户+项目；同名项目级覆盖用户级；容错坏技能（解析失败计 warnings 不崩）；忽略无 `SKILL.md` 的目录；
  `load` 正常 / 未知名（带可用列表）/ 超大（拒绝）/ 穿越名（`../`、`a/b`、绝对路径）拒绝且不触磁盘。
- **`use_skill` 工具**：存在技能 → `ok:true` 返回正文；缺失 → `ok:false` 带可用列表；缺 `name` / 类型错 → 形参校验失败（不抛）。
- **`buildSystemPrompt`**：有技能含「可用技能」目录节 + 使用指令；无技能省略该节；保留 `SYSTEM_PROMPT` 常量向后兼容。
- **命令**：`/skills`、`/skills <name>` 解析正确；`HELP_TEXT` 含 `/skills`（防漂移）；executor 列表态 / 看正文态 / 缺失态。
- **config**：`skills.enabled` 缺省默认 true；项目级覆盖用户级；关闭时不注入目录/不注册工具。
- **工具计数同步**：注册默认集含 `use_skill`（当注入 skillRegistry 时）；既有工具计数断言据此同步更新。

## 不做（首期）

远程技能市场 / 安装；技能脚本自动执行；技能版本管理；frontmatter 高级语法（嵌套/列表/多行/引号转义，YAML 库）；
L3 资源自动加载；技能依赖/继承。

## 相关
- 工具契约（use_skill 注册、形参校验、文件大小上限）→ [`tools.md`](tools.md)
- system prompt 注入点与命令 → [`tui.md`](tui.md)
- 配置开关 → [`config.md`](config.md)
- 系统设计落地（`src/skills/` 边界 + 依赖规则）→ [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)
- 限界上下文（支撑域 Skills）→ [`../design-docs/domain-model.md`](../design-docs/domain-model.md)
- 本特性执行计划 → [`../exec-plans/active/phase-11.md`](../exec-plans/active/phase-11.md)
