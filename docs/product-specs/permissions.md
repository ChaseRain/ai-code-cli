# Spec: 权限控制

> 状态：draft · 最后更新：2026-06-27 · 模块：`src/permission/`
> 安全相关：这是本项目的安全边界，由 harness 强制，模型无法绕过。

## 职责
决定一次工具调用是否需要用户确认，并把「拒绝」转成可回喂模型的结果。

## 策略
- `readOnly === true` 的工具：**自动执行**，无需确认。
- 非只读工具（`write_file` / `edit_file` / `run_shell`）：触发 TUI 确认弹窗。

## 确认选项
| 选项 | 行为 |
|---|---|
| 允许一次 | 执行本次 |
| 本会话始终允许该工具 | 加入会话级 allowlist，后续同名工具直过 |
| 拒绝 | 不执行 |

## 拒绝处理（强制）
拒绝 → 不执行 → 生成 `ToolResult{ ok:false, error:'user denied permission' }` → **进入会话上下文**（满足「拒绝结果进入会话」），让模型据此调整后续动作。

## 接口（草案）
```ts
interface Permission {
  check(tool: Tool, args: unknown): Promise<'allow' | 'deny'>;  // 内部处理 allowlist 与 TUI 提问
}
```

## 验收（测试）
- 只读工具不触发确认、直接执行。
- 写类工具必经确认。
- 拒绝时：工具未被执行 + 上下文里出现 denial 结果。
- 「本会话始终允许」后，同名工具不再提问。

## 不做（首期）
细粒度命令白/黑名单、按路径授权、持久化授权策略。
