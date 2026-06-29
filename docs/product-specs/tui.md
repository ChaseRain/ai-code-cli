# Spec: TUI + 内置命令

> 状态：implemented · 最后更新：2026-06-29 · 模块：`src/tui/`（Ink）。命令解析 tests/tui-command.test.ts 覆盖；UI 渲染冒烟已补（tests/tui-render.test.ts）；命令执行 tests/command-executor.test.ts 覆盖（Phase-10 Q1）

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

> 命令清单唯一真相来源：`src/tui/command.ts` 的 `HELP_TEXT`；本表须与其同步。

| 命令 | 行为 |
|---|---|
| `/help` | 显示命令与用法 |
| `/clear` | 清空当前会话上下文（开新日志） |
| `/model` / `/model <id>` | 查看 / 切换当前模型 |
| `/status` | 显示模型、baseURL、轮次上限/当前轮次、Key 是否已配置（不显明文） |
| `/resume` | 打开会话选择器恢复（无参，主流约定）；`/resume <path>` 直接恢复指定 jsonl 日志（见 memory.md） |
| `/sessions` | 打开会话选择器（`/resume` 无参的别名，最近 50，见 session-browser.md） |
| `/memory` | 查看记忆状态（消息数 / 是否含摘要 / 当前日志） |
| `/rewind` | 打开快照选择器回滚（无参，主流约定）；`/rewind <id>` 直接进入指定 checkpoint 的回滚确认（见 checkpoint.md） |
| `/checkpoint [label]` | 创建本地可恢复快照（见 checkpoint.md） |
| `/checkpoints` | 列出本地 checkpoint（最近 50） |
| `/restore <id>` | 确认后恢复指定 checkpoint（等价 `/rewind <id>`） |
| `/changes` | 查看 Git / 工作区变更概览（见 diff-git.md） |
| `/diff [path]` | 查看全部或指定路径 diff |
| `/undo-last` | 确认后恢复最近一次自动 checkpoint |
| `/plan` / `/plan clear` | 查看 / 清空当前任务计划（见 task-plan.md） |
| `/skills` / `/skills <name>` | 列出可用技能 / 查看某技能正文（见 skills.md） |
| `/exit`（`/quit`） | 退出程序 |

## 内置命令执行器（CommandExecutor，Phase-10 Q1）

> 修正既有偏差：本 spec「TUI 通过事件流消费 Loop，不内嵌业务逻辑」与实现存在偏差——
> `App.tsx` 的 `handleSubmit` 把 `/resume` `/checkpoint` `/checkpoints` `/restore` `/changes`
> `/diff` `/undo-last` `/plan` `/sessions` `/memory` 等命令的**执行副作用（IO + 状态查询）**
> 直接内嵌在 React 回调里，命令执行路径**仅命令解析（command.ts）有单测、执行无单测**。
> 本节把执行逻辑下沉到一个**可单测的纯逻辑模块** `src/tui/command-executor.ts`，
> `App.tsx` 只负责「调用执行器 + 按返回的结构化结果渲染」。

### 职责边界
- **`command.ts`（已有）**：纯解析，`string → ParsedInput`，不做 IO（不变）。
- **`command-executor.ts`（新增）**：纯逻辑编排，`ParsedInput + 注入 deps → CommandOutcome`。
  - 执行命令副作用：checkpoint 创建/列举/恢复查询、session.resume 目标解析、workspace 状态/diff 查询、plan 查看/清空、memory 状态格式化。
  - **不引用 React、不直接 `push`/`setState`、不渲染**：把「要展示的消息」「要触发的副作用」作为数据返回，由 `App.tsx` 落到 UI。
  - 所有错误以 `CommandOutcome` 数据返回（错误即数据），不向上抛。
- **`App.tsx`（瘦身）**：只做 ① 调 `parseInput` → `executor.run(parsed)`；② 把 `messages` push 进消息流；③ 执行 `effects`（打开 picker / 进入确认态 / 切模型 / 清屏 / 退出 / 落到 Agent）。不再内嵌命令的 IO 与状态查询。

### 接口草案
```ts
// 注入依赖：执行器只认这些「能力」，不认 React。便于测试注入 fake。
interface CommandDeps {
  session: Session;               // resume 目标解析 / memoryStats / logFile / rootDir
  checkpointStore: CheckpointStore;
  planStore: PlanStore;
  listSessions: typeof listSessions;        // session-browser
  getWorkspaceStatus: typeof getWorkspaceStatus; // diff-git
  getWorkspaceDiff: typeof getWorkspaceDiff;
  findLatestAutoCheckpoint: typeof findLatestAutoCheckpoint;
  memory?: MemoryCompaction;      // /memory 展示生效配置
  skills?: SkillRegistry;         // /skills 列目录 / 看正文（Phase-11，关闭或无技能时缺省）
  status: { model; baseURL; maxTurns; turn; apiKeyConfigured }; // /status /model 上下文
}

// 要 push 的消息（与 MessageList 的 kind 对齐）。
type OutMessage = { kind: 'system' | 'error'; text: string };

// 要 App 触发的副作用（描述，不是执行）——纯数据，便于断言。
type CommandEffect =
  | { type: 'none' }
  | { type: 'clear-session' }                       // session.clear + permission.reset + 重置 turn
  | { type: 'set-model'; id: string }
  | { type: 'open-session-picker'; items: SessionSummary[]; index: number }
  | { type: 'open-checkpoint-picker'; items: CheckpointManifest[]; index: number } // /rewind 无参
  | { type: 'resume'; target: string }              // 已解析好的日志目标
  | { type: 'confirm-restore'; id: string; prompt: string } // /restore /undo-last /rewind <id> → 进入确认态
  | { type: 'run-task'; text: string }              // 非命令：落到 Agent
  | { type: 'exit' };

// 单次执行的结构化结果：先 echo 用户输入（由 App 决定是否 push），再给消息 + 一个副作用。
interface CommandOutcome {
  echoUser: boolean;            // 是否把原始输入作为 user 消息回显
  messages: OutMessage[];       // 顺序 push 的系统/错误消息
  effect: CommandEffect;        // App 据此触发 UI 副作用
}

interface CommandExecutor {
  run(parsed: ParsedInput, raw: string): Promise<CommandOutcome>;
}
export function createCommandExecutor(deps: CommandDeps): CommandExecutor;
```

### 取舍说明
- **纯异步函数 + 注入 deps**：`run` 返回 `CommandOutcome` 数据，不接触 React 状态；测试只需断言 `messages`/`effect`，无需渲染。
- **副作用以「描述」返回而非执行**：`/restore` `/undo-last` `/rewind <id>` 返回 `confirm-restore` 让 `App` 进入确认态（确认后的 `checkpointStore.restore` 仍在 `App` 的 `confirmRestore` 里，因为它依赖弹窗按键流）；`/resume`(无参)`/sessions` 返回 `open-session-picker`、`/rewind`(无参) 返回 `open-checkpoint-picker` 让 `App` 持有 picker state（`App` 用判别联合 `PickerState{mode:'session'|'checkpoint'}` 承载，共用一套 ↑/↓/Enter/Esc 键盘逻辑与 `PickerView` 渲染：会话模式 Enter 恢复日志、快照模式 Enter 进入 y/n 回滚确认）。执行器只负责「算出该做什么 + 查好数据」。
- **`exit`/`set-model`/`clear-session` 仍由 App 执行**：这些是 Ink/React 运行时能力（`exit()`、`setModel`、`setMessages`），执行器只发出意图。
- 不引入 future-proofing（命令插件机制、撤销栈等，本轮不做）。

## 验收
- 命令解析单测（`/model <id>` 带参、`/resume` `/sessions` `/memory`、`/checkpoint` `/checkpoints` `/rewind` `/restore`、`/changes` `/diff` `/undo-last`、`/plan` `/plan clear`；HELP_TEXT 含 `/plan` 防漂移）。
- **Ink render 冒烟测试**（tests/tui-render.test.ts，ink-testing-library）：渲染**真实生产组件**
  （`MessageList` / `PermissionPrompt` / `StatusBar`）+ **启动态完整 `<App>`**，断言
  ① 启动欢迎/状态栏（完整 App）；② 工具调用/结果行；③ 权限弹窗（“需要授权”+y/a/n）；④ 状态栏状态流。
  帧文本存 `deliverables/tui-frames/`。
- **命令执行单测（Phase-10 Q1，tests/command-executor.test.ts）**：注入 fake deps，断言各命令的
  `CommandOutcome`——`/checkpoint` 创建后返回成功消息、`/checkpoints` 空/有数据两态、`/restore`
  缺 id 报错 vs 有 id 返回 `confirm-restore`、`/resume`(无参)/`/sessions` 空 vs `open-session-picker`、
  `/resume <path>` 解析出 `resume` target vs 无日志报错、
  `/rewind`(无参) 空 vs `open-checkpoint-picker`、`/rewind <id>` 返回 `confirm-restore`、
  `/changes` `/diff` 调 workspace 查询并格式化、
  `/undo-last` 无自动 checkpoint vs `confirm-restore`、`/plan` `/plan clear`、`/memory` 状态、
  IO 失败收敛为 `error` 消息（不抛）；`unknown`/`task` 分支正确。
- 权限弹窗阻塞执行直到用户选择。
- 真实运行截图入 `deliverables/screenshots/`（见 SCREENSHOTS.md）。

## 不做（首期）
鼠标、多面板布局、主题切换、滚动历史搜索。
