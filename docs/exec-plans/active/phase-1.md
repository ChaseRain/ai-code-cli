# Exec Plan: Phase 1 — 最小可用 TUI 编码 Agent

> 状态：active · 最后更新：2026-06-27
> 计划是一等工件：进度勾选 + 决策日志随提交入库。

## 目标
稳定跑通 L2 全部基线能力 + 测试齐全 + 交付贪吃蛇验证产物。**less is more。**

## 里程碑（建议落地顺序）

- [ ] **M1 内核**：types + Config + MockProvider + Tool Registry（只读 3 工具）+ Agent Loop（无 TUI，命令行打印）+ 主循环测试。
- [ ] **M2 工具与权限**：补齐 write/edit/shell + 权限层 + 路径守护 + 对应测试。
- [ ] **M3 真实 Provider**：OpenAIProvider（SSE/超时/重试）打通 Coding Plan。
- [ ] **M4 TUI**：Ink 界面 + 流式渲染 + 权限弹窗 + 内置命令 + 状态栏。
- [ ] **M5 持久化 + 交付**：`.ai_history/logs/`；用 Agent 做贪吃蛇 + 截图 → `deliverables/`；补全测试矩阵。

## 决策日志（Decision Log）

| # | 决策 | 理由 | 状态 |
|---|---|---|---|
| D1 | 语言 = TypeScript/Node | 最贴近参考项目（Codex/Gemini CLI）形态，生态成熟 | 已定 |
| D2 | ~~OpenAI Chat Completions~~ → **Anthropic Messages** | 实测网关 `/v1/chat/completions` 静默丢弃工具调用；Anthropic 端点原生 `tool_use`+流式可用、无本机依赖 | **2026-06-27 修订** |
| D3 | 仓库即记录系统（AGENTS.md 地图 + 结构化 docs/） | 采纳 OpenAI harness 工程；拒绝单体 SPEC blob | 已定 |
| D4 | TUI = Ink | 声明式、组织复杂界面方便；属允许的渲染库 | 已定 |
| D5 | 首期不做：上下文压缩 / 多 Provider / resume | less is more；登记为技术债 | 已定 |

## 风险 / 待确认
- Coding Plan 需连云枢网络；首跑前确认 `CODEPLAN_API_KEY` 与连通性。
- 所选模型的 `tool_calls` 稳定性需在 M3 实测（必要时换 `ali/qwen3.7-max` / `zhipu/glm-5`）。
- 项目根 = 启动 cwd，作为唯一安全边界。
