# 数据洞察阶段 B：统一 LLM Gateway 需求与设计

> 版本：1.2
> 日期：2026-08-28（Asia/Shanghai）  
> 状态：阶段 B 已验收；平台化兼容迁移设计已补充，代码迁移待启动

## 1. 目标

为数据洞察、智能问数和未来平台能力提供唯一的进程内 LLM 调用治理入口，降低供应商网络抖动、超时、空响应、限流和非法 JSON 对用户链路的影响。阶段 B 不改变 `InsightInput v1`、`rawRowsToLlm=false`、`InsightDocument` 或 8787 服务端口。

## 2. 范围

### 2.1 本期交付

- 主 Provider 与可选备用 Provider；
- 单阶段总请求超时、首字节等待保护和调用方取消；
- 有限重试：默认最多 2 次，最多允许配置 4 次；429、5xx、网络失败、超时、空响应和非法 JSON 可重试；参数/权限等 4xx（429 除外）不重试；
- Provider 连续失败计数、熔断和冷却恢复；
- 按消息指纹的短 TTL 进程内缓存，不落盘、不跨进程共享；
- 统一错误码、Gateway metrics、Provider 状态和快照审计；
- Planner、Critic、Narrator、意图解析和严格分析报告全部通过 Gateway；
- 健康检查和数据洞察列表暴露脱敏 Gateway 状态。

### 2.2 不在本期

- 跨进程分布式缓存、队列和异步任务编排；
- 自动供应商计费/配额管理；
- 浏览器直连外部模型；
- 修改外部 LLM 的协议格式（当前使用 OpenAI-compatible chat completions）；
- 备用 Provider 的生产凭据配置。

## 3. 调用契约

调用方只提交结构化 messages 和可选的 `AbortSignal`、`maxOutputTokens`、`enableThinking`。Gateway 负责 Provider 地址、密钥、模型、超时、重试、熔断、缓存和 JSON 解码。调用方不得自行拼接外部 URL 或直接 `fetch` LLM。

统一错误码：

| 错误码 | 含义 | 默认动作 |
|---|---|---|
| `LLM_CONNECT_TIMEOUT` | 底层传输明确报告 DNS/TCP/TLS 连接超时 | 重试/备用 |
| `LLM_RESPONSE_HEADER_TIMEOUT` | 请求已发起但等待 HTTP 响应头超过阶段时限 | 重试/备用 |
| `LLM_TIMEOUT` | 单次总请求超过时限 | 重试/备用 |
| `LLM_RATE_LIMITED` | Provider 返回 429 | 重试/备用 |
| `LLM_UPSTREAM_ERROR` | Provider 返回 5xx | 重试/备用 |
| `LLM_REQUEST_FAILED` | 网络失败或不可重试 4xx | 仅网络失败重试 |
| `LLM_EMPTY_RESPONSE` | 响应无可用内容 | 重试/备用 |
| `NARRATOR_SCHEMA_INVALID` | 内容不是合法 JSON | 重试/备用 |
| `LLM_CIRCUIT_OPEN` | 所有候选 Provider 均熔断 | 进入降级/重试 |
| `REQUEST_ABORTED` | 调用方主动取消 | 不重试 |

## 4. 时限与可靠性基线

生产策略拆分为三个语义阶段：连接、响应头等待和单次总请求。原生 `fetch` 不暴露 DNS/TCP/TLS 的连接完成事件，因此 Gateway 只在底层明确返回 `UND_ERR_CONNECT_TIMEOUT` 时标记 `LLM_CONNECT_TIMEOUT`；不再把响应头等待误报为连接超时。响应头由独立计时器保护并返回 `LLM_RESPONSE_HEADER_TIMEOUT`，整个请求由总计时器保护并返回 `LLM_TIMEOUT`。

数据洞察不再统一使用 8 秒阈值：Planner 为 45/15 秒（总请求/响应头），Critic 为 35/12 秒，Narrator 为 45/15 秒，报告为 45/15 秒；探索、意图和探针也各自配置。Provider 明确返回错误时提前结束。参数、权限、证据不足和调用方取消不重试。

可恢复错误重试前执行指数退避和随机抖动：默认 `250ms * 2^(attempt-1)`，最大基础延迟 4000ms，再增加 0-149ms 抖动。退避可被调用方 `AbortSignal` 立即中断。当前没有第二 Provider 时仍可对同一 Provider 做有限重试，但不会计为 fallback。

## 5. 架构

```text
业务模块 / Insight Orchestrator / Agent Report
                    |
             createLlmGateway
        +-----------+------------+
        |           |            |
      cache     retry/fallback  circuit
        |           |            |
        +------ provider request
                    |
       primary Provider -> backup Provider
```

实现文件：`llm-gateway.mjs`。`lib/llm/exploration-agent.mjs` 接收可选 `transport`；服务端的 exploration、intent 和严格报告均注入 Gateway transport。Gateway snapshot 只包含 Provider id、模型、计数、错误码和时延，不包含 API Key、完整 Prompt 或业务明细。

### 5.1 平台化兼容约束

后续将 `createLlmGateway` 能力上收为 `Gateway Manager`，但不直接合并数据洞察和智能问数的业务策略。平台层统一 Provider、错误码、重试、熔断、缓存、诊断、审计和健康聚合；模块通过适配器保留操作级预算、Prompt 业务约束、编排顺序、失败语义和结果结构。

迁移必须先冻结 Gateway、Context、Evidence、Skill 和 Run Lifecycle 契约，再以兼容门面接入，确保数据洞察旧输入输出不变；随后执行新旧链路双跑，比较数值、权限、证据、状态和耗时；通过 `legacy/shadow/canary/platform` 灰度切换，并保留一键回滚和按模块隔离的 Provider/预算策略。元数据、Skill、权限、原始问题、当前意图和核心证据必须无损传递；上下文预算不足时必须澄清或失败，禁止静默截断。

## 6. 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 无 | 主 Provider |
| `LLM_BACKUP_BASE_URL` / `LLM_BACKUP_API_KEY` / `LLM_BACKUP_MODEL` | 无 | 可选备用 Provider |
| `LLM_TIMEOUT_MS` | 25000 | 通用探索阶段总时限 |
| `INTENT_LLM_TIMEOUT_MS` | 10000 | 意图解析总时限 |
| `LLM_CONNECT_TIMEOUT_MS` | 3000 | 连接等待策略记录 |
| `LLM_RESPONSE_HEADER_TIMEOUT_MS` | 15000 | 默认响应头等待保护；旧 `LLM_FIRST_BYTE_TIMEOUT_MS` 仅作配置别名 |
| `LLM_INSIGHT_PLANNER_TIMEOUT_MS` | 45000 | 洞察 Planner 总时限 |
| `LLM_INSIGHT_CRITIC_TIMEOUT_MS` | 35000 | 洞察 Critic 总时限 |
| `LLM_INSIGHT_NARRATOR_TIMEOUT_MS` | 45000 | 洞察 Narrator 总时限 |
| `LLM_AGENT_REPORT_TIMEOUT_MS` | 45000 | 严格分析报告总时限 |
| `LLM_MAX_ATTEMPTS` | 2 | 最大尝试次数，代码上限 4 |
| `LLM_RETRY_BASE_DELAY_MS` | 250 | 首次重试基础延迟 |
| `LLM_RETRY_MAX_DELAY_MS` | 4000 | 指数退避基础延迟上限 |
| `LLM_RETRY_JITTER_MS` | 150 | 每次重试随机抖动上限 |
| `LLM_CIRCUIT_FAILURE_THRESHOLD` | 3 | 连续失败阈值 |
| `LLM_CIRCUIT_COOLDOWN_MS` | 30000 | 熔断冷却 |
| `LLM_CACHE_TTL_MS` | 30000 | 进程内缓存 TTL，0 表示关闭 |

## 7. 降级与审计

LLM Gateway 错误由数据洞察治理层映射为 `degraded` 或 `failed`。确定性事实和证据仍可返回，但必须明确显示“基础洞察/待重试”，不得把降级结果标记为完整 AI 洞察。每次生成审计保留 `gateway` 快照、错误码、阶段审计、模型、Skill 引用和 `rawRowsToLlm=false`。

## 8. 测试与验收

自动化专项位于根目录 `llm-gateway.test.mjs`，覆盖成功、备用切换、429/5xx 重试、4xx 不重试、熔断、缓存、取消、空响应，以及连接/响应头/总请求错误码、操作级时限、指数退避、抖动配置和退避取消。1-4 优化采用平台 P1 + 模块 M1：本期没有 UI 变化，不重复截图型 UAT；必须通过 Gateway 专项、诊断日志专项、静态检查和 8787 健康策略核对。

平台化迁移不适用“无 UI 变化即可不截图”的简化规则。只要数据洞察结果、状态、错误或用户可见内容可能变化，必须执行平台 P2/P3 和数据洞察 M2/M3 对比验收，并保存旧链路、新链路、结构化差异、trace、审计及 PC/移动端截图。

## 9. 风险与后续

- 备用 Provider 只有在部署环境配置凭据后才真正生效；专项测试使用 fake fetch 验证路由逻辑。
- 当前 Gateway 为单进程状态，服务重启会清空缓存、熔断计数和 metrics；审计记录仍持久化。
- 阶段 C 再评估异步任务、跨进程状态、SLO 仪表盘和供应商级配额。
