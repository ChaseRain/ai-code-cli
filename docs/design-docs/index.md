# Design Docs — 目录

> 设计文档编目与验证状态。新增设计文档须在此登记一行。

## 设计方法：分层抽象（DDD，精炼版）

从整体到局部，**上一层不清晰就不进入下一层**：

```
① 用例 (use-cases.md)        ← 谁、想达成什么（业务）
② 领域 (domain-model.md)      ← 限界上下文 / 统一语言 / 聚合（边界优先）
③ 系统 (ARCHITECTURE.md)      ← 分层、目录边界、依赖规则、数据流
④ 编码 (src/ + product-specs) ← 接口与实现
```
时序图（flows.md）横跨各层，用于整体理解流程。

## 文档

| 文档 | 主题 | 抽象层 | 状态 | 最后更新 |
|---|---|---|---|---|
| [core-beliefs.md](core-beliefs.md) | 操作原则：仓库即记录系统 + Harness 工程五准则 | — | active | 2026-06-27 |
| [use-cases.md](use-cases.md) | 业务用例 + 用例图 | ① 用例 | active | 2026-06-27 |
| [domain-model.md](domain-model.md) | 限界上下文 / 统一语言 / 上下文映射 / 领域模型 | ② 领域 | active | 2026-06-27 |
| [flows.md](flows.md) | 关键流程时序图 | 跨层 | active | 2026-06-27 |

> 系统设计层在仓库根 [`ARCHITECTURE.md`](../../ARCHITECTURE.md)；功能规格在 [`../product-specs/`](../product-specs/index.md)。
> 状态取值：`active` / `draft` / `superseded` / `deprecated`。UML 源以 ```plantuml 内联于各文档（版本化、Agent 可读）。
