# Reference: Coding Plan 平台使用手册原文（存档）

> 状态：reference（原文存档，只读不改） · 归档：2026-06-27
> 来源：《Coding Plan 平台使用手册.docx》。
> **工作用的接入要点（baseURL / 模型 / 鉴权）见 [`coding-plan-platform.md`](coding-plan-platform.md)**（单一真相来源）。
> 本文保留全文供追溯；其中 cc-switch 安装、Codex/Windows 排障、Reasonix、Gemini 等与本项目无关，仅存档。

---

## 一、平台简介

为内部产研运团队提供 AI 工具集成、模型管理、团队额度精细化管控、数据度量等核心能力，赋能团队高效开展 AI 智能编码、AI 辅助决策分析等开发相关工作，同时实现额度管理流程的规范化与高效运转。

## 二、平台地址

需连云枢访问：`https://ai-kas.kso.net/codeplan`

## 三、使用说明

### 如何申请 API Key
进入 Coding Plan 管理页面 → 点击【新建】→ 创建 api key（注意保管，切勿泄露）。

### 如何使用 API Key
- **Cursor 不支持使用**（服务费定价高于国产大模型，且模型能力下降、体验欠佳）。
- 其余 agent 工具均支持配置适配 OpenAI、Anthropic 协议的模型。

#### Claude Code CLI
编辑 `~/.claude/settings.json`（Windows：`C:\Users\<用户名>\.claude\settings.json`）：
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "YOUR_API_KEY",
    "ANTHROPIC_BASE_URL": "https://ai-kas.kso.net/codeplan/anthropic",
    "ANTHROPIC_MODEL": "deepseek/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek/deepseek-v4-pro"
  }
}
```

#### Claude Desktop
使用 CC Switch 实现 Coding Plan 适配（安装 CC Switch → 添加供应商 → 启用 → 新开会话生效）。接入桌面版需前置安装 Claude Code Desktop 并登录；Mac：Help → Troubleshooting → Enable Developer Mode → Developer → Configure Third-Party Inference（Connection 选 Gateway）；CC Switch 路由监听 `127.0.0.1:15721`。

#### OpenCode
编辑 `~/.config/opencode/opencode.json`：
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "codeplan": {
      "name": "WPS CodePlan",
      "options": {
        "baseURL": "https://ai-kas.kso.net/codeplan/v1",
        "apiKey": "<Your Api Key>"
      },
      "models": {
        "zhipu/glm-5":            { "name": "GLM-5",        "limit": { "context": 128000,  "output": 8192 } },
        "moonshot/kimi-k2.5":     { "name": "Kimi-K2.5",    "limit": { "context": 230000,  "output": 8192 } },
        "deepseek/deepseek-v4-pro": { "name": "DeepSeek-V4-Pro", "limit": { "context": 1000000, "output": 8192 } },
        "xiaomi/mimo-v2.5-pro":   { "name": "MiMo-V2.5-Pro", "limit": { "context": 128000,  "output": 8192 } },
        "ali/qwen3.7-max":        { "name": "Qwen3.7-Max",  "limit": { "context": 300000,  "output": 8192 } }
      }
    }
  },
  "model": "codeplan/ali/qwen3.7-max"
}
```
> WSL 中安装 OpenCode 需先装云舒（云枢零信任）。

#### Codex-CLI
安装：`npm install -g @openai/codex`；安装 cc-switch（3.16.x）。`~/.codex/config.toml` 参考：
```toml
model_provider = "wps_codeplan"
model = "zhipu/glm-5"

[model_providers.wps_codeplan]
name = "wps_codeplan"
base_url = "https://ai-kas.kso.net/codeplan/v1"
wire_api = "responses"
```
cc-switch 路由：Settings → Advanced → Routing Service，开启主开关（`127.0.0.1:15721`），勾选 Codex 路由。
测试：`codex exec "用一句话介绍你自己" --skip-git-repo-check`。
> 经 cc-switch 转发后 `base_url` 改为 `http://127.0.0.1:15721/v1`。

#### Codex 经 cc-switch 转发的本地验证（Python，responses 流式）
要点：`POST {BASE_URL}/v1/responses`，`Authorization: Bearer <key>`，`Accept: text/event-stream`，`stream:true`；SSE 事件含 `response.completed` / `response.failed`。（完整脚本见原 docx，此处省略。）

#### 其他
- Codex 桌面版/VSCode 插件版：需先配好 cc-switch 并启动；常见报错 `Missing environment variable: OPENAI_API_KEY` → 配置用户环境变量后重启。
- WSL 的 Codex：cc-switch 在 WSL 安装启动；GUI 乱码装中文字体 `fonts-noto-cjk` 等。
- Reasonix：桌面版/源码版自定义接入；手动加入模型名称。
- Gemini：Coding Plan 管理页【工具账号】查看登录账号，连云枢访问 `https://gemini.google.com/`。

### 如何查看用量
用量分析查看 token 用量、费用、明细；Coding Plan 查看个人额度。

## 四、常见问题
（原文此处为各客户端排障，略。）
