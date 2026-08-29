# 数据洞察平台加固实施与严格 UAT 报告

日期：2026-08-28  
服务：`http://127.0.0.1:8787`

## 目标

针对 `ins-85dc529f-e5a` 暴露的指标语义丢失、非可加指标错误求和、Skill 未命中、日期数字误判、Narrator 整段淘汰、Critic 状态矛盾和 Explore 越界问题完成平台级修复。

## 已交付

- `InsightInput v1` 字段契约扩展：`metricId`、`aggregation`、`semanticType`、`additivity`、`derivedFrom`、`formula`、`calculationScope`、`isPreAggregated`。
- Evidence Pack：保留指标语义；非可加/派生指标禁止 `sum`；新增空值率、期间变化率等确定性证据。
- Wyn 与独立问数适配器：传播指标语义；Wyn 对比率字段标记为 non-additive；独立问数保留中文显示名。
- Skill：Skill 解析合并原始问题、上下文问题和洞察提示，避免通用提示覆盖业务触发词。
- Claim 验证：日期中的年/月/日不再作为独立数字；记录每个 Claim 的 token、证据候选、支持状态和失败原因。
- Critic：全部 assessments 为 `supported` 时自动规范为 `sufficient` 并记录 normalization。
- Explore：自动 Explore 继承原始过滤条件和时间范围，不再默认扩大到全量数据集。

## 测试结果

- `npm test`：最终严格复核 265/265 通过（早期基线记录仍保留在历史章节）。
- 平台加固专项：3/3 通过。
- 数据洞察、Evidence、编排回归：24/24 通过。
- `npm run check:insight`：通过。

## 严格 UAT

### 平台 P2

- 8787 健康检查：HTTP 200；Wyn 服务连接正常；主 LLM Gateway 已配置。
- `/api/data-insights`：HTTP 200，可返回标准输入目录和 30 条结果。
- 浏览器页面可进入“数据洞察”，显示标准输入、结果集数量、中文字段、完整度和“开始洞察”按钮。

### 异常/范围 P3

- 通过 UAT 标准输入提交并获得 `insightId`、`runId`。
- 诊断接口返回未脱敏 `input.accepted`、`run.created` 事件，Skill 引用包含 `sales-baseline@1.3.0`。
- 实际 LLM 链路完成 Planner/Critic/Narrator（Planner 7.9s、Critic 8.3s、Narrator 10.3s）；3 次调用全部成功、无超时/重试。Claim 失败只隔离 1 条违规项并保留四个完整栏目，状态如实标记 `degraded`。
- 当前主 Provider 无备用 Provider，网关仍保持单 Provider 明确状态，不伪造备用切换。

### 数据洞察模块 M3

- 结果列表可选择历史标准输入并展开结构化结果预览。
- 桌面端 1280×720 和移动端 390×844 均可见洞察入口与结果状态，无布局溢出。
- 洞察文档保留管理摘要、关键发现、风险判断、行动建议及 evidenceIds。

## 截图证据

- [桌面端数据洞察入口](/D:/工作计划/20251210-AIGC/WynAI/uat-final-desktop-1280x720.png)
- [移动端数据洞察入口](/D:/工作计划/20251210-AIGC/WynAI/uat-final-mobile-390x844.png)
- [桌面端结果预览](/D:/工作计划/20251210-AIGC/WynAI/uat-final-desktop-result-1280x720.png)
- [移动端结果预览](/D:/工作计划/20251210-AIGC/WynAI/uat-final-mobile-result-390x844.png)

## Skill 说明

本轮未修改 `skills/sales/skill.json` 内容；平台通过组合问题文本修复 Skill 命中，并在协议层新增语义承载字段。后续若销售业务需要更细的异常/归因规则，再单独升级 Skill 版本。

## 遗留风险

真实外部 LLM 仍可能因网络、Provider 限流或上游返回格式导致失败；平台会保留完整诊断并禁止生成确定性降级洞察。当前环境未配置备用 Provider，因此无法验证跨 Provider 故障切换。

## 后续策略修正

本报告早期版本曾将“降级提示可见”描述为数据洞察通过。经复核，该结论只适用于平台容错验收，不代表业务洞察质量通过。2026-08-28 后续改造已关闭用户可见的 `deterministic-fallback` 路径：LLM 失败、证据不足或 Claim 校验失败均返回 `failed`，不保存可展示洞察文档。

## 严格禁止降级实施复核

本轮按“业务质量优先”重新执行验收，验收级别为：模块 M3 + 平台 P2（成功/失败链路）和异常范围 P3。

- 回归测试：`npm test` 261/261 通过；`npm run check:insight` 通过；`git diff --check` 通过。
- 生产运行实例：`http://127.0.0.1:8787`，健康检查 HTTP 200，主 Provider 为已配置的 `deepseek-v4-flash-0731`，无备用 Provider。
- 真实失败链路：对标准输入 `ins-22676e25-1ef5-4961-ac5d-4762af50511f` 发起生成，返回 HTTP 502、`status: failed`、错误码 `LLM_UPSTREAM_ERROR`；运行记录为 `failed`；详情接口 `documentPresent=false`。页面显示“本次智能洞察未完成”和“重新生成”，未显示基础洞察。
- 契约失败链路：真实模型返回 Planner 非法证据引用时，页面返回 `status: failed`、错误码 `INSIGHT_LLM_INVALID_OUTPUT`，同样不保存文档。
- 成功链路：使用临时本地受控 Provider（仅用于 UAT，不接收外部真实数据）验证 Planner/Critic/Narrator 三阶段，HTTP 200、`status: completed`、`provider: llm-orchestrated`，生成“管理摘要 / 关键发现 / 风险判断 / 行动建议”四个栏目，四个栏目均带 evidence ID。
- 重试边界：重新生成开始时清空当前文档，保留历史版本；失败不会让旧洞察冒充本次结果，成功后再写入新版本。

### 本轮截图证据

- 成功链路桌面端（1280×720）：`.uat-strict-no-degrade-2026-08-28/insight-success-desktop-result-1280x720.png`
- 成功链路移动端（390×844）：`.uat-strict-no-degrade-2026-08-28/insight-success-mobile-conclusion-390x844.png`
- 失败链路桌面端（1280×720）：`.uat-strict-no-degrade-2026-08-28/insight-failure-desktop-1280x720.png`
- 失败链路移动端（390×844）：`.uat-strict-no-degrade-2026-08-28/insight-failure-mobile-390x844.png`

旧证据 `test/uat-artifacts/data-insight-robustness-2026-08-28/rob-02-degraded-visible.png` 的结论保持为：平台容错通过，但数据洞察业务质量不通过；它不再作为本轮严格模式的通过证据。
