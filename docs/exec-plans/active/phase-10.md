# Exec Plan: Phase 10 — 评审 Loop Round-2（工程质量自洽 + 工具系统补全）

> 状态：implemented（代码 + 测试已落地，291/291 通过，build exit 0） · 最后更新：2026-06-29
> 承接 Phase-9：`npm run build && npm test` = 243/243、build exit 0、真实 API 冒烟跑通。
> 纪律：**docs-first**。本计划 + 受影响 spec 评审通过后再进入代码阶段。当前分支，`src/cli.tsx` 仍只做 composition root。

## 评委裁决（Round-1 后剩余、复核为真的高价值缺口）

Round-1 已补齐基线可靠性（P1/P2/P3）与头号加分（记忆增强 M1-M4）。剩两个"接近满分但有真实缺口"的维度：

| 编号 | 缺口 | 证据（已复核） | 归属 spec | 维度 |
|---|---|---|---|---|
| Q1 | **App.tsx 746 行，命令 I/O 内嵌 handleSubmit**：/resume /checkpoint /restore /changes /diff /undo-last /plan /sessions /memory 的执行逻辑（IO+状态）全堆在 App.tsx，违背项目自己的 tui.md「TUI 通过事件流消费 Loop，不内嵌业务逻辑」。命令执行路径**无单测**（仅命令解析 command.ts 有测）。 | `src/tui/App.tsx` handleSubmit ~246 行起 | tui.md | 工程质量/架构自洽 |
| T1 | **缺 delete_file / move_file**：当前 7 原子工具无删除/移动，重构/清理类真实任务需绕道 run_shell。 | `src/tools/index.ts` builtinTools | tools.md | 工具系统完整度 |
| T2 | **工具形参无统一校验**：各工具手工 cast `as XxxArgs` + 局部 if，缺必填/类型的统一轻量校验；zod 已是依赖却未用于工具入参。 | `src/tools/*.ts` | tools.md | 工具系统健壮性 |

## 里程碑

- [x] **D（docs-first）**：本计划评审通过；更新 tui.md（命令执行器职责分离 + `/resume` 无参打开选择器的主流约定）、tools.md（delete_file/move_file 契约 + 形参校验约定 + 从「不做」移出/澄清）。
- [x] **Q1** 抽 `src/tui/command-executor.ts`：纯逻辑 `CommandExecutor`（接收 ParsedInput + 注入 deps，返回结构化 `CommandOutcome`：echoUser/messages/effect），App.tsx 的 `submit` 只负责调用它 + 据结果 push 消息 / 触发副作用；命令 I/O（checkpoint/session.resume/workspace 查询/plan/memory 格式化/sessions 列举）集中到执行器，与 React 渲染解耦；App 从 ~746 行瘦身，删去内嵌 switch 与重复格式化函数。新增 `tests/command-executor.test.ts`（30 用例）覆盖各命令执行路径，IO 失败收敛为 error（不抛）。
- [x] **T1** 新增 `delete-file.ts`、`move-file.ts`（readOnly=false，经路径沙箱 realpath 守护、越界/不存在/目录非空/目标已存在边界），注册进 `builtinTools`（文件/Shell 工具 7→9，敏感 3→5），权限确认流程自动复用。新增工具测试（delete/move 各路径 + 越界拒绝）。
- [x] **T2** 新增 `validate-args.ts` 轻量统一校验（必填存在 + 基本类型 string/number/boolean），落在各工具入口（read/write/edit/delete/move），错误即数据返回清晰 ok:false（`<tool> 参数无效：<字段> 缺失/类型应为 <type>`）。补 malformed-args 测试（缺必填/类型错 → ok:false 且不执行副作用、不抛）。
- [x] **回归**：`npm run build` exit 0；`npm test` 全绿 **291/291**（基线 243 + 新增 48：command-executor 30 + tools delete/move/malformed 18）；TUI 渲染冒烟（tui-render）行为不变。

## 不做（本轮）
- 投机性 future-proofing（version 字段、快照迁移、baseURL 脱敏、ripgrep/PCRE、可折叠 TUI、↑↓ 历史检索）——与 less is more 冲突或明确「不做（首期）」。
- apply_patch/multi_edit（保持 edit_file 单一职责；可留后续）。
