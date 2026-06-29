# Exec Plan: Phase 7 — Guardrails / 边界硬化

> 状态：implemented（P7-A~E 已完成+测试+回归） · 最后更新：2026-06-28
> 不做新功能，只硬化已有功能边界。承接 Phase-6 现状 `npm run build && npm test` = 148/148。
> 规格：[`../../product-specs/guardrails-hardening.md`](../../product-specs/guardrails-hardening.md)。

## 风险输入（独立复现）
- **P7-A** `resolveInRoot` 仅 lexical，symlink 可逃逸：`root/link→outside`，read_file/write_file 经 link 读写到 root 外。
- **P7-B** read_file/edit_file 先整文件 readFile 再截断、write_file 无大小 guard：12MiB 单行造成 ~12MiB heap delta、可写 12MiB。
- **P7-C** config 只 positive/nonnegative：可加载 timeoutMs=999999999、maxTurns=1e9、maxRetries=999999。
- **P7-D** run_shell timeout 只 kill shell：后台子进程持有 pipe，超时守护失效、Promise 悬挂。

## 里程碑
- [x] **P7-A** path-guard realpath 语义 + grep/glob 不跟随 symlink。
- [x] **P7-B** 工具文件大小上限（read/edit/write）。
- [x] **P7-C** config zod 硬上限。
- [x] **P7-D** run_shell detached 进程组 + 杀进程树。
- [x] **P7-E** glob/grep pattern/cwd/include 逃逸防护（`assertGlobInRoot` + cwd realpath + 结果后置过滤）。

## 验收矩阵
| # | 验收点 | 验证 |
|---|---|---|
| P7-A1 | symlink 读/写/编辑/列目录被拒，root 外未被读写 | tests/guardrails.test.ts |
| P7-A2 | checkpoint/workspace 经 symlink 入口被拒 | tests/guardrails.test.ts |
| P7-B1 | 12MiB read_file/edit_file 拒绝、write_file 12MiB content 拒绝 | tests/tools.test.ts |
| P7-C1 | timeoutMs/maxTurns/maxRetries 边界通过、超限报错指字段 | tests/config.test.ts |
| P7-D1 | timeout 命令外层 Promise.race 内返回；marker 进程无残留 | tests/tools.test.ts |
| P7-E1 | glob cwd=`..` / pattern=`../outside` / 绝对路径越界 `ok:false`（含越界）；grep include=`../outside` 越界；经 root 内 symlink 指向 outside 被拒；root 内回归正常 | tests/guardrails.test.ts |
| P7-Z | 历史回归全绿 | `npm run build && npm test` |

## 复现脚本记录（临时脚本对 dist，2026-06-28）
- **P7-A** `root/link→outside`：read 阻断=true、write 阻断=true、外部 `pwn.txt` 未创建=true。
- **P7-B** 12MiB 文件 read_file：拒绝=true，heapDelta ≈ **0.0MiB**（修复前 ~12MiB）。
- **P7-C** 超大配置：`配置文件校验失败 … timeoutMs/maxTurns/maxRetries 不能超过…`（按字段报错）。
- **P7-D** `node setInterval & wait` timeoutMs=300：**309ms** 返回（假死=false、ok=false）、`pgrep` 残留=空。
- **P7-E** glob cwd=`..` / pattern=`../outside` / 绝对路径 / cwd=symlink、grep include=`../outside` → 全部 `ok:false`（越界）、grep 不含 secret；正常 root 内 glob/grep 回归 OK。
- 回归：`npm run build && npm test` = **174/174**、`build` exit 0、`git diff --check` 干净。

## 风险控制
- 不大重构；常量集中（`src/tools/limits.ts`、config 上限、run_shell 常量）。
- `resolveInRoot` 保持同步签名（`realpathSync`），不改调用方。
- 不引入新依赖。
