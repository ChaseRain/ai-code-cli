# Reference: WPS Coding Plan 平台 API

> 状态：active · 最后更新：2026-06-27
> 外部事实的**唯一真相来源**。改 API 接入相关代码前先核对这里。
> 来源：《Coding Plan 平台使用手册》；完整原文存档见 [`coding-plan-manual.md`](coding-plan-manual.md)。

## ⚠️ 实测结论（2026-06-27，决定协议选型）
- **OpenAI `/v1/chat/completions`：纯文本可用，但工具调用不可用**——传 `tools` 报 `param_wrong(400)`；
  传旧版 `functions` 不报错但**静默忽略**（即便强制 `function_call` 也只返文本）。故本项目**不走此端点**。
- **Anthropic `/anthropic/v1/messages`：原生 `tool_use` + 流式完全可用**（实测返回 `tool_use` 块与 `input_json_delta` 增量）。**← 本项目采用**。
- `/v1/responses`：直连 404，需 cc-switch 本地路由（127.0.0.1:15721），有本机依赖，不采用。

## 接入要点（Anthropic 协议，本项目采用）
- baseURL：`https://ai-kas.kso.net/codeplan/anthropic`，端点 `POST /v1/messages`
- Headers：`Authorization: Bearer <API_KEY>`、`anthropic-version: 2023-06-01`
- 工具：`tools:[{name, description, input_schema}]`；流式默认 SSE。
- **网络**：需连云枢（零信任）。API Key 在管理页【新建】创建，切勿泄露、**切勿入库**（用 `.env`，已 gitignore）。

## 可用模型
| 模型 ID | 备注 |
|---|---|
| `deepseek/deepseek-v4-pro` | 默认；上下文约 1,000,000 |
| `zhipu/glm-5` | 上下文 128k |
| `moonshot/kimi-k2.5` | 上下文 230k |
| `ali/qwen3.7-max` | 上下文 300k |
| `xiaomi/mimo-v2.5-pro` | 上下文 128k |
| `deepseek/deepseek-v4-flash` | 轻量/快速 |

## 备注（其他协议，首期不实现）
- Anthropic 协议：baseURL `https://ai-kas.kso.net/codeplan/anthropic`（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`）。
- Codex/Responses：`wire_api="responses"`，端点 `/v1/responses`，SSE 事件含 `response.completed` / `response.failed`（经 cc-switch 本地路由 `127.0.0.1:15721`）。
- Cursor 不支持本平台。

## 平台地址
- 管理页（连云枢）：`https://ai-kas.kso.net/codeplan`
