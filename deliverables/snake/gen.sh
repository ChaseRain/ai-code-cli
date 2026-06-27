#!/usr/bin/env bash
# deliverables/snake/gen.sh
# 用 curl + .env 里的 key 调用平台 Anthropic Messages 端点，让模型生成单文件可玩贪吃蛇。
# SSE 流式响应；用内置脚本累积 text_delta，抽出 ```html ... ``` 代码块写成 snake.html。
# 不打印密钥。运行：bash deliverables/snake/gen.sh
set -euo pipefail

# 从项目根的 .env 取环境变量（脚本可能从任意 cwd 调用）。
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; source "$ROOT/.env"; set +a

: "${ANTHROPIC_AUTH_TOKEN:?需要 ANTHROPIC_AUTH_TOKEN}"
BASE="${ANTHROPIC_BASE_URL:-https://ai-kas.kso.net/codeplan/anthropic}"
MODEL="${ANTHROPIC_MODEL:-deepseek/deepseek-v4-pro}"

OUT_DIR="$ROOT/deliverables/snake"
RAW="$OUT_DIR/response.sse"

PROMPT='请生成一个单文件、可直接在浏览器打开就能玩的贪吃蛇游戏。要求：纯 HTML+CSS+JavaScript 写在一个 .html 文件里，不依赖任何外部资源或 CDN；用 <canvas> 渲染；方向键控制；吃到食物变长、计分；撞墙或撞到自己游戏结束并可重开；界面简洁美观。只输出一个完整的 HTML 文档，用一个 ```html 代码块包裹，不要任何额外解释。'

# 构造请求体（用 jq 安全转义 prompt）。
BODY="$(jq -n --arg model "$MODEL" --arg prompt "$PROMPT" '{
  model: $model,
  max_tokens: 8192,
  system: "你是一个资深前端工程师，擅长用原生 HTML/CSS/JS 写自包含的小游戏。",
  stream: true,
  messages: [ { role: "user", content: $prompt } ]
}')"

echo "[gen] calling ${BASE}/v1/messages  model=${MODEL} ..."
curl -sS -N "${BASE}/v1/messages" \
  -H "Authorization: Bearer ${ANTHROPIC_AUTH_TOKEN}" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d "$BODY" > "${RAW}"

bytes="$(wc -c < "${RAW}")"
echo "[gen] SSE saved -> ${RAW} (${bytes} bytes)"

# 用 node 累积 text_delta，再抽取 html 代码块。
node "${OUT_DIR}/extract.mjs" "${RAW}" "${OUT_DIR}/snake.html"
echo "[gen] done -> ${OUT_DIR}/snake.html"
