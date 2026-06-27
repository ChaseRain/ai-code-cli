# 贪吃蛇生成说明（how.md）

> 用 `curl` 直连平台 **Anthropic Messages** 端点，让模型生成单文件可玩贪吃蛇。
> 状态：成功 · 最后更新：2026-06-27

## 产物

- `snake.html` —— 生成的单文件贪吃蛇（HTML+CSS+JS，自包含，浏览器双击即玩）。
- `response.sse` —— 本次调用的原始 SSE 响应流（约 910 KB，含 `message_start` / `content_block_delta(text_delta)` / `message_delta` / `message_stop` 事件）。
- `gen.sh` —— 生成脚本（curl + jq 组装请求 + 调用 extract）。
- `extract.mjs` —— 从 SSE 累积 `text_delta` 文本，抽取 ```html 代码块写出 `snake.html`。

## 复现

```bash
bash deliverables/snake/gen.sh
```

脚本内部 `set -a; source .env; set +a` 取 `ANTHROPIC_AUTH_TOKEN`（**密钥不打印、不入库**）。

## 请求摘要

- 端点：`POST https://ai-kas.kso.net/codeplan/anthropic/v1/messages`
- headers：`Authorization: Bearer <token>`、`anthropic-version: 2023-06-01`、`Content-Type: application/json`
- 请求体（关键字段）：

```json
{
  "model": "deepseek/deepseek-v4-pro",
  "max_tokens": 8192,
  "stream": true,
  "system": "你是一个资深前端工程师，擅长用原生 HTML/CSS/JS 写自包含的小游戏。",
  "messages": [
    { "role": "user", "content": "请生成一个单文件、可直接在浏览器打开就能玩的贪吃蛇游戏……只输出一个完整的 HTML 文档，用一个 ```html 代码块包裹……" }
  ]
}
```

## 响应处理

平台按 Anthropic SSE 协议流式返回。`extract.mjs` 只取 `content_block_delta` 里 `text_delta.text`
拼成完整 markdown，再用正则抽出第一个 ```html ... ``` 代码块。

## 验证（人工抽检）

- 首行 `<!DOCTYPE html>`，含 `</html>` 闭合。
- 含 1 个 `<canvas>`，有游戏循环与方向键监听。
- 无任何 `http(s)://` / `src=` / CDN 外链 —— 完全自包含。

如需重新生成，删除 `snake.html` 与 `response.sse` 后重跑 `gen.sh` 即可。
