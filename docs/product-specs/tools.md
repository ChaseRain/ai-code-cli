# Spec: 工具系统

> 状态：implemented · 最后更新：2026-06-28 · 模块：`src/tools/`（tests/tools.test.ts 覆盖）
> 工具集：**7 个文件/Shell 原子工具 + 1 个 harness 工具 `update_plan`**（Phase-5，见 [`task-plan.md`](task-plan.md)）。

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

## 工具清单（7 文件/Shell + 1 harness）
| 工具 | readOnly | 说明 | 关键约束 |
|---|---|---|---|
| `list_dir` | ✅ | 列目录 | 限项目根内 |
| `read_file` | ✅ | 读文件（带行号、可分段） | 大文件截断并提示 |
| `glob` | ✅ | glob 匹配文件路径 | |
| `grep` | ✅ | 内容正则搜索 | 返回 `file:line:match` |
| `write_file` | ❌ | 整文件写入/新建 | 需权限 |
| `edit_file` | ❌ | 字符串精确替换 | `old_string` 须唯一；需权限 |
| `run_shell` | ❌ | 执行 Shell 命令 | 需权限；超时；捕获 stdout/stderr/exit |
| `update_plan` | ✅ | **harness 工具**：维护任务计划（步骤+状态） | 只更新内存计划、不读写文件/不执行步骤；契约见 [`task-plan.md`](task-plan.md) |

> `update_plan` 由 `createDefaultRegistry(planStore)` 绑定到与 `/plan` 命令共享的 `PlanStore`；
> 它是只读工具（无权限弹窗），不改变原 7 个文件/Shell 工具的权限语义。

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
- `createDefaultRegistry` 含 `update_plan` 且原 7 工具不退化（readOnly 5/敏感 3）；见 task-plan.md TP4/TP6。
- 测试覆盖：含 Phase-6 run_shell 输出截断（LH2）、Phase-7 路径/大小/进程树硬化等；当前整库回归 **213/213**（2026-06-28，详见 [`index.md`](index.md)）。

## 不做（首期）
多文件批量编辑、apply-patch/diff 协议、网络类工具。
