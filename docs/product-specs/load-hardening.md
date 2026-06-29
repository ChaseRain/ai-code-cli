# Product Spec — 稳定性 / 压测硬化（Load Hardening）

> 状态：implemented（LH1-LH8 全部已实现+测试+压测） · 最后更新：2026-06-28
> 模块：`src/checkpoint/`、`src/session/browser.ts`、`src/tools/run-shell.ts`（+ Phase-6 后续）。

## 定位与「并发」的正确含义

本项目是**本地 TUI CLI**，不是共享服务端。所谓「20,000 并发」不是网络 QPS，而是落到本地工程的容量/边界压力：

- 大量本地实例 / 日志文件 / checkpoint 目录累积；
- 同一工作区被**多进程 / 多 tmux pane** 并发使用（同一秒内多次 checkpoint、多个会话日志）；
- 异常**大输出 / 大文件 / 大变更集**下不 OOM；
- 任何冲突**不静默覆盖**、不丢数据；
- 重操作**不长时间阻塞 TUI**（给上限/降级，而非全量同步扫描）。

## 本轮边界（不做）

- 不做远端队列 / 分布式锁 / 服务端水平扩展。
- 不引入数据库或外部存储。
- 只做**本地工程硬化**：原子文件操作、内存上限、容量预算、limit/降级。

## 验收矩阵

| # | 硬化点 | 契约 | 批次 |
|---|---|---|---|
| LH1 | Checkpoint ID 原子唯一性 | 高熵 id（`randomUUID`）+ `mkdir(recursive:false)` 原子占位 + `EEXIST` 重试；并发不碰撞、不静默覆盖、不返回同一 id | 第一批 ✅ |
| LH2 | run_shell 输出内存硬上限 | stdout/stderr 边读边截断，超 `MAX_OUTPUT` 后继续消费但丢弃；结果含「输出过长已截断」 | 第一批 ✅ |
| LH3 | Session Browser limit/非阻塞 | `listSessions(root, cur, {limit})`；先按文件名时间序选候选，只读取候选日志；`/sessions` 默认 50 | 第一批 ✅ |
| LH4 | Checkpoint 资源预算 | 单文件 / 总量 / 最大文件数上限；超限不复制、写入 `excluded` 且带可读原因；自动 checkpoint 跳过可审计 | 第一批 ✅ |
| LH5 | Git status/diff timeout 与输出上限 | 所有 git 调用带 `timeout` + `maxBuffer`；`/changes` 变更/未跟踪文件数有上限并标注「已截断」；**格式化输出（含 raw status 预览）也受控——不得泄漏 cap 之外的文件名，超限仅展示前 500 行 + 截断提示**；`/changes` 的 git status 超时/溢出/错误必须展示诊断，不静默显示成「无变更」；`/diff` 超时/输出过大返回用户可见诊断，不静默变「干净」 | 第二批 ✅ |
| LH6 | Checkpoint list 分页/limit | `list({limit})` 语义＝**尽量返回最近 limit 个有效 manifest**：按目录名（id 时间前缀可排序）倒序遍历、逐个读 manifest，凑满 limit 个有效项即停；**坏目录跳过且不挤占结果数量**（即便坏目录排在最前）。`/checkpoints` 默认 50 并标注截断；status/undo-last 不全量解析；默认无参兼容 | 第二批 ✅ |
| LH7 | Session resume 大日志上限与错误提示 | `summarizeLog` 先 stat，超上限不全量读（warning/跳过）；`/resume` 超大 jsonl 明确报错不 OOM；`resolveSessionLog('latest'\|id)` 走文件名快速路径，不全量 summarize | 第二批 ✅ |
| LH8 | 多进程/多 pane 同工作区并发 | checkpoint 原子目录 + 日志唯一文件名（见 session-context 日志唯一性）保证互不破坏 | 第一批（由 LH1 + 日志唯一性覆盖）✅ |

## 资源预算默认值（LH4，写入代码常量）

| 预算 | 默认 | 说明 |
|---|---|---|
| 单文件上限 | 5 MiB | 超过则不快照该文件，记入 excluded（原因：file too large） |
| 总快照字节上限 | 64 MiB | 累计达到上限后续文件跳过（原因：snapshot budget exceeded） |
| 最大文件数 | 2000 | 超过后续文件跳过（原因：max files exceeded） |

> 超预算的跳过项写进 manifest 的 `excluded`（可读 string，含原因），**自动 checkpoint 不得假装已保护**。

## 第二批资源上限默认值（LH5-LH7，写入代码常量）

| 上限 | 默认 | 说明 |
|---|---|---|
| git 调用超时 | 10s | `execFileSync` `timeout`；超时不阻塞，返回诊断 |
| git 输出上限 | 16 MiB | `execFileSync` `maxBuffer`；溢出返回诊断（diff 不静默变干净） |
| `/changes` 文件数上限 | 500（changed/untracked 各自） | 超过截断并标注「已截断」 |
| `/checkpoints` 默认展示 | 50 | `list({limit})`；超过标注截断 |
| `summarizeLog` 读取上限 | 2 MiB | 超过不全量读：给 warning + 标题提示「日志过大」 |
| `/resume` 日志上限 | 8 MiB | 超过明确报错（请用 /sessions 查看摘要），不 OOM |
> 预算默认值可经 `new CheckpointStore(root, budget)` 注入覆盖（便于以极小值低成本单测）。
> 健壮性：`reserveDir` 占位成功后若后续出错，最小 `try/catch` 清理已占位目录后重抛原异常；
> 即便残留无 manifest 的坏目录，`list()` 也会跳过、不抛（有测试覆盖）。

## 压测命令记录位置

专项压测以 one-liner / 临时脚本运行，结果记录在 [`../exec-plans/active/phase-6.md`](../exec-plans/active/phase-6.md) 的「压测记录」。
不新增常驻压测依赖；常规回归仍由 `npm test` 覆盖（确定性、不依赖网络）。

## 关联
- Checkpoint → [`checkpoint.md`](checkpoint.md)
- Session Browser → [`session-browser.md`](session-browser.md)
- 工具（run_shell）→ [`tools.md`](tools.md)
- 日志唯一性 → [`session-context.md`](session-context.md)
