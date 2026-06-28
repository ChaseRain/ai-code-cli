# 运行截图

> ✅ **已补齐 4/4。** 真实 PNG 图片位于 `deliverables/screenshots/`。
> 状态：**已补齐（4/4）** · 最后更新：2026-06-28

## 截图来源（可复现）

- **TUI 截图（01–03）**：由 [`deliverables/screenshots.ts`](screenshots.ts) 生成——用 `ink-testing-library`
  渲染 App 真正使用的同一批组件（`MessageList` / `PermissionPrompt` / `StatusBar` / 完整 `<App>`）得到终端帧，
  帧文本存 [`deliverables/tui-frames/`](tui-frames/)（smoke 证据），再经 `ansi-to-html` → headless Chrome `--screenshot` 出 PNG。
- **贪吃蛇截图（04）**：headless Chrome 直接截图 [`snake/snake.html`](snake/snake.html)（Agent 产物）。
- 复现：`npx tsx deliverables/screenshots.ts`（或单张 `... 03` / `... 04`）。

## 四张截图

### 01 TUI 启动界面 — [`screenshots/01-tui-startup.png`](screenshots/01-tui-startup.png)
欢迎语 + 输入框 + 状态栏（模型 `deepseek/deepseek-v4-pro` · 轮次 0/25 · 状态 空闲 · Key 已配置）。
对应 smoke 帧：[`tui-frames/01-tui-startup.txt`](tui-frames/01-tui-startup.txt)。

### 02 任务执行 + 工具调用 — [`screenshots/02-task-with-toolcall.png`](screenshots/02-task-with-toolcall.png)
消息流：用户任务「读取并总结 package.json」→ `⚙ 调用 read_file` → `✓ read_file` 结果 → assistant 总结。
对应 smoke 帧：[`tui-frames/02-task-with-toolcall.txt`](tui-frames/02-task-with-toolcall.txt)。
（真实 API 等价输出另见 [`smoke-output.txt`](smoke-output.txt)。）

### 03 权限确认弹窗 — [`screenshots/03-permission-prompt.png`](screenshots/03-permission-prompt.png)
敏感工具 `write_file` 执行前的授权弹窗：`需要授权` + `[y] 允许一次 / [a] 本会话始终允许 / [n] 拒绝`。
对应 smoke 帧：[`tui-frames/03-permission-prompt.txt`](tui-frames/03-permission-prompt.txt)。

### 04 贪吃蛇运行 — [`screenshots/04-snake-running.png`](screenshots/04-snake-running.png)
浏览器中运行 Agent 产物 `snake/snake.html`：画布 + 蛇身 + 食物 + 得分/最高分 + 方向键提示。

---

### 备注
- 截图均未包含任何密钥明文。
- TUI 行为正确性另由 `npm test`（tests/tui-render.test.ts 等）与 `smoke-output.txt`（真实 API）覆盖。
