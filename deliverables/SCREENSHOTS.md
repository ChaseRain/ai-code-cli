# 需人工补充的截图清单

> 以下截图需在真实终端 / 浏览器里人工捕获（自动化无法 headless 出图）。
> 建议统一放到 `deliverables/screenshots/` 下，文件名见各项。
> 状态：待人工补充 · 最后更新：2026-06-27

## 1. TUI 启动界面 — `01-tui-startup.png`

```bash
set -a; source .env; set +a
npm run dev
```

捕获：启动后的初始界面（欢迎/状态栏、输入框、当前模型与 baseURL）。
可选：未配置 Key 时的友好提示态（临时 `unset ANTHROPIC_AUTH_TOKEN` 后 `npm run dev`）。

## 2. 任务执行 + 工具调用 — `02-task-with-toolcall.png`

在 TUI 输入一个会触发只读工具的任务，例如：

> 读取并总结 package.json

捕获：消息流里出现 `read_file` 工具调用与结果、assistant 的流式总结、状态栏在
`thinking / calling-tool / idle` 之间切换的过程。
（参考 headless 等价输出：`deliverables/smoke-output.txt`。）

## 3. 权限确认弹窗 — `03-permission-prompt.png`

输入一个会触发**敏感工具**（写 / 编辑 / Shell）的任务，例如：

> 在项目根新建一个 hello.txt，内容为 hi

捕获：`write_file`（或 `run_shell`）执行前弹出的权限确认 UI，含
「允许 / 拒绝 / 本会话始终允许」选项。可补一张「拒绝后模型据拒绝结果调整」的后续态。

## 4. 贪吃蛇运行 — `04-snake-running.png`

```bash
open deliverables/snake/snake.html      # macOS
```

捕获：浏览器中贪吃蛇运行中的画面（蛇身、食物、分数），最好是进行中而非初始态。
可补一张游戏结束 / 重开界面。

---

### 备注

- 截图里若出现终端环境变量，请确认 **不要露出 `ANTHROPIC_AUTH_TOKEN` 明文**。
- TUI 为 Ink 交互式渲染，无法 headless 出图；故 2、3 项以人工截图为准，
  其行为正确性已由 `deliverables/smoke-output.txt`（真实 API）与 `npm test` 覆盖。
