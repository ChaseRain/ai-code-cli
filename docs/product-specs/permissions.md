# Spec: 权限控制

> 状态：implemented（Phase-9 补：会话级 allowlist 生命周期 + `reset()`） · 最后更新：2026-06-29 · 模块：`src/permission/`（tests/permission.test.ts 覆盖）
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

## 权限日志语义（R1，避免混淆）
工具放行有两种来源，日志须区分，不可都记成普通 `allow`：

| 来源 | 是否经用户确认 | 日志 `effect` |
|---|---|---|
| 只读工具自动放行 | 否（只读无需确认） | **`auto_allow`** |
| 敏感工具用户允许（一次 / 本会话始终） | 是 | `allow` |
| 敏感工具用户拒绝 | 是 | `deny`（且 denial 入上下文） |

> 即：`permission allow` 仅代表「敏感操作经用户授权」；只读工具的自动执行记为 `auto_allow`，
> 避免评审把「只读无需确认」误读成「逐次请求并允许」。落在 `loop`（决策点），写入 `session` jsonl。

## 会话级 allowlist 生命周期（Phase-9 P3）
「本会话始终允许」写入的是**会话级** allowlist，其语义边界必须与「会话」对齐：

- **「会话级」定义**：一个会话 = **从进程启动（或上一次 `/clear`）到下一次 `/clear`** 之间的区间。`/clear` 开启一个全新会话。
- **`/clear` 必须重置 allowlist**：`/clear` 开启新会话时，allowlist 必须被清空——新增 `Permission.reset()`，由 `/clear` 处理链在 `session.clear()` 时一并调用。否则上一会话「本会话始终允许」的工具会在新会话继续直过，违背「会话级」承诺（旧实现里 `Permission` 是 App 生命周期内的稳定实例，`session.clear()` 不重置其内部 allowlist，即此缺口）。
- **不变量**：`/clear` 之后，任一原先被「本会话始终允许」放行的敏感工具，**再次调用须重新触发确认弹窗**。
- `reset()` 只清会话级 allowlist 内部状态，不影响「只读工具自动放行」「拒绝结果入上下文」等其他策略。

## 接口（草案）
```ts
interface Permission {
  check(tool: Tool, args: unknown): Promise<'allow' | 'deny'>;  // 内部处理 allowlist 与 TUI 提问
  reset(): void;                                                 // 清空会话级 allowlist；由 /clear 开启新会话时调用
}
```

## 验收（测试）
- 只读工具不触发确认、直接执行。
- 写类工具必经确认。
- 拒绝时：工具未被执行 + 上下文里出现 denial 结果。
- 「本会话始终允许」后，同名工具不再提问。
- **（Phase-9 P3）** 「本会话始终允许」后调用 `reset()`（或走 `/clear` 链路），同名工具**重新触发确认**。

## 不做（首期）
细粒度命令白/黑名单、按路径授权、持久化授权策略。
