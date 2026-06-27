# Spec: 配置

> 状态：draft · 最后更新：2026-06-27 · 模块：`src/config/`

## 职责
加载、合并、校验配置，并保护密钥。

## 优先级与合并
**默认值 ← 用户级 ← 项目级**（后者覆盖前者，深合并）：
- 用户级：`~/.config/ai-code-cli/config.json`
- 项目级：`<cwd>/.ai-code-cli/config.json`

## 字段（`zod` 校验）
```jsonc
{
  "provider": "anthropic",                                    // 首期固定（平台工具调用走 Anthropic 协议）
  "model": "deepseek/deepseek-v4-pro",
  "baseURL": "https://ai-kas.kso.net/codeplan/anthropic",
  "timeoutMs": 60000,
  "maxTurns": 25,
  "maxRetries": 2
  // apiKey 不写这里——优先环境变量
}
```

## 密钥处理（强制）
- 优先 `process.env.ANTHROPIC_AUTH_TOKEN`（兼容 `CODEPLAN_API_KEY`）；可由 `.env`（gitignored）加载。
- 允许配置文件 `apiKey` 兜底，但**永不打印、日志脱敏为 `***`**；`/status`、`/model` 仅显示「已配置/未配置」。

## 验收（测试）
- 项目级字段覆盖用户级；未覆盖字段保留用户级/默认（深合并正确）。
- 缺失配置回落默认值。
- 校验失败给出清晰错误，不崩溃。
- 密钥不出现在任何日志/状态输出中。

## 不做（首期）
环境变量覆盖全部字段、多 profile、远程配置。
