# Spec: TUI + 内置命令

> 状态：implemented · 最后更新：2026-06-28 · 模块：`src/tui/`（Ink）。命令解析 tests/tui-command.test.ts 覆盖；UI 渲染冒烟已补（tests/tui-render.test.ts）

## 职责
在终端提供结构化的输入、输出、状态展示与交互确认。

## 组件
- **消息流**：区分 user / assistant / tool-call / tool-result / permission / error 样式；工具调用以可折叠块展示命令与结果。
- **输入框**：底部，支持 `/` 命令与自然语言任务。
- **状态栏**：模型 / 当前轮次·上限 / 状态机（`idle` · `thinking` · `calling-tool` · `awaiting-permission`）。
- **权限弹窗**：展示工具名、参数摘要，提供「允许一次 / 本会话始终允许 / 拒绝」。

## 流式
assistant 文本随 SSE 增量刷新（消费 `provider` 经 `loop` 转发的 UIEvent）。

## 内置命令（`/` 前缀）
| 命令 | 行为 |
|---|---|
| `/help` | 显示命令与用法 |
| `/clear` | 清空当前会话上下文（开新日志） |
| `/model` | 查看当前模型；`/model <id>` 切换 |
| `/status` | 显示模型、baseURL、轮次上限/当前轮次、Key 是否已配置（不显明文） |
| `/resume` | 从最近一次 jsonl 日志恢复会话上下文（见 memory.md） |
| `/memory` | 查看记忆状态（消息数 / 是否含摘要 / 当前日志） |
| `/exit`（`/quit`） | 退出程序 |

## 验收
- 命令解析单测（含 `/model <id>` 带参、`/resume` `/memory`）。
- **Ink render 冒烟测试**（tests/tui-render.test.ts，ink-testing-library）：渲染**真实生产组件**
  （`MessageList` / `PermissionPrompt` / `StatusBar`）+ **启动态完整 `<App>`**，断言
  ① 启动欢迎/状态栏（完整 App）；② 工具调用/结果行；③ 权限弹窗（“需要授权”+y/a/n）；④ 状态栏状态流。
  帧文本存 `deliverables/tui-frames/`。
- 权限弹窗阻塞执行直到用户选择。
- 真实运行截图入 `deliverables/screenshots/`（见 SCREENSHOTS.md）。

## 不做（首期）
鼠标、多面板布局、主题切换、滚动历史搜索。
