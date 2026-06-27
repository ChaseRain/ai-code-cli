// src/provider/index.ts
// provider 模块的公共出口。上层只从这里导入实现，类型仍来自 core/types。

export {
  AnthropicProvider,
  toAnthropicBody,
  mapSSEEvent,
  type AnthropicProviderOptions,
} from './anthropic.js';
export {
  MockProvider,
  scriptText,
  scriptToolCall,
  type MockScript,
  type MockProviderOptions,
} from './mock.js';
