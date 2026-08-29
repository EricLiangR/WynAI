# LLM 平台诊断与修复报告（2026-08-29）

## 结论

本次数据洞察失败不是模型内容能力问题。故障分为两层：

1. 普通权限启动的 Node 进程访问 DashScope 的 TCP 443 被 Windows 以 `EACCES` 拒绝，原网关只显示 `fetch failed`，导致根因不可见。
2. 平台自带 LLM 健康探针启用了 `response_format=json_object`，但探针提示词没有包含字面量 `JSON`，DashScope 返回 400。该问题属于平台探针契约错误。

在允许出站 443 的运行权限下，修正探针后已验证 DashScope TCP、TLS 和模型 JSON 契约均可用：模型 `deepseek-v4-flash-0731`，健康探针延迟约 1.2 秒。

## 已完成修复

- `llm-gateway.mjs`
  - 保留 `TypeError -> AggregateError -> connect Error` 完整错误链，包括 `code`、`errno`、`address`、`port`、`syscall`。
  - Provider 熔断状态保存结构化底层错误，诊断日志不再只有 `fetch failed`。
  - 增加不发送业务数据的 DNS/TCP/TLS 诊断能力，暴露为 `gateway.diagnose()`。
  - 修正 `cacheKey: null` 语义，健康探针每次都会真实调用，不复用缓存。
  - 健康探针提示词显式包含 JSON，满足 DashScope `json_object` 契约。
- `server.mjs`
  - 增加 `GET /api/llm/health`：执行真实 JSON 探针，区分 `healthy`、`unhealthy`、`circuit-open`、`not-configured`。
  - 增加 `GET /api/llm/diagnostics`：只做 DNS/TCP/TLS 检查，不上传业务数据。
- `lib/llm/exploration-agent.mjs`
  - 修正独立客户端探针提示词，使其与 JSON 响应契约一致。
- 严格模式继续保持：LLM 失败只返回明确失败，不生成 deterministic fallback 或 degraded 伪洞察。

## 为什么脚本 UAT 看起来没有失败

- `npm test` 主要使用本地单测、mock transport 和确定性内核，不代表真实外部 LLM 可用。
- `uvt-live` 主要验证受控查询、结果和导出，不调用数据洞察的 Planner/Critic/Narrator 三阶段。
- 一些历史 UAT 只检查结果结构或 `llmConfigured`，没有检查真实请求、stage audit 或模型返回。
- 真实浏览器点击数据洞察会调用 `POST /api/data-insights/:id/generate`，必然经过真实网关，因此最能暴露外网、代理、超时和模型契约问题。
- `uvt-v2` 的严格路径已经出现过真实 LLM 失败；单 Provider 熔断后，后续用例会被 `LLM_CIRCUIT_OPEN` 短路，容易让报告看起来像业务断言问题。

## 当前运行要求

项目服务仍使用 `8787`。部署环境必须满足以下任一条件：

- 允许服务进程访问 Provider 的 HTTPS 443；或
- 提供可用 HTTPS 代理，并在服务运行环境中配置代理接入能力。

代码可以诊断和准确报告网络阻断，但不能绕过操作系统防火墙、沙箱或出口策略。上线前应先检查：

```text
GET /api/llm/diagnostics
GET /api/llm/health
```

只有 `/api/llm/health` 返回 `{"ok":true,"status":"healthy"}`，才应进行数据洞察业务 UAT。`/api/health` 中的 `connected` 只表示 Wyn 服务连接，不等价于 LLM 可用。

## 验证记录

- `npm test`：275 passed, 0 failed。
- `npm run check`：通过。
- 允许出站连接的运行实例：DNS、TCP、TLS 均通过，真实 JSON 探针 200。
- 普通权限运行实例：DNS 通过，TCP/TLS 被 `EACCES` 阻断，接口返回 `network-unreachable`，未产生降级洞察。
