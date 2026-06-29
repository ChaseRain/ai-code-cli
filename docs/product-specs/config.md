# Spec: 配置

> 状态：implemented（Phase-9 补：记忆配置 `memory` 字段 + `AI_CODE_MEMORY_*` 覆盖 契约） · 最后更新：2026-06-29 · 模块：`src/config/`（tests/config.test.ts 覆盖）

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

> ⚠️ **环境变量仅读密钥**：`loadConfig` 只从环境变量解析 `apiKey`（`ANTHROPIC_AUTH_TOKEN` / `CODEPLAN_API_KEY`）。
> `baseURL`、`model` 等字段**不读环境变量**，只来自 DEFAULTS 或 config.json（见下「不做（首期）」）。
> 因此 `.env` 里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 当前不生效；要改请写 `.ai-code-cli/config.json`。

## 硬上限（Phase-7 P7-C，Loop 不失控）
zod 除类型/正数外加 `.max()`：`timeoutMs ≤ 120000`（与 run_shell 上限一致）、`maxTurns ≤ 50`、`maxRetries ≤ 5`。
超限报错并指出字段（如 `timeoutMs: ...≤120000`）；边界值（=上限）通过。见 [`guardrails-hardening.md`](guardrails-hardening.md)。

## 记忆配置（Phase-9 M3，详见 [`memory.md`](memory.md)）
新增 `memory` 字段（可选，缺省回落默认值；与现有字段一致走「项目级覆盖用户级」深合并）：
```jsonc
{
  "memory": {
    "enabled": true,            // 是否启用自动压缩
    "thresholdMsgs": 40,        // 消息数触发阈值（向后兼容，默认值不变）
    "keepRecent": 16,           // 近窗保留条数（向后兼容，默认值不变）
    "thresholdTokens": 24000,   // token 预算触发阈值
    "keepRecentTokens": 8000,   // 近窗保留 token 预算
    "summarizer": "heuristic"   // "heuristic"（默认）| "llm"（失败降级 heuristic）
  }
}
```
- **默认值**：`enabled=true`、`thresholdMsgs=40`、`keepRecent=16`、`thresholdTokens=24000`、`keepRecentTokens=8000`、`summarizer="heuristic"`（与现有硬编码阈值保持向后兼容）。
- **优先级**：默认值 ← 用户级 ← 项目级，沿用既有**深合并**（`memory` 子字段逐项合并，未覆盖项保留下层值）。
- **环境变量覆盖**：`AI_CODE_MEMORY_*` 覆盖对应字段（如 `AI_CODE_MEMORY_ENABLED` / `AI_CODE_MEMORY_THRESHOLD_TOKENS` / `AI_CODE_MEMORY_SUMMARIZER`），优先级高于文件配置。
- **校验上限**：与现有 `zod` 风格一致——数值字段为正数并设 `.max()` 合理上限（防 Loop/压缩失控），`summarizer` 为枚举；超限报错并指出字段名。
- **脱敏一致性**：记忆配置不含密钥；`summarizer="llm"` 复用既有 Provider 与密钥处理，不另存凭据，沿用「永不打印、脱敏 `***`」规则。
- `/memory` 展示**生效配置**（合并 + env 覆盖后的最终值）。

## 技能配置（Phase-11，详见 [`skills.md`](skills.md)）
新增 `skills` 字段（可选，缺省回落默认值；与现有字段一致走「项目级覆盖用户级」深合并）：
```jsonc
{
  "skills": {
    "enabled": true            // 是否启用技能系统（默认 true）
  }
}
```
- **默认值**：`enabled=true`（沿用 memory 子对象的合并/校验模式）。
- **优先级**：默认值 ← 用户级 ← 项目级，沿用既有**深合并**（`skills` 子字段逐项合并）。
- **关闭效果**：`enabled=false` 时 cli 不发现技能、不注入 L1 目录、不注册 `use_skill` 工具；`/skills` 提示已禁用。
- **脱敏一致性**：技能配置不含密钥；技能正文按数据处理（见 skills.md 安全边界），不另存凭据。

## 密钥处理（强制）
- 优先 `process.env.ANTHROPIC_AUTH_TOKEN`（兼容 `CODEPLAN_API_KEY`）；可由 `.env`（gitignored）加载。
- 允许配置文件 `apiKey` 兜底，但**永不打印、日志脱敏为 `***`**；`/status`、`/model` 仅显示「已配置/未配置」。

## 验收（测试）
- 项目级字段覆盖用户级；未覆盖字段保留用户级/默认（深合并正确）。
- 缺失配置回落默认值。
- 校验失败给出清晰错误，不崩溃。
- 密钥不出现在任何日志/状态输出中。
- **（Phase-9）** `memory` 子字段项目级覆盖用户级（深合并、未覆盖项保留）；`AI_CODE_MEMORY_*` 覆盖文件配置；缺省回落记忆默认值；超上限/非法 summarizer 枚举报错并指出字段。
- **（Phase-11）** `skills.enabled` 缺省默认 true；项目级覆盖用户级（深合并）；关闭时不注入技能目录、不注册 `use_skill` 工具。

## 不做（首期）
环境变量覆盖全部字段、多 profile、远程配置。
