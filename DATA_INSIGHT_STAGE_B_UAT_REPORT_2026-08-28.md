# 数据洞察阶段 B：统一 LLM Gateway UAT 报告

> 日期：2026-08-28（Asia/Shanghai）  
> 服务：`http://127.0.0.1:8787/`  
> 验收基线：平台 `P1 + 关键链路 P2`，异常关键场景 `P3`；模块 `M2`。本次 1-4 优化增量验收：平台 `P1`；模块 `M1`

## 1. 结论

阶段 B 通过。统一 Gateway 已落地并覆盖探索编排、意图解析、Planner、Critic、Narrator 和严格分析报告路径。分阶段超时、有限重试、备用 Provider 路由、熔断、进程内缓存、统一错误码、状态快照和审计均已实现；当前生产环境配置了主 Provider，备用路由通过 fake fetch 专项验证。1-4 优化已修正响应头超时错误语义、取消统一 8 秒阈值，并加入指数退避与随机抖动。

## 2. 交付内容

| 内容 | 实现 | 结果 |
|---|---|---|
| Gateway | `llm-gateway.mjs` | 主/备用 Provider、超时、重试、熔断、缓存、metrics、snapshot |
| LLM 客户端 | `lib/llm/exploration-agent.mjs` | 支持 Gateway transport |
| 服务接入 | `server.mjs` | exploration、intent、严格 Agent Report 均统一经过 Gateway |
| 错误治理 | `server.mjs`、`lib/data-insights/insight-governance.mjs` | 超时、限流、空响应、熔断等可降级错误码和审计 |
| 文档 | `DATA_INSIGHT_STAGE_B_LLM_GATEWAY_REQUIREMENTS_DESIGN.md` | 需求、设计、配置、边界、验收已记录 |

## 3. 自动化验证

- `npm run check`：通过，包含 `node --check llm-gateway.mjs`。
- `npm run check:insight`：通过。
- `npm test`：当前 245/246；唯一失败为既有 `wax-query` 概览查询断言与生成器实际输出不一致，与 Gateway 改动无关。
- Gateway/诊断专项：13/13 通过，覆盖：主 Provider 成功、备用切换、429/5xx 重试、4xx 不重试、连续失败熔断、缓存命中、调用方取消、响应头/总请求/底层连接错误码、操作级时限、指数退避和退避取消。

## 4. 平台级 UAT

### P1：公共组件与异常策略

- `/api/health` 返回 `status=200`、`llmProvider=llm-gateway`、`version=wynai.llm-gateway/v1`。
- 健康状态暴露响应头、总请求和重试策略：通用总时限 25,000ms，默认响应头 15,000ms，洞察 Planner/Critic/Narrator 为 45,000/35,000/45,000ms，最多 2 次尝试，退避 250ms 起步并带 150ms 抖动上限。
- Provider 状态只暴露 id、模型、失败计数和错误码，不暴露 API Key、Prompt 或业务明细。
- fake fetch 已验证 429/5xx 重试、非 429 的 4xx 不重试、超时后备用、熔断和冷却状态。

### P2：标准输入到洞察结果链路

- `POST /api/data-insights/inputs` 成功注册标准输入：`insightId=ins-3066526b-bc75-4850-86a9-562e53327f85`、`runId=ir-660454ec-5dcb-422a-bf97-f76751505e4a`。
- `GET /api/data-insights/{insightId}` 重启后仍返回 `wynai.insight-input/v1`、3 行、4 字段、完整度 100% 和已生成文档。
- `POST /api/data-insights/{insightId}/generate` 真实 DashScope 调用返回 `provider=llm-orchestrated`、`status=completed`，Planner/Critic/Narrator 均完成。
- 生成审计记录包含模型、Skill refs、stageAudit、Gateway snapshot 和 `rawRowsToLlm=false`。

### P3：异常和降级关键场景

- Gateway 专项已验证超时、取消、空响应和熔断错误码；数据洞察治理将可恢复错误转为明确降级基础洞察。
- 本次合成输入触发的附属 Explore 因没有可执行的真实数据集查询而记录 `failed`，未伪装成功，不影响 Interpret 文档完成；这是输入边界的预期结果。

## 5. 模块级 UAT（M2）

- 数据洞察页面显示“外部大模型已连接”、标准输入、结构化结果、`InsightInput v1` 和 `InsightDocument v1`。
- 桌面 1280×720：结果标题、3 行数据、4 个字段、100% 完整度和二次洞察入口均可见。
- 移动 390×844：结果标题、质量卡片和外部大模型卡片可见，底部导航不遮挡内容。
- 两个视口 `scrollWidth <= viewport width`，控制台 error/warn 均为 0。

## 6. 证据

由于当前工作区 `test/uat-artifacts` 路径受重解析点写入限制，本批证据保存于：

- [api-uat-summary.json](D:/工作计划/20251210-AIGC/WynAI/uat-stage-b-2026-08-28/api-uat-summary.json)
- [browser-uat.json](D:/工作计划/20251210-AIGC/WynAI/uat-stage-b-2026-08-28/browser-uat.json)
- [module-insight-desktop-1280x720.png](D:/工作计划/20251210-AIGC/WynAI/uat-stage-b-2026-08-28/module-insight-desktop-1280x720.png)
- [module-insight-mobile-390x844.png](D:/工作计划/20251210-AIGC/WynAI/uat-stage-b-2026-08-28/module-insight-mobile-390x844.png)
- [platform-desktop-1280x720.png](D:/工作计划/20251210-AIGC/WynAI/uat-stage-b-2026-08-28/platform-desktop-1280x720.png)

## 7. 遗留项与后续

1. 当前 `.env.local` 未配置备用 Provider；备用切换逻辑已用 fake fetch 覆盖，生产切换需配置 `LLM_BACKUP_*` 并重新执行 P3。
2. 原生 fetch 不暴露 DNS/TCP/TLS 连接完成事件，`connectTimeoutMs` 作为策略配置和审计字段保留；只有底层明确返回 `UND_ERR_CONNECT_TIMEOUT` 才分类为 `LLM_CONNECT_TIMEOUT`，响应头等待使用 `LLM_RESPONSE_HEADER_TIMEOUT`。
3. Gateway metrics、熔断计数和缓存为单进程内状态，重启清零；生成审计持久化不受影响。
4. 阶段 C 再处理异步任务、跨进程状态、SLO 仪表盘和供应商级配额。

以上遗留项不构成阶段 B 的 P0/P1 阻断缺陷。
