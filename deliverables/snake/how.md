# 贪吃蛇生成说明（how.md）

> 状态：主证据=本项目 Agent 自驱生成 · 最后更新：2026-06-27

## 主证据：本项目 Agent / TUI 自驱完成（符合 L2「自行用 Code Agent 完成一个小任务证明 Agent 可运行」）

真实运行记录：[`../../.ai_history/logs/2026-06-27T08-05-16-205Z-jubwj3a9.jsonl`](../../.ai_history/logs/2026-06-27T08-05-16-205Z-jubwj3a9.jsonl)

该会话完整体现 Agent 闭环：

| 行 | kind | 内容 |
|---|---|---|
| [3] | `user` | 「帮我写一个贪吃蛇游戏」 |
| [4] | `assistant` | 决策：用 HTML/CSS/JS 做可直接在浏览器玩的版本 |
| [5] | `tool_call` | **`write_file`**（id `call_00_lG96xRIJeaIGUE52saUZ2547`，args = 路径 `snake.html` + 完整 HTML 内容） |
| [6] | `permission` | **权限确认记录**（敏感工具 `write_file` 经授权，toolCallId 对应同一调用） |
| [7] | `tool_result` | `ok: true` —— 文件写入成功 |
| [8] | `assistant` | 基于工具结果继续推理：确认「贪吃蛇游戏已创建完成，文件在 `snake.html`」 |

→ 即：**自然语言任务 → 模型决策 → 工具调用 → 权限确认 → 结果回传 → 继续推理** 的完整主链路，由本项目 Agent 真实跑通并产出可玩程序。

> 本目录的 [`snake.html`](snake.html) **就是该次 Agent 经 `write_file` 写出的产物**（已从项目根迁入此处，
> 根目录不再保留副本，交付边界清晰）。运行截图见 [`../screenshots/04-snake-running.png`](../screenshots/04-snake-running.png)。

## 补充/旧证据：curl 直连（非主证据）

`gen.sh` + `extract.mjs` 是早期用 `curl` 直连平台 Anthropic 端点生成 `snake.html` 的脚本，仅用于**验证平台协议连通性**，**不作为 Agent 可运行的证据**。保留以备复现：

```bash
bash deliverables/snake/gen.sh   # set -a; source .env 取 ANTHROPIC_AUTH_TOKEN（密钥不打印、不入库）
```
- 端点：`POST https://ai-kas.kso.net/codeplan/anthropic/v1/messages`
- `response.sse`：该次调用的原始 SSE 流（含 `content_block_delta(text_delta)` 等）。

## 产物校验（人工抽检）
- 首行 `<!DOCTYPE html>`，含 `</html>` 闭合；含 1 个 `<canvas>`，有游戏循环与方向键监听。
- 无任何 `http(s)://` / `src=` / CDN 外链 —— 完全自包含，浏览器双击即玩。

## 运行截图
已补齐：[`../screenshots/04-snake-running.png`](../screenshots/04-snake-running.png)——headless Chrome 对 Agent 产物 [`snake.html`](snake.html) 截图（画布 + 蛇身 + 食物 + 得分/最高分 + 方向键提示）。
说明与复现见 [`../SCREENSHOTS.md`](../SCREENSHOTS.md) 第 4 项（`npx tsx deliverables/screenshots.ts 04`）。
