# Tech Debt Tracker

> 状态：active · 最后更新：2026-06-27
> 首期主动延后的能力登记于此。扩展能力不替代、不弱化基础功能。

| # | 项 | 类型 | 说明 | 触发条件 |
|---|---|---|---|---|
| T1 | 上下文压缩 / 历史摘要 | 扩展（加分） | **Session 级已实现 + 测试 + resume 可恢复摘要**（[`memory.md`](../product-specs/memory.md)）；**仅「自动接入实时 loop」仍 future** | 部分完成 |
| T2 | 多 Provider（OpenAI Responses 等） | 扩展 | Provider 接口协议无关；Anthropic 已实现，其余未做 | 有需求时 |
| T3 | 会话 resume / 多会话切换 | 扩展 | **resume 从 jsonl 恢复（含摘要状态）已实现 + 测试**；多会话切换 UI 未做 | 部分完成 |
| T4 | Diff 可视化确认 / Git 感知 | 扩展 | 编辑前展示 diff、感知 git 状态 | 有需求时 |
| T5 | MCP 工具接入 | 扩展 | 外部工具协议 | 有需求时 |
| T6 | doc-gardening 校验（CI lint 文档新鲜度/交叉链接） | 工程 | 当前靠人工遵守 doc hygiene | 仓库变大后 |
