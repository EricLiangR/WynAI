# Model Capability Profile v1

版本：`wynai.model-capability/v1`

## 目的

声明 Provider/Model 的上下文和输出能力，为平台预算计算提供配置输入。该档案不是对模型能力的盲目信任，平台仍需保留安全余量和硬门禁。

## 最低字段

- `provider`、`model`：能力档案的定位键；
- `contextWindowTokens`：模型总上下文窗口；
- `maxInputTokens`：平台允许使用的最大输入预算；
- `maxOutputTokens`：单次 JSON 输出预留；
- `safetyReserveTokens`、`protocolOverheadTokens`：安全余量和协议开销；
- `tokenEstimator`：估算器标识和版本；
- `supportsJson`、`supportsStreaming`：协议能力声明。

## 预算规则

```text
inputBudget = min(
  maxInputTokens,
  contextWindowTokens - outputReserve - safetyReserve - protocolOverhead,
  operationCap
)
```

未配置时采用平台保守默认值；配置值不得覆盖单条证据门禁、证据追溯和核心失败边界。

## 示例

```json
{
  "schema": "wynai.model-capability/v1",
  "provider": "dashscope",
  "model": "deepseek-v4-flash-0731",
  "contextWindowTokens": 32768,
  "maxInputTokens": 24576,
  "maxOutputTokens": 4096,
  "safetyReserveTokens": 2048,
  "protocolOverheadTokens": 1024,
  "supportsJson": true,
  "supportsStreaming": false,
  "tokenEstimator": "conservative-json"
}
```

## 约束

- 不能根据一次成功请求推断上下文窗口；
- 不能因为上下文窗口更大就把完整行数据重复放入 Planner、Critic 和 Narrator；
- 估算器应优先使用模型 tokenizer，暂不可用时才使用保守 JSON 字符估算；
- 每次运行必须记录档案版本、预算来源、估算器和最终输入估算。
