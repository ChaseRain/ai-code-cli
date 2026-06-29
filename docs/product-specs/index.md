# Product Specs — 目录

> 各功能域规格编目。每篇 spec 结构统一：**职责 / 接口 / 行为 / 验收(测试) / 不做**。
> 表中「评审维度」与「测试覆盖」对应 L2 命题的强制评分项。
> 状态取值：`implemented`（已实现并测试）/ `active`（契约现行）/ `draft/spec`（规格已定，代码未实现）/ `partial`（部分实现）。

| Spec | 功能域 | 评审维度 | 测试覆盖 | 状态 |
|---|---|---|---|---|
| [agent-loop.md](agent-loop.md) | Agent 主循环 | Agent Loop | ✅ 主循环 / maxTurns 终止 / 拒绝入上下文 | implemented |
| [tools.md](tools.md) | 工具系统（9 文件/Shell + `update_plan`） | 工具系统 | ✅ 结果回传 / 路径越界 / edit 唯一性 / shell 退出码 / delete·move / malformed-args | implemented |
| [permissions.md](permissions.md) | 权限控制 | 权限控制 | ✅ 只读自动 / 写类确认 / 拒绝入上下文 | implemented |
| [provider.md](provider.md) | LLM Provider（**Anthropic Messages** + Mock） | LLM Provider | ✅ Mock Provider / SSE 解析 / 超时·重试 | implemented |
| [config.md](config.md) | 配置（用户级 + 项目级） | 配置管理 | ✅ 项目级优先 / 深合并 / 缺省回落 | implemented |
| [session-context.md](session-context.md) | 会话上下文 + 持久化 | 会话上下文 | ✅ 全要素入历史 / jsonl 落盘 | implemented |
| [tui.md](tui.md) | TUI + 内置命令 | TUI 交互体验 | ✅ 命令解析 + Ink render 冒烟（tests/tui-render.test.ts）+ 命令执行（tests/command-executor.test.ts） | implemented |
| [memory.md](memory.md) | 记忆增强（resume / 压缩 / summary） | 扩展（加分） | ✅ resume + 命令 + Session 级压缩 + Loop 自动压缩（tests/memory.test.ts + tests/agent-loop.test.ts） | implemented |
| [checkpoint.md](checkpoint.md) | Checkpoint / Restore | 扩展（第一梯队） | ✅ tests/checkpoint.test.ts + agent-loop auto hook + 命令解析/确认提示 | implemented |
| [session-browser.md](session-browser.md) | Session Browser | 扩展（第一梯队） | ✅ tests/session-browser.test.ts + `/sessions` `/resume <id|latest>` 命令扩展 | implemented |
| [diff-git.md](diff-git.md) | Diff / Git-aware | 扩展（第一梯队） | ✅ tests/diff-git.test.ts + 未跟踪文件 diff + 写前 preview event + `/changes` `/diff` `/undo-last` | implemented |
| [task-plan.md](task-plan.md) | Task Plan / Todo 可观测（`update_plan` + `/plan`） | 扩展（加分） | ✅ tests/task-plan.test.ts + tools/tui-command/tui-render | implemented |
| [load-hardening.md](load-hardening.md) | 稳定性 / 压测硬化（LH1-LH8） | 可靠性 | ✅ LH1-LH8 全部（checkpoint/session/workspace/tools + 压测 C1-C3/D1-D3） | implemented |
| [guardrails-hardening.md](guardrails-hardening.md) | 边界硬化（P7-A~E：symlink/文件大小/配置上限/进程树/glob·grep 逃逸；P8-A/B：grep 资源·正则安全） | 安全·可靠性 | ✅ P7-A~E + P8-A/B（tests/guardrails.test.ts） | implemented |
| [skills.md](skills.md) | Skills 渐进式加载技能系统（L1 目录 / L2 use_skill / L3 资源） | 扩展（加分） | ✅ tests/skills.test.ts（parse/registry/use_skill/buildSystemPrompt，27）+ command/command-executor（/skills）+ config（skills.enabled）+ 工具计数同步 | implemented |

## 测试矩阵（对应交付强制项）

| 评审强制测试 | 落在哪 | 状态 |
|---|---|---|
| Agent 主循环 | agent-loop.md | ✅ tests/agent-loop.test.ts |
| 工具调用与结果回传 | tools.md + agent-loop.md | ✅ tests/tools.test.ts |
| 权限确认与拒绝 | permissions.md | ✅ tests/permission.test.ts |
| 配置优先级 | config.md | ✅ tests/config.test.ts |
| Mock LLM Provider | provider.md（贯穿全部用例的驱动） | ✅ tests/provider.test.ts |
| **（Phase-9）流读取超时 + 网络错误重试** | provider.md（P1/P2） | ⏳ tests/provider.test.ts（极慢 stream 触发 idle abort；ECONNREFUSED 首败二成；4xx 不重试） |
| **（Phase-9）权限会话级 allowlist 重置** | permissions.md（P3） | ⏳ tests/permission.test.ts（`reset()` 后同工具重新提确认） |
| **（Phase-9）记忆 LLM/token/融合/配置** | memory.md（M1-M5）+ config.md | ⏳ tests/memory.test.ts（LLM 降级、token 触发、融合摘要数 ≤ 2）+ tests/config.test.ts（memory 优先级 + env 覆盖） |
| **（Phase-10 Q1）命令执行器** | tui.md（CommandExecutor） | ✅ tests/command-executor.test.ts（注入 fake deps，断言各命令 `CommandOutcome` 的 messages/effect，IO 失败收敛为 error） |
| **（Phase-10 T1）delete_file / move_file** | tools.md（新增工具契约） | ✅ tests/tools.test.ts（删文件/删空目录成功；删非空目录·删不存在·move 目标已存在报错；源/目标越界拒绝） |
| **（Phase-10 T2）malformed-args 形参校验** | tools.md（形参校验约定） | ✅ tests/tools.test.ts（缺必填/类型错 → `ok:false` 清晰错误且不执行副作用、不抛） |
| **（Phase-11）Skills 渐进式加载** | skills.md（L1/L2/L3 + frontmatter + 安全边界） | ✅ tests/skills.test.ts（parseFrontmatter；SkillRegistry 发现/项目覆盖/容错/穿越拒绝；use_skill 存在·缺失·malformed；buildSystemPrompt 有/无技能，27）+ command/command-executor（/skills）+ config（skills.enabled）+ 工具计数同步 |

> 实测：基线 `npm test` 73/73；Round-2（2026-06-28）当前 `npm run build && npm test` = **91/91** 通过、`build` exit 0。完整验收记录见 [`../exec-plans/active/phase-1.md`](../exec-plans/active/phase-1.md)。
> Round-3 第一梯队（Checkpoint/Restore + Session Browser + Diff/Git-aware，2026-06-28）当前 `npm run build && npm test` = **112/112** 通过、`build` exit 0。计划见 [`../exec-plans/active/phase-2.md`](../exec-plans/active/phase-2.md)。
> Phase-3 Memory 自动压缩接入（2026-06-28）当前 `npm run build && npm test` = **116/116** 通过、`build` exit 0。计划见 [`../exec-plans/active/phase-3.md`](../exec-plans/active/phase-3.md)。
> Phase-4 质量硬化（2026-06-28）当前 `npm run build && npm test` = **120/120** 通过、`build` exit 0。计划见 [`../exec-plans/active/phase-4.md`](../exec-plans/active/phase-4.md)。
> Phase-5 Task Plan / Todo 可观测（2026-06-28）当前 `npm run build && npm test` = **131/131** 通过、`build` exit 0（含 `/clear` 日志唯一性回归硬化）。计划见 [`../exec-plans/active/phase-5.md`](../exec-plans/active/phase-5.md)。
> Phase-6 稳定性/压测硬化（2026-06-28）第一批 LH1-LH4 + 第二批 LH5-LH7 全部完成，当前 `npm run build && npm test` = **148/148** 通过、`build` exit 0；压测 C1-C3 + D1-D3 达标。计划见 [`../exec-plans/active/phase-6.md`](../exec-plans/active/phase-6.md)。
> Phase-7 Guardrails / 边界硬化（2026-06-28）P7-A~E（symlink 逃逸 / 文件大小上限 / 配置硬上限 / 进程树清理 / glob·grep pattern 逃逸）全部完成，当前 `npm run build && npm test` = **174/174** 通过、`build` exit 0；复现 P7-A~E 达标。计划见 [`../exec-plans/active/phase-7.md`](../exec-plans/active/phase-7.md)。
> Phase-8 grep 资源与正则安全（2026-06-28）P8-A（stat-before-read 跳过过大文件）+ P8-B（拒绝 nested quantifier / 歧义 alternation ReDoS，含非捕获/命名捕获/一层包装/可选分支/字符类首 token 补洞）+ P8-C（语义原子 `\d`/`\w`/`\s`/`.`/否定类 + 一层分支 unwrap）完成，当前 `npm run build && npm test` = **213/213** 通过、`build` exit 0；复现 P8-A/B/C 达标。计划见 [`../exec-plans/active/phase-8.md`](../exec-plans/active/phase-8.md)。
> Phase-9 评审 Loop Round-1（2026-06-29，docs-first 现行）可靠性补强 P1（SSE 流读取 idle 超时关联外部 signal）/ P2（网络错误分类重试：429/5xx/网络错误/非用户 AbortError 可重试，其他 4xx 不重试）/ P3（权限 `reset()`，`/clear` 重置会话级 allowlist）+ 头号加分「优异上下文压缩」M1（可注入 `LLMSummarizer` + 失败降级）/ M2（`estimateTokens` + token 预算压缩，消息数阈值向后兼容降级）/ M3（摘要保留错误·关键工具结果·末 2 条 assistant 推理 + 二次压缩融合，摘要数 ≤ 2 不变量）/ M4（`/clear` 重置计数、`/resume` 摘要桥接）/ M5（`config.memory` 配置化 + `AI_CODE_MEMORY_*` 覆盖）。受影响 spec：provider.md / permissions.md / memory.md / config.md。计划见 [`../exec-plans/active/phase-9.md`](../exec-plans/active/phase-9.md)。代码 + 测试已落地（2026-06-29）：当前 `npm run build && npm test` = **243/243** 通过、`build` exit 0（基线 213 + 新增 30：P1/P2 流读取超时与网络错误重试、P3 `reset()`、M1 `LLMSummarizer`/复合降级、M2 `estimateTokens`/token 预算压缩、M3 摘要增强 + 融合 ≤ 2、M3/M4 `/memory` 生效配置展示 + `/resume` 桥接、config `memory` 合并/env 覆盖/枚举与上限校验）。
> Phase-11 Skills 渐进式加载技能系统（2026-06-29，docs-first 现行，**当前阶段只改文档**）：新增支撑域 `src/skills/`（能力扩展），以三级渐进式披露供给模型——L1 全部技能 `name+description` 注入 system prompt、L2 模型按需 `use_skill` 加载某技能正文、L3 技能引用资源由模型自行 read_file·run_shell。两级目录（用户级 `~/.config/ai-code-cli/skills/` + 项目级 `<cwd>/.ai-code-cli/skills/`，项目优先）；`SKILL.md` 极简 frontmatter（自写最小 `key: value` 解析，**不引入 YAML 依赖**，`name` 缺失回落目录名）；`use_skill` 工具 `readOnly`（只读本地已安装技能 → 自动执行不弹窗，权限不旁路）；`/skills` 命令；`config.skills.enabled` 开关；安全边界（技能名单段防穿越、≤ `MAX_TOOL_FILE_BYTES`、技能正文按数据处理）。新增 spec：skills.md（implemented）。计划见 [`../exec-plans/active/phase-11.md`](../exec-plans/active/phase-11.md)。代码 + 测试已落地（2026-06-29）：当前 `npm run build && npm test` = **335/335** 通过、`build` exit 0（基线 291 + 新增 44：tests/skills.test.ts 27 + tests/config.test.ts skills.enabled 合并/校验 5 + tests/command-executor.test.ts /skills 列目录·看正文·缺失·禁用·空 5 + tests/tui-command.test.ts /skills 解析 + HELP_TEXT 1 + tests/tools.test.ts use_skill 注册/计数同步 1，及若干断言微调）。`createDefaultRegistry()` 不注入技能时仍为 10 个工具（确定）；注入 SkillRegistry 后追加 use_skill 为 11。示例技能 `.ai-code-cli/skills/{commit-message,code-review}/SKILL.md` 随仓库提交。

> Phase-10 评审 Loop Round-2（2026-06-29，docs-first 现行）工程质量自洽 + 工具系统补全：Q1（抽 `src/tui/command-executor.ts` 纯逻辑 `CommandExecutor`，命令 I/O + 状态查询从 App.tsx 下沉，App `submit` 只调执行器 + 据 `CommandOutcome`(echoUser/messages/effect) push 消息/触发副作用，命令执行路径首次获单测；`/resume` 无参改为打开会话选择器的主流约定）/ T1（新增 `delete_file`/`move_file`，文件/Shell 工具 7→9、敏感 3→5，复用 realpath 沙箱 + 权限确认）/ T2（新增 `validate-args.ts` 轻量统一形参校验：必填存在 + 基本类型，落在 read/write/edit/delete/move 入口，错误即数据）/ U1（主流交互约定落地：`/resume` 无参打开交互式会话选择器、`/sessions` 为别名；新增 `/rewind` 作为 checkpoint 回滚的主流命令——无参打开快照选择器、`/rewind <id>` 等价 `/restore <id>`；执行器加 `open-checkpoint-picker`，App 用判别联合 `PickerState{session|checkpoint}` 共用 `PickerView` + ↑/↓/Enter/Esc 键盘逻辑）。受影响 spec：tui.md / tools.md / session-browser.md / checkpoint.md。计划见 [`../exec-plans/active/phase-10.md`](../exec-plans/active/phase-10.md)。代码 + 测试已落地（2026-06-29）：当前 `npm run build && npm test` = **296/296** 通过、`build` exit 0（基线 243 + Q1/T1/T2 48 + U1 5：command-executor `/rewind` 4 + command 解析/HELP 1）。
