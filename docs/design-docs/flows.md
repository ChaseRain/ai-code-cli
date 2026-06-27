# Design: 关键流程时序（从整体到局部）

> 状态：active · 最后更新：2026-06-27 · 抽象层：跨①用例 / ②领域 / ③系统
> 时序图用来**整体理解流程**：把 UC1（下达任务）落到限界上下文之间的协作。

## 主流程：一次任务的 Agent Loop（含权限分支）

覆盖「模型决策—工具调用—结果回传—继续推理」+ 只读直过 / 敏感需确认 / 拒绝入上下文。

```plantuml
@startuml flow-turn
skinparam shadowing false
actor "开发者" as Dev
participant "TUI" as TUI
participant "Agent 编排" as Loop
participant "Model Gateway" as Prov
participant "Authorization" as Perm
participant "Tooling" as Tool
database ".ai_history/logs" as Log

Dev -> TUI : 输入任务
TUI -> Loop : runAgent(task)
Loop -> Log : append(user)

loop 每轮 turn <= maxTurns
  Loop -> Prov : chat(messages, tools)
  Prov --> Loop : 流式 text / tool_calls
  Loop -> TUI : 增量渲染

  alt 无 tool_call（最终回复）
    Loop -> Log : append(assistant)
    Loop --> TUI : 完成
  else 有 tool_call
    Loop -> Log : append(assistant + tool_calls)
    loop 每个 tool_call
      alt 只读工具
        Loop -> Tool : execute(args)
      else 写 / 编辑 / Shell
        Loop -> Perm : check(tool)
        Perm -> TUI : 弹确认
        TUI --> Perm : 允许 / 拒绝
        alt 允许
          Perm --> Loop : allow
          Loop -> Tool : execute(args)
        else 拒绝
          Perm --> Loop : deny
          note right of Loop : 生成 denial 结果\n不执行工具
        end
      end
      Tool --> Loop : ToolResult
      Loop -> Log : append(tool result / denial)
    end
  end
end

note over Loop : 触顶 maxTurns 或 abort 则优雅收尾
@enduml
```

## 触发路径与终止
- **触发**：UC1（自然语言任务）。
- **终止**：无 tool_call（完成）/ 触顶 `maxTurns` / 用户中断(abort) / 致命错误。

## 相关
- 用例 → [`use-cases.md`](use-cases.md)
- 领域模型 → [`domain-model.md`](domain-model.md)
- 主循环规格 → [`../product-specs/agent-loop.md`](../product-specs/agent-loop.md)
- 权限规格 → [`../product-specs/permissions.md`](../product-specs/permissions.md)
