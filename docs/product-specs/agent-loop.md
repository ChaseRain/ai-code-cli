# Spec: Agent Loop

> 状态：implemented · 最后更新：2026-06-27 · 模块：`src/agent/`（tests/agent-loop.test.ts 覆盖）

## 职责
编排 `决策→工具→结果→再决策`，只编排、不直接做 IO/渲染/HTTP。强制守护栏。

## 接口（草案）
```ts
interface AgentDeps { provider: Provider; tools: ToolRegistry; permission: Permission; session: Session; }
interface RunOpts { maxTurns: number; signal: AbortSignal; onEvent: (e: UIEvent) => void; }
function runAgent(input: string, deps: AgentDeps, opts: RunOpts): Promise<void>;
```

## 行为（伪码）
```
session.append(user, input)
for turn in 0..maxTurns:
  events = provider.chat(session.messages, tools.schemas, signal)
  累积: assistant 文本(流式 onEvent) 与 tool_calls
  if 无 tool_calls: session.append(assistant 文本); return        // 最终回复
  session.append(assistant 含 tool_calls)
  for tc in tool_calls:
     allowed = permission.check(tool[tc.name])      // 只读直过；写类弹确认
     result  = allowed ? tool.execute(tc.args) : { ok:false, error:'user denied permission' }
     session.append(tool, tc.id, result)            // 错误/拒绝同样入上下文
  // 继续下一轮
收尾('达到最大轮次上限') // 触顶
```

## 终止条件
无 tool_call（完成）/ 触顶 `maxTurns` / 用户中断(abort) / 致命错误。

## 验收（测试）
- MockProvider 驱动「文本 → tool_call → 结果 → 最终回复」完整一轮，断言消息序列正确。
- tool 结果被正确 append 并参与下一次请求。
- `maxTurns` 触顶时优雅收尾，不无限循环。
- abort 信号能中断在途请求。

## 不做（首期）
并行工具执行、子 Agent、上下文压缩。
