# Spec: 工具系统

> 状态：implemented · 最后更新：2026-06-27 · 模块：`src/tools/`（tests/tools.test.ts 覆盖）

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

## 首期 7 个原子工具
| 工具 | readOnly | 说明 | 关键约束 |
|---|---|---|---|
| `list_dir` | ✅ | 列目录 | 限项目根内 |
| `read_file` | ✅ | 读文件（带行号、可分段） | 大文件截断并提示 |
| `glob` | ✅ | glob 匹配文件路径 | |
| `grep` | ✅ | 内容正则搜索 | 返回 `file:line:match` |
| `write_file` | ❌ | 整文件写入/新建 | 需权限 |
| `edit_file` | ❌ | 字符串精确替换 | `old_string` 须唯一；需权限 |
| `run_shell` | ❌ | 执行 Shell 命令 | 需权限；超时；捕获 stdout/stderr/exit |

## 行为约定
- **路径守护**：所有路径解析后必须落在 `rootDir` 内，越界即 `ok:false`。
- **错误即数据**：文件不存在、替换不唯一、命令非零退出 → 结构化 `error` 字符串回喂模型，不抛异常。
- 工具之间不互相依赖；不认识 Provider。

## 验收（测试）
- 路径越界被拦截（`../` 逃逸、绝对路径逃逸）。
- `edit_file` 在 `old_string` 非唯一时报错且不写入。
- `run_shell` 非零退出码被收敛为 `ok:false` 且含 stderr。
- 工具结果能被 Loop 正确回传（见 agent-loop.md）。

## 不做（首期）
多文件批量编辑、apply-patch/diff 协议、网络类工具。
