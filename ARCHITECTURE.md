# ARCHITECTURE — 顶层地图（系统设计层）

> 顶层结构、目录边界、依赖规则、数据流。模块内部细节见 `docs/product-specs/`。
> 状态：active（已落地实现） · 最后更新：2026-06-27
> **抽象层定位：③ 系统设计**。上承领域模型（[`docs/design-docs/domain-model.md`](docs/design-docs/domain-model.md)），
> 下接功能规格与编码。本文是「限界上下文 → 代码目录/分层」的落地映射。

## 分层

```
┌──────────────────────────────────────────────┐
│                   TUI (Ink)                    │  输入 / 消息流 / 状态栏 / 权限弹窗 / 内置命令
└───────────────┬───────────────────▲───────────┘
                │ 用户输入·确认       │ 事件流(文本增量/工具事件/状态)
                ▼                    │
┌──────────────────────────────────────────────┐
│                 Agent Loop                     │  决策→工具→结果→再决策；守护栏(maxTurns/abort)
└──┬──────────┬───────────┬──────────┬──────────┘
   ▼          ▼           ▼          ▼
┌──────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
│Prov- │ │  Tool   │ │Permission│ │ Session  │
│ider  │ │ Registry│ │  Policy  │ │ +Context │
└──────┘ └─────────┘ └──────────┘ └────┬─────┘
   ▲                                    ▼
┌──────┐                       .ai_history/logs/*.jsonl
│Config│  默认 ← 用户级 ← 项目级(优先) → 注入各层
└──────┘
```

## 目录边界（`src/`）

| 目录 | 职责 | 对应 spec |
|---|---|---|
| `cli.tsx` | 入口（组合根）：装配 config/provider/tools/permission/session，启动 TUI | — |
| `config/` | 加载·合并·校验·脱敏 | product-specs/config.md |
| `provider/` | **Anthropic Messages** + Mock；SSE/超时/重试 | product-specs/provider.md |
| `tools/` | 工具注册表 + 7 原子工具 + 路径守护 | product-specs/tools.md |
| `permission/` | 策略 + 会话级 allowlist | product-specs/permissions.md |
| `agent/` | Agent Loop 编排 | product-specs/agent-loop.md |
| `session/` | 历史 + jsonl 持久化 | product-specs/session-context.md |
| `tui/` | Ink 组件 + 内置命令 | product-specs/tui.md |

## 依赖规则（关键，CI 应能机械校验方向）

- `agent/loop` **只编排**，不直接做 HTTP / 文件 IO / 渲染。
- `provider` 不认识 `tools`；`tools` 不认识 `provider`；两者经 `loop` 串联。
- `tui` 通过事件流消费 `loop`，不内嵌业务逻辑。
- `config` 单向注入各层；secrets 不下沉到任何可日志路径。

## 数据流（一轮）

用户输入 → `session` 追加 user → `provider`(流式) → 解析 `tool_calls` → `permission`(只读直过 / 写类弹确认) → 执行或生成「拒绝」结果 → `tool` 结果回 `session` → 循环，直到无 `tool_call`（最终回复）或触顶 `maxTurns`。
