# Spec: 工具系统

> 状态：implemented · 最后更新：2026-06-29 · 模块：`src/tools/`（tests/tools.test.ts 覆盖）
> 工具集：**9 个文件/Shell 原子工具 + 1 个 harness 工具 `update_plan`**（Phase-10 新增 `delete_file`/`move_file`，见下）。

## 职责
以结构化方式向模型暴露原子能力，统一输入/输出/错误；注册表负责把工具 schema 序列化给 Provider。

## 接口（草案）
```ts
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;          // 暴露给模型
  readOnly: boolean;               // true = 自动执行，无需权限
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
type ToolResult = { ok: true; content: string } | { ok: false; error: string };
interface ToolContext { rootDir: string; signal: AbortSignal; }
```

## 工具清单（9 文件/Shell + 1 harness）
| 工具 | readOnly | 说明 | 关键约束 |
|---|---|---|---|
| `list_dir` | ✅ | 列目录 | 限项目根内 |
| `read_file` | ✅ | 读文件（带行号、可分段） | 大文件截断并提示 |
| `glob` | ✅ | glob 匹配文件路径 | |
| `grep` | ✅ | 内容正则搜索 | 返回 `file:line:match` |
| `write_file` | ❌ | 整文件写入/新建 | 需权限 |
| `edit_file` | ❌ | 字符串精确替换 | `old_string` 须唯一；需权限 |
| `delete_file` | ❌ | 删除文件 / 空目录 | 需权限；realpath 守护；不存在/目录非空报错（见下）|
| `move_file` | ❌ | 移动 / 重命名文件或目录 | 需权限；源与目标均 realpath 守护；目标已存在报错（见下）|
| `run_shell` | ❌ | 执行 Shell 命令 | 需权限；超时；捕获 stdout/stderr/exit |
| `update_plan` | ✅ | **harness 工具**：维护任务计划（步骤+状态） | 只更新内存计划、不读写文件/不执行步骤；契约见 [`task-plan.md`](task-plan.md) |

> `update_plan` 由 `createDefaultRegistry(planStore)` 绑定到与 `/plan` 命令共享的 `PlanStore`；
> 它是只读工具（无权限弹窗），不改变原 7 个文件/Shell 工具的权限语义。

## 新增工具契约（Phase-10 T1）

> 此前 `delete_file`/`move_file` 在「不做（首期）」隐含缺位，重构/清理类真实任务需绕道 `run_shell`。
> 本轮**正式补齐**：两者均 `readOnly=false`（走权限确认），复用既有 realpath 沙箱守护与「错误即数据」。

### `delete_file`
- **输入（schema）**：`{ path: string }`（必填）——相对项目根的文件或**空目录**路径。
- **行为**：经 `resolveInRoot` 解析并校验后删除目标；目标是文件直接删，是空目录则删目录。成功返回 `ok:true, content:"已删除 <path>"`。
- **错误返回（ok:false，均为数据不抛）**：
  - 缺 `path` / 非字符串 → 形参校验失败（见下）。
  - 路径越界（`..`/绝对路径/符号链接逃逸）→ `PathEscapeError` 文案。
  - 目标不存在 → `删除失败：<path> 不存在`。
  - 目标是**非空目录** → `删除失败：<path> 为非空目录（仅支持删空目录，请逐项删除或改用 run_shell）`。
- **边界**：不递归删非空目录（防误删整树）；不删项目根本身；越界即拒绝。

### `move_file`
- **输入（schema）**：`{ from: string; to: string }`（均必填）——相对项目根的源/目标路径。
- **行为**：`from`、`to` **分别**经 `resolveInRoot` 校验后 rename；目标父目录不存在则自动创建。成功返回 `ok:true, content:"已移动 <from> → <to>"`。
- **错误返回（ok:false）**：
  - 缺 `from`/`to` 或非字符串 → 形参校验失败。
  - 源或目标越界 → `PathEscapeError` 文案。
  - `from` 不存在 → `移动失败：源 <from> 不存在`。
  - `to` **已存在** → `移动失败：目标 <to> 已存在（不覆盖，请先删除或换名）`（不静默覆盖）。
- **边界**：源与目标**都**做沙箱守护（防把文件移出根 / 从根外移入）；目标已存在不覆盖；可移动文件或目录。

## 形参校验约定（Phase-10 T2）

> 现状偏差：各工具手工 `as XxxArgs` + 局部 `if (!path)`，缺统一的「必填存在 + 基本类型」轻量校验；
> `zod` 已是依赖却未用于工具入参。本约定**统一轻量校验**，不合法即返回清晰 `ok:false`（错误即数据）。

- **校验内容**：仅做「**必填字段存在** + **基本类型正确**」（string/number/boolean）。不做业务级深校验（路径合法性仍由 realpath 守护，越界由各工具沙箱负责）。
- **落点**：可在 **registry 层**（`execute` 前按工具声明统一校验）或**各工具入口**实现，二选一即可；保持各工具自身仍能独立返回 `ok:false`（不依赖 registry 才安全）。
- **失败返回**：`{ ok:false, error: "<tool> 参数无效：<字段> 缺失/类型应为 <type>" }`——清晰指明哪个字段、期望什么。**不抛异常**，与既有「错误即数据」一致，可直接回喂模型自我纠正。
- **轻量优先**：与 less-is-more 一致——只补「无统一校验」这一真实缺口，不引入完整 schema 校验框架开销；既有逐字段 `if` 保留亦可，新约定是把它规整成一致形态。

## 行为约定
- **run_shell 输出内存上限（Phase-6 LH2）**：stdout/stderr **边读边截断**，超过 `MAX_OUTPUT` 后继续消费但丢弃多余内容，结果含「输出过长已截断」——是真实内存上限，不是事后裁剪。见 [`load-hardening.md`](load-hardening.md)。
- **路径守护（Phase-7 P7-A）**：`resolveInRoot` 不仅做 `..` lexical 防护，还以 **realpath 语义**校验（目标或其最近存在祖先的 realpath 必须在 `realpath(root)` 内），**防符号链接逃逸**；`grep`/`glob` 不跟随符号链接，且 `glob` 的 `cwd`/`pattern` 与 `grep` 的 `include` 经 `assertGlobInRoot` 拒绝 `..`/绝对路径、并对命中结果 `resolveInRoot` 后置过滤（P7-E）。越界即 `ok:false`。
- **文件大小上限（Phase-7 P7-B）**：`read_file`/`edit_file` 先 stat，超 `MAX_TOOL_FILE_BYTES`(5 MiB) 直接拒绝；`write_file` content 超上限拒绝。见 [`guardrails-hardening.md`](guardrails-hardening.md)。
- **run_shell 进程树清理（Phase-7 P7-D）**：detached 进程组 + timeout/abort 杀整组，Promise 不悬挂。
- **grep 资源与正则安全（Phase-8）**：`grep` stat-before-read，超 `MAX_TOOL_FILE_BYTES` 跳过并提示跳过数量；`isPotentiallyCatastrophicRegex` 拒绝明显危险的 nested quantifier / 歧义 alternation 正则（`(a+)+$`、`(?:a|aa)+$`、`(?<x>a|aa)+$`、`(?:(?:a|aa))+$`、`(a?|aa)+$`、`([a]|aa)+$` 等，覆盖 捕获/非捕获/命名/一层包装/可选分支/字符类首 token）`ok:false`，安全写法（`(ab?|cd)+$`、`([b]|aa)+$` 等）不误伤。轻量 guard，非 RE2。见 [`guardrails-hardening.md`](guardrails-hardening.md)。
- **错误即数据**：文件不存在、替换不唯一、命令非零退出 → 结构化 `error` 字符串回喂模型，不抛异常。
- 工具之间不互相依赖；不认识 Provider。

## 验收（测试）
- 路径越界被拦截（`../` 逃逸、绝对路径逃逸）。
- `edit_file` 在 `old_string` 非唯一时报错且不写入。
- `run_shell` 非零退出码被收敛为 `ok:false` 且含 stderr。
- 工具结果能被 Loop 正确回传（见 agent-loop.md）。
- `createDefaultRegistry` 含 `update_plan`；文件/Shell 工具扩为 9（readOnly 5：list_dir/read_file/glob/grep/update_plan；敏感 5：write_file/edit_file/delete_file/move_file/run_shell），原工具权限语义不退化；见 task-plan.md TP4/TP6。
- **delete_file / move_file（Phase-10 T1）**：删文件成功；删非空目录报错；删不存在报错；move 目标已存在不覆盖报错；源/目标越界（`..`/绝对/符号链接）均拒绝。
- **形参校验（Phase-10 T2，malformed-args）**：缺必填字段、字段类型错误（如 `path` 传 number）→ `ok:false` 清晰错误且不执行副作用；不抛异常。
- 测试覆盖：含 Phase-6 run_shell 输出截断（LH2）、Phase-7 路径/大小/进程树硬化、Phase-10 delete/move/malformed-args 等；当前整库回归 **291/291**（2026-06-29，详见 [`index.md`](index.md)）。

## 不做（首期）
多文件批量编辑、apply-patch/diff 协议、网络类工具。
> 注：`delete_file`/`move_file` 已于 Phase-10 从隐含缺位**移出并补齐**（见上「新增工具契约」），不再属于「不做」。
