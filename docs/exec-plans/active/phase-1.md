# Exec Plan: Phase 1 — 最小可用 TUI 编码 Agent

> 状态：active（基线 M1-M5 + Round-2 R1–R6 已完成；仅「记忆压缩自动接入实时 loop」仍为 future） · 最后更新：2026-06-28
> 计划是一等工件：进度勾选 + 决策日志 + 验收记录随提交入库。

## 目标
稳定跑通 L2 全部基线能力 + 测试齐全 + 交付贪吃蛇验证产物。**less is more。**

## 里程碑（实际完成状态）

- [x] **M1 内核**：types + Config + MockProvider + Tool Registry + Agent Loop + 主循环测试。✅
- [x] **M2 工具与权限**：write/edit/shell + 权限层 + 路径守护 + 对应测试。✅
- [x] **M3 真实 Provider**：**AnthropicProvider**（SSE/超时/重试）打通 Coding Plan（协议见 D2 修订）。✅
- [x] **M4 TUI**：Ink 界面 + 流式渲染 + 权限弹窗 + 内置命令 + 状态栏。✅（命令解析 + UI 渲染冒烟均已补，见 R4）
- [x] **M5 持久化 + 交付**：`.ai_history/logs/` + 贪吃蛇产物 + 真实截图（4/4，见 R5）。✅

## 验收记录（Acceptance）

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| 类型检查（基线，2026-06-27） | `npx tsc --noEmit` | 通过（exit 0） |
| 测试（基线，2026-06-27） | `npm test`（vitest） | **73/73 通过**，7 文件覆盖 config/provider/tools/permission/agent-loop/session/tui-command |
| 构建（基线，2026-06-27） | `npm run build` | 通过，`dist/` 完整 |
| **Round-2 验收（2026-06-28）** | `npm run build && npm test` / 截图 / `screenshots.ts` 退出码 | build exit 0 · **91/91 通过**（+memory/tui-render）· 截图 **4/4** 有效 · 退出码 0(全成功)/1(有失败) |
| L2 强制测试矩阵 | 主循环 / 工具回传 / 权限确认·拒绝 / 配置优先级 / Mock Provider | 全覆盖（见 product-specs/index.md 测试矩阵） |
| 真实 API 闭环 | `deliverables/smoke-output.txt` | Agent 经 Anthropic 协议真实调用 `read_file`，2 轮完成只读任务 |
| Agent 自驱产物 | `.ai_history/logs/2026-06-27T08-05-16-205Z-jubwj3a9.jsonl` | 用户「写贪吃蛇」→`write_file` 工具调用→permission 记录→tool_result ok→产出 snake.html（**主证据**） |
| 密钥安全 | 全仓 grep | 密钥仅在 gitignored `.env`，远端无泄漏 |

## 决策日志（Decision Log）

| # | 决策 | 理由 | 状态 |
|---|---|---|---|
| D1 | 语言 = TypeScript/Node | 最贴近参考项目（Codex/Gemini CLI）形态，生态成熟 | 已定 |
| D2 | ~~OpenAI Chat Completions~~ → **Anthropic Messages** | 实测网关 `/v1/chat/completions` 静默丢弃工具调用；Anthropic 端点原生 `tool_use`+流式可用、无本机依赖 | **2026-06-27 修订·已落地** |
| D3 | 仓库即记录系统（AGENTS.md 地图 + 结构化 docs/） | 采纳 OpenAI harness 工程；拒绝单体 SPEC blob | 已定 |
| D4 | TUI = Ink | 声明式、组织复杂界面方便；属允许的渲染库 | 已定 |
| D5 | 首期不做：上下文压缩 / 多 Provider / resume | less is more；登记为技术债 | 已定 |
| D6 | 代码由多 Agent 工作流按 docs 规格自动生成 | 自证 harness 方法；人类把关规格与验收 | 已定 |

## Round-2（本批：增强分 + 交付证据闭环）

> 文档契约先行，再落代码与交付物。验收以 `npm run build && npm test` 全绿 + 真实图片文件为准。

| # | 项 | 设计/契约 | 验收 |
|---|---|---|---|
| R1 | 权限日志语义 | 只读自动放行记为 `auto_allow`（不再与用户授权的 `allow` 混淆）；敏感工具仍需确认，拒绝 `deny` 且 denial 入上下文 | 见 [`permissions.md`](../../product-specs/permissions.md)「权限日志语义」；loop 测试断言 read-only→auto_allow / 确认→allow / 拒绝→deny |
| R2 | 记忆·会话恢复 | `Session.resumeFrom(jsonl)` 重建 Message[]（tool_call 挂回前条 assistant，保 tool 配对）+ `findLatestLog` + `/resume` `/memory` 命令 | memory.md A5/A6；resume 重建顺序与配对正确；命令解析单测 |
| R3 | 记忆·压缩（冲增强分） | `Session.maybeCompact({threshold,keepRecent,summarizer})` + 可注入 `Summarizer`（测试用 Mock）；压缩不破坏 tool 配对、system 保留、近窗保真 | memory.md A1–A4/A7 单测；**仅 Session 级实现+测试，未自动接入实时 loop（如实标注，不夸大）** |
| R4 | TUI 可验收 | ink-testing-library 渲染**真实生产组件**（`MessageList`/`PermissionPrompt`/`StatusBar`）+ **启动态完整 `<App>`** | tests/tui-render.test.ts 断言帧含关键文案；帧文本存 `deliverables/tui-frames/` |
| R5 | 截图 | ink 帧→ansi→html→headless Chrome 出 PNG；snake.html 用 Chrome 直接截图 | `deliverables/screenshots/01..04.png` 真实存在；SCREENSHOTS.md 逐张链接 |
| R6 | snake 证据 | 根 `snake.html`（Agent write_file 产物）迁入/覆盖 `deliverables/snake/snake.html`，清理根目录 | how.md 以 `.ai_history/.../jubwj3a9.jsonl` 为主证据；根目录无 snake.html |

## 风险 / 待确认
- Coding Plan 需连云枢网络；运行前确认 `ANTHROPIC_AUTH_TOKEN`（`.env`）与连通性。
- 项目根 = 启动 cwd，作为唯一安全边界。
