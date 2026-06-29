---
name: commit-message
description: 根据暂存区改动生成符合 Conventional Commits 规范的提交信息
---

# 生成提交信息

当用户要求「写提交信息 / 生成 commit message」时，按下面流程产出一条规范的提交信息。

## 步骤

1. 用 `run_shell` 执行 `git diff --staged --stat` 与 `git diff --staged`，查看本次暂存的改动。
   - 若暂存区为空，提示用户先 `git add`，不要凭空编造。
2. 判断改动类型，选用合适的 type 前缀（Conventional Commits）：
   - `feat` 新功能、`fix` 修复、`docs` 文档、`refactor` 重构、`test` 测试、
     `chore` 杂项、`perf` 性能、`style` 格式、`build` 构建、`ci` 流水线。
3. 用一行祈使句概括「做了什么」，控制在 50 字符内，必要时另起空行写正文说明「为什么」。

## 输出格式

```
<type>(<可选 scope>): <简短描述>

<可选正文：动机、影响、注意事项>
```

## 约束

- 描述聚焦本次改动，不要泛泛而谈；不要把不相关的文件揉进同一条信息。
- 不自动执行 `git commit`——把生成的信息给用户确认后，由用户或在用户明确同意时再提交。
