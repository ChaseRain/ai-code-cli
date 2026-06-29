# ai-code-cli — AGENTS.md

> 从零实现的最小可用 **TUI 终端编码 Agent**（对标 Claude Code / Codex CLI / Gemini CLI）。
> 本文件是**地图，不是手册**：保持精简（≈100 行），只告诉你「去哪里找真相」。深层事实在 `docs/`。
> 第一原则：**less is more**。**代码仓库即记录系统**——不在仓库里（已版本化）的知识，对 Agent 不存在。

## 怎么读这个仓库（渐进式披露）

从一个小而稳定的入口开始，按指引深入，而不是一上来被淹没：

1. `docs/design-docs/core-beliefs.md` — 操作原则（Agent 优先 / Harness 工程）。**先读这个。**
2. 设计按 **DDD 分层抽象**（上层不清晰不进下层）：
   - ① 用例 `docs/design-docs/use-cases.md`
   - ② 领域 `docs/design-docs/domain-model.md`（限界上下文 / 统一语言 / 聚合）
   - ③ 系统 `ARCHITECTURE.md`（分层、目录边界、依赖规则、数据流）
   - 跨层时序 `docs/design-docs/flows.md`
3. `docs/product-specs/index.md` — 各功能域规格目录（含状态与测试覆盖映射）。
4. `docs/exec-plans/active/` — 当前在做什么、进度、决策日志（plans 是一等工件）。
5. `docs/references/` — 外部事实唯一来源（理念原文、L2 命题、Coding Plan API）。

## 技术栈（已定）

| 维度 | 选择 |
|---|---|
| 语言 / 运行时 | TypeScript + Node.js (LTS) |
| TUI 渲染 | Ink（第三方渲染库，规则允许） |
| LLM 协议 | Anthropic Messages（`/anthropic/v1/messages`，平台 OpenAI 端点不支持工具调用，见 D2） |
| 测试 | Vitest |
| 构建 | tsc → `dist/`；tsx 开发 |

## 关键约束（详见各 spec，勿在此展开）

- **核心四件套自研**：Agent Loop / 工具系统 / 权限 / 会话——禁用任何 Agent SDK / Framework。
- **权限**：只读自动执行；写 / 编辑 / Shell 必须用户确认；拒绝结果进入上下文。
- **安全边界**：所有文件与 Shell 操作限制在项目根（cwd）内。
- **密钥**：API Key 永不入库、不打印、日志脱敏；优先环境变量 `ANTHROPIC_AUTH_TOKEN`（由 gitignored 的 `.env` 加载）。
- **沉淀**：对话关键内容写入 `.ai_history/logs/`。

## 命令（以 `package.json` scripts 为准）

- 开发：`npm run dev`（tsx 直跑 `src/cli.tsx`）
- 构建：`npm run build`（tsc → `dist/`）→ 运行 `npm start`（即 `node dist/cli.js`）
- 测试：`npm test`（vitest run，覆盖矩阵见 product-specs/index.md）

## 文档卫生（doc hygiene，硬性约定）

- **AGENTS.md 永远是地图**，别长成百科。新增深度内容写进 `docs/`，这里只加一行指针。
- 改动行为时，**同一次提交**内更新对应 spec 与 exec-plan 的决策日志。
- 每篇 spec / 设计文档带「**状态 + 最后更新**」头；过时即标记或删除，宁缺毋滥。
- **交叉链接而非复制**：同一事实只有一个真相来源，其余地方引用路径。
