# Exec Plan: Phase 6 — 稳定性 / 压测硬化

> 状态：implemented（第一批 LH1-LH4/LH8 + 第二批 LH5-LH7 均已完成+测试+压测） · 最后更新：2026-06-28
> 暂停新产品功能，只做可靠性 / 容量 / 边界硬化。承接 Phase-5 现状 `npm run build && npm test` = 131/131。
> 规格：[`../../product-specs/load-hardening.md`](../../product-specs/load-hardening.md)。

## 目标
消除压测/评审暴露的可靠性边界问题：并发 checkpoint id 碰撞、run_shell 输出 OOM、Session Browser 全量阻塞、checkpoint 无资源预算。

## 风险输入（评审证据）
- **P0** checkpoint id = timestamp + 6 位 `Math.random`：20k 同毫秒约 8.8% 碰撞；并发 20 次 create 仅 1 个目录（无原子占位）。
- **P1** checkpoint 资源：5000 小文件 ~4.5s；20MB 单文件 RSS +40MB；逐文件 read/write/hash，无预算。
- **P1** Session Browser：20k 日志 `listSessions` ~4.9s，同步全量 readFileSync 阻塞 TUI。
- **P1** run_shell：stdout/stderr 字符串无限累积，结束才裁剪，可能 OOM。

## 第一批里程碑

- [x] **P6-1 Checkpoint ID 原子唯一性**（LH1/LH8）：`randomUUID` + `mkdir(recursive:false)` 原子占位 + EEXIST 重试。✅
- [x] **P6-2 run_shell 输出内存硬上限**（LH2）：`CappedBuffer` 边读边截断，超限丢弃 + 截断提示。✅
- [x] **P6-3 Session Browser limit/非阻塞**（LH3）：`listSessions(..,{limit})` 先选候选再读取；`/sessions` 默认 50。✅
- [x] **P6-4 Checkpoint 资源预算**（LH4）：单文件 5MiB / 总量 64MiB / 最大 2000 文件（默认值，可经 `CheckpointBudget` 注入小值测试），超限入 `excluded` 带原因。✅
  - 健壮性：`reserveDir` 成功后若后续出错，最小 try/catch 清理已占位目录后重抛原异常；坏目录（无 manifest）也被 `list()` 跳过（测试 P6-A6）。

## 验收矩阵

| # | 验收点 | 验证方式 |
|---|---|---|
| P6-A1 | 100 并发 create：100 fulfilled / 100 唯一 id / 100 目录 / manifest 齐全（固定时间） | tests/checkpoint.test.ts |
| P6-A2 | run_shell 大输出：返回长度受控 + 截断提示；stdout 与 stderr 各一例 | tests/tools.test.ts |
| P6-A3 | `listSessions(root, cur, {limit:50})` 只返回 50 且不读取全部日志（哨兵坏行不被解析） | tests/session-browser.test.ts |
| P6-A4 | 大文件超单文件上限不复制、excluded 带原因；超 maxFiles/totalBytes 可控跳过（用注入的极小 `CheckpointBudget` 低成本覆盖） | tests/checkpoint.test.ts（file too large / max files exceeded / snapshot budget exceeded 三类各一例） |
| P6-A6 | 坏 checkpoint 目录（无 manifest）不毒化 `list()`（跳过、不抛） | tests/checkpoint.test.ts |
| P6-A5 | 历史回归全绿 | `npm run build && npm test` |

## 压测记录（临时脚本对 `dist/`，2026-06-28）

- **C1 checkpoint 100 并发唯一性**：100 fulfilled / **100 唯一 id** / **100 目录**（修复前：并发 20 仅 1 个目录）。
- **C2 session 20,000 logs**：`{limit:50}` → 50 条 **~50ms**（vs 全量 20000 条 ~1055ms；修复前评审实测 ~4.9s）。约 20× 提速、不再阻塞 TUI。
- **C3 run_shell 大输出**：写 2,000,000 字符 → 返回 `content` 长度 **30011**（MAX_OUTPUT 30000 + 截断提示），含「输出过长已截断」，内存受控不 OOM。
- 回归（第一批时点）：`npm run build && npm test` = 139/139；**第二批后当前 = 148/148**、`build` exit 0、`git diff --check` 干净。

## 第二批里程碑（LH5-LH7，已完成）

- [x] **LH5 Git timeout + 输出上限**（`src/workspace/index.ts`）：`runGit` 带 timeout(10s)+maxBuffer(16MiB)，区分超时/溢出/错误；`/changes` 文件数 cap 500 + 截断标注；`/diff` 超时/溢出返回可见诊断（不静默干净）。✅
- [x] **LH6 Checkpoint list 分页/limit**（`src/checkpoint/index.ts` + workspace）：`list({limit})` 先候选后读 manifest + 轻量 `count()`；`/checkpoints` 默认 50 + 截断说明；status 用 `list({limit:1})`、undo-last 用 `list({limit:50})`。✅
- [x] **LH7 Session resume 大日志上限**（`src/session/browser.ts`/`session.ts`）：`summarizeLog` 先 stat 超 2MiB 跳过+warning；`resumeFrom` 超 8MiB 明确报错；`resolveSessionLog` 纯文件名快速路径。✅

## 第二批验收矩阵

| # | 验收点 | 验证方式 |
|---|---|---|
| P6-B1 | fake git 超时不阻塞，`/diff` 返回可见诊断（非「干净」） | tests/diff-git.test.ts（注入 fake git PATH） |
| P6-B2 | 大量 status 文件被 cap 到上限并标注「已截断」 | tests/diff-git.test.ts |
| P6-B3 | 大 diff 仍受控截断（已有 maxChars + git maxBuffer） | tests/diff-git.test.ts |
| P6-B4 | `list({limit:50})`：100+ checkpoint 只返回 50，坏目录不影响；无参兼容 | tests/checkpoint.test.ts |
| P6-B5 | `summarizeLog` 超大日志先 stat、不全量读、warnings>0 | tests/session-browser.test.ts |
| P6-B6 | `/resume`(resumeFrom) 超大 jsonl 明确报错不 OOM | tests/session.test.ts / memory |
| P6-B7 | `resolveSessionLog('latest'/id)` 文件名快速路径（不全量 summarize） | tests/session-browser.test.ts |
| P6-B8 | 历史回归全绿 | `npm run build && npm test` |

## 第二批修复小循环（验收复跑发现的缺口，2026-06-28）

- **R1 `/changes` status 失败静默**：`getWorkspaceStatus` 原用吞错的 `git()` 读 `status`，超时→空→显示「无变更」。
  修复：改用 `runGit`，失败时 `isGitRepo:true` + `statusWarning`（诊断），`formatWorkspaceStatus` 打印。测试断言诊断可见。
- **R3 `list({limit})` 被最新坏目录挤占**：原先「先 slice limit 个名字再读」，坏目录在前会顶替有效项（60+5 坏 → 只 45）。
  修复：按目录名倒序**逐个读 manifest，凑满 limit 个有效项即停**，坏目录跳过不占额。测试：5 个 `zzzz-bad-*` 在最前 + 60 合法 → limit:50 返回 50、无参返回 60。
- **R5 `/changes` raw 全量泄漏**：`changedFiles/untrackedFiles` 已 cap 500，但 `formatWorkspaceStatus` 仍把 `status.raw` 原样追加（2000 文件 → 2007 行、含 f2000.txt）。
  修复：`formatWorkspaceStatus` 对 raw 只打印前 500 行预览 + 截断提示。测试：fake git status 2000 文件 → 输出不含 f2000.txt、含「已截断」、行数受控。

## 第二批压测记录（临时脚本对 dist，2026-06-28）

- **D1 fake 慢 git**：fake git `diff` sleep 5s、`AICODE_GIT_TIMEOUT_MS=800` → `getWorkspaceDiff` **1366ms** 返回诊断「diff 不可用：git diff 超时（800ms）」，不阻塞、不静默干净。
- **D2 5000 checkpoint**：`list({limit:50})` → 50 条 **23ms**（vs 全量 5000 条 315ms）。约 14× 提速、不全量解析。
- **D3 20k session logs + 超大日志**：`resolveSessionLog('latest')` **31ms**（文件名快速路径，不解析）；`resumeFrom(9MiB)` 抛「会话日志过大（9437184 > 8388608 上限）」，不 OOM。
- 回归：`npm run build && npm test` = **148/148**、`build` exit 0、`git diff --check` 干净。

## 第一批·第二批 ⸺ 风险控制
- 不引入远端/分布式/数据库依赖；只本地工程硬化。
- 所有新行为有确定性测试，不依赖网络与真实时钟（用 fake timer / 注入）。
