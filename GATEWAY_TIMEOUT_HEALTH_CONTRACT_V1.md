# Gateway Timeout and Health Contract v1

版本：`wynai.llm-gateway/v1`

## 超时层级

| 层级 | 含义 | 结果 |
|---|---|---|
| connect | DNS/TCP/TLS 建连 | `LLM_CONNECT_TIMEOUT` 或真实网络错误 |
| responseHeader warning | 响应头软阈值，默认 15 秒 | 只产生 `gateway.slow`，不终止请求 |
| responseHeader hard | 响应头硬截止 | `LLM_RESPONSE_HEADER_TIMEOUT` |
| responseBody | 响应头后读取响应体的硬截止 | `LLM_RESPONSE_BODY_TIMEOUT` |
| total | 单次请求总截止 | `LLM_TIMEOUT` |
| caller | 调用方主动取消 | `REQUEST_ABORTED` |

仍采用同步 `fetch`；本契约不包含流式空闲超时。

## 配置

`LLM_RESPONSE_BODY_TIMEOUT_MS` 必须接入 exploration、intent 和所有洞察 operation policy。每次 attempt 记录 operation、phase、阈值、耗时、HTTP 状态、重试关系和最终错误码；API Key 不进入日志。

## 健康状态

`/api/health` 与 `/api/llm/health` 使用统一枚举：

`not_configured`、`not_checked`、`healthy`、`unhealthy`、`circuit_open`。

`/api/llm/health` 必须执行真实 JSON 探针；探针未执行前只能是 `not_checked`，不能宣称健康。健康响应同时提供用户可感知的 `totalDurationMs`、`totalBudgetMs`、重试次数和阶段策略。
