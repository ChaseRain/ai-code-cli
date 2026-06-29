# Exec Plan: Phase 4 — 质量硬化到 10 分

> 状态：implemented · 最后更新：2026-06-28
> 目标：不堆新能力，修掉评审会扣“完成度/工程质量”的真实边界问题。

## 背景

Phase-2/3 已把第一梯队功能和 memory 加分项落地，但评审若按成熟 CLI Agent 使用，会继续追问：

- `/diff <未跟踪文件>` 是否能看到新增内容，而不是只说“无 diff”。
- `run_shell` 写前预览是否准确展示将执行的命令。
- 大文件/二进制文件是否有保护，不把 TUI 刷爆。

这些是小而硬的质量点，适合本轮修到 10 分。

## 范围

| 能力 | 说明 | Spec |
|---|---|---|
| 未跟踪文件 diff | 指定未跟踪文本文件时展示 synthetic new-file diff；总览列出未跟踪文件 | [`../../product-specs/diff-git.md`](../../product-specs/diff-git.md) |
| shell preview 准确性 | `run_shell` preview 使用 `command` 参数 | [`../../product-specs/diff-git.md`](../../product-specs/diff-git.md) |
| 二进制/大文件保护 | 未跟踪二进制不展开；长文本受 `maxChars` 截断 | [`../../product-specs/diff-git.md`](../../product-specs/diff-git.md) |

## 验收矩阵

| # | 验收点 | 验证方式 |
|---|---|---|
| P4-A1 | `/diff untracked.txt` 显示 `new file` 与新增行统计 | `tests/diff-git.test.ts` |
| P4-A2 | `/diff` 总览在 tracked diff 后列出未跟踪文件 | `tests/diff-git.test.ts` |
| P4-A3 | 未跟踪二进制文件不展开内容 | `tests/diff-git.test.ts` |
| P4-A4 | `previewToolChange(..., 'run_shell', {command})` 展示真实命令 | `tests/diff-git.test.ts` |
| P4-A5 | `npm run build && npm test` 全绿；启动 TUI 验 `/diff <untracked>` | 自动 + 手工 |

## 验收记录

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| 未跟踪文件 diff | `tests/diff-git.test.ts` | `/diff untracked.txt` 展示 `new file` 与新增行 |
| 未跟踪总览 | `tests/diff-git.test.ts` | `/diff` 总览列出 `?? new.txt` |
| 二进制保护 | `tests/diff-git.test.ts` | 未跟踪二进制仅展示 binary summary，不展开内容 |
| shell preview | `tests/diff-git.test.ts` | `run_shell` 使用 `command` 参数，显示真实命令 |
| 全量回归 | `npm run build && npm test` | build exit 0；**120/120** 通过 |
