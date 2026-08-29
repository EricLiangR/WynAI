# 数据洞察平台稳健性增强需求、设计与 UAT

> 版本：1.0  
> 日期：2026-08-28（Asia/Shanghai）  
> 状态：已完成开发与 UAT（2026-08-28）

## 1. 背景与结论

真实问题“统计每月、各客户地区、客户省份、客户城市的订单金额、订单利润、客单价”成功返回 `1581 行 × 7 列`，但二次洞察因 Narrator 产生无法由证据证明的数字而整体失败。该问题不是问数计算错误，而是数据洞察在高维结果上的平台稳健性缺陷：Evidence Pack 过大、证据选择不够查询相关、数字校验全有或全无、失败没有分级降级、错误信息没有区分阶段。

本期目标是在不修改外部 `InsightInput v1` 的前提下，系统改造数据洞察内部生成流水线。

## 2. 目标与非目标

### 2.1 目标

- 为 Evidence Pack 建立结果复杂度评估、token 预算和覆盖率元数据。
- 只向 LLM 发送与用户问题和 Schema 相关的摘要证据，避免通用分组造成上下文膨胀。
- 对结构数字、业务数字、单位换算、日期和比例执行分层校验。
- 单条结论校验失败时隔离该结论，保留已通过内容。
- LLM 超时、上下文超限、输出不合法和证据不足时返回可用的确定性降级结果。
- 用明确错误码、阶段审计和用户可见状态区分失败原因。
- 保持 `rawRowsToLlm=false`、主体权限、脱敏、审计和现有 InsightInput v1 语义不变。

### 2.2 非目标

- 不把原始明细无限制发送给外部模型。
- 不把确定性降级结果伪装成 AI 生成结果。
- 不修改 Wyn 问数或独立问数的外部输入契约。
- 不引入新的认证产品或改变当前 8787 端口部署方式。

## 3. 目标架构

```text
InsightInput v1
  -> complexity classifier
  -> query-aware evidence compiler
  -> budget guard
  -> Planner (compact catalog)
  -> Critic (selected evidence)
  -> Narrator (validated evidence only)
  -> layered claim validator
  -> completed / degraded InsightDocument
```

### 3.1 结果复杂度

| 等级 | 判定参考 | 证据策略 |
| --- | --- | --- |
| scalar | 单值或单行低列数 | 保留完整标量证据 |
| compact | 维度不超过 2 且分组较少 | 保留完整趋势和分组 |
| high-cardinality | 维度超过 2、分组超过预算或交叉行数较大 | 分层 Top/Bottom、趋势、统计摘要和边界样本 |

本次 1581 行、四级维度结果必须进入 `high-cardinality`。

### 3.2 Evidence Pack v2 内部扩展

外部输入仍为 `InsightInput v1`，内部 Evidence Pack 增加：

```json
{
  "schema": "wynai.evidence-pack/v2",
  "budget": { "maxTokens": 20000, "estimatedTokens": 0, "withinBudget": true },
  "complexity": { "level": "high-cardinality", "rowCount": 1581, "dimensionCount": 4 },
  "coverage": { "sourceRows": 1581, "representedGroups": 0, "omittedGroups": 0, "reason": null },
  "policy": { "rawRowsToLlm": false }
}
```

证据选择规则：

1. 优先使用输入 Schema 的可见维度、指标、时间粒度和查询范围。
2. 时间趋势在合理周期数内完整保留。
3. 维度分组保留总览、Top/Bottom 和必要的父子层级摘要。
4. 高基数交叉分组只保留有限行，并显式标记 `resultLimited`、`totalGroups` 和省略原因。
5. 预算超限时先压缩证据，再调用模型；无法压缩到预算内时进入降级流程。

## 4. LLM 编排与校验

Planner 只接收紧凑目录和复杂度摘要；Critic 只接收 Planner 选择的证据；Narrator 只接收 Critic 判定可用的证据，避免同一大数组在多个 prompt 中重复传输。

证据校验分为：

- 结构数字：由 Schema、查询结构和系统元数据验证，例如“两个维度”“前三项”。
- 业务数字：必须绑定字段、实体、期间、聚合和证据 ID，并支持原值/展示值/万亿单位换算。
- 未验证数字：拒绝对应结论项，不能通过 `verificationRequired` 绕过；其余合规结论继续发布。

Narrator 输出采用逐项状态：`validated`、`rejected`、`verification-required`。最终文档只发布已验证项和明确标注的待核验项。

## 5. 结果状态和错误码

内部生成结果使用 `wynai.insight-generation-result/v1`：

```json
{
  "status": "completed | degraded | failed",
  "provider": "llm-orchestrated | deterministic-fallback",
  "warnings": [],
  "diagnostics": { "stage": "narrator", "reasonCode": "UNSUPPORTED_NUMBER" }
}
```

标准错误码：

| 错误码 | 含义 |
| --- | --- |
| `LLM_UPSTREAM_ERROR` | 外部模型返回错误 |
| `LLM_TIMEOUT` | 外部模型超时 |
| `LLM_CONTEXT_LIMIT` | 请求证据超过上下文预算 |
| `NARRATOR_SCHEMA_INVALID` | Narrator JSON 不符合协议 |
| `NARRATOR_UNSUPPORTED_CLAIM` | 结论包含无法证明的数字/实体/期间 |
| `EVIDENCE_INSUFFICIENT` | Critic 判断证据不足 |
| `DETERMINISTIC_DEGRADED` | 已使用确定性基础洞察 |

LLM 局部失败但仍有基础结果时返回 `200` 和 `status=degraded`；只有权限、输入或服务完全不可用时才返回 4xx/5xx。

## 6. 降级策略

- 仍展示结构化结果、完整度、规模、趋势摘要和质量提示。
- 使用 `buildLocalInsight` 或等价确定性引擎生成基础统计，不标记为 AI 洞察。
- 页面明确显示“已完成基础洞察，部分 AI 结论未通过证据校验”或对应原因。
- 保留重试入口，重试不得改变原始 InsightInput 的幂等身份。
- 失败运行和降级运行均写入 InsightRun、治理审计和阶段诊断。

## 7. 可观测性和安全

每次运行记录输入规模、复杂度、估算 token、被截断分组、阶段耗时、校验失败 token/evidenceId、重试次数、降级原因和 `rawRowsToLlm=false`。不记录 API Key，不把完整外部请求原文写入审计。

## 8. 实施范围

| 模块 | 改造内容 |
| --- | --- |
| `lib/data-insights/evidence-pack.mjs` | 复杂度、预算、查询相关证据选择、覆盖率 |
| `lib/data-insights/llm-orchestrator.mjs` | 分阶段上下文、分层校验、逐项隔离、错误码 |
| `server.mjs` | degraded 结果、错误分类、审计和响应契约 |
| `public/app.js` / `public/styles.css` | 状态、警告、重试和证据覆盖展示 |
| `schemas/` | Evidence Pack/生成结果内部 Schema |
| `test/` | 高维、超预算、幻觉数字、降级和回归测试 |
| 文档 | 需求、设计、进度、UAT 截图和缺陷台账 |

## 9. 验收标准

1. 本次 1581 行四级维度查询不再因单个数字校验失败而整体不可用。
2. Evidence Pack 在预算内，且不发送完整原始明细。
3. 无证据数字能定位到阶段、结论、token 和 evidence ID。
4. 已验证结论继续展示，失败结论被隔离并说明原因。
5. LLM 超时、上下文超限和模型错误均进入确定性降级。
6. 页面不再把本地证据校验错误显示成笼统的“项目 LLM 失败”。
7. 低维、标量、同比和现有 Wyn/独立问数路径无回归。
8. 自动化测试、8787 API 验证、桌面和 `390x844` 移动 UAT 全部通过。
9. UAT 至少保存高维成功/降级页面、错误状态、移动端布局、API 响应、运行审计和 token/覆盖率记录。

## 10. UAT 计划

| 用例 | 场景 | 预期 |
| --- | --- | --- |
| ROB-01 | 1581 行四级维度三指标 | 返回可用洞察或明确 degraded，不出现空白失败 |
| ROB-02 | Narrator 输出无证据数字 `2` | 只隔离违规结论，保留其他结论和原因 |
| ROB-03 | Evidence Pack 超预算 | 压缩或确定性降级，记录 `LLM_CONTEXT_LIMIT` |
| ROB-04 | 外部 LLM 超时 | 返回基础洞察，状态为 degraded，支持重试 |
| ROB-05 | 低维正常查询 | AI 洞察结构与现有行为一致 |
| ROB-06 | 桌面/移动页面 | 状态、警告、表格和按钮无重叠、无横向溢出 |

UAT 产物统一保存至 `test/uat-artifacts/data-insight-robustness-2026-08-28/`，并在 `DEVELOPMENT_PROGRESS_REPORT.md` 登记。

## 11. 实施结果与 UAT 结论

本轮 1-9 项任务已完成：Evidence Pack 复杂度/预算/覆盖率、查询相关证据压缩、Planner/Critic/Narrator 分阶段上下文、分层结论校验、逐项隔离、确定性降级、错误码/阶段审计、前端状态提示、内部生成结果 schema、自动化回归与真实浏览器验收均已落地。

### 自动化与服务验收

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm run check:insight` | 通过 |
| `npm test` | 233/233 通过 |
| 固定端口服务 | `http://127.0.0.1:8787/`，健康检查 connected |
| 高维真实问数 | 1581 行、7 字段，中文字段与中文年月保持一致 |
| Evidence Pack | 7219/20000 tokens，`high-cardinality`，`rawRowsToLlm=false` |
| 外部 LLM 正常 | 返回 `InsightDocument v1`，不再出现笼统失败 |
| 外部 LLM 不可用 | 返回 `status=degraded`，确定性基础洞察和可见原因均保留 |
| 响应式页面 | 1280x720、390x844 均无横向溢出 |

### UAT 证据

证据目录：`test/uat-artifacts/data-insight-robustness-2026-08-28/`

- `rob-01-high-dimensional.png`：高维智能问数结果与右侧数据洞察入口。
- `rob-02-completed-insight.png`：外部 LLM 正常时的 InsightDocument 结果。
- `rob-02-degraded-state.png`：移动端降级页面布局。
- `rob-02-degraded-visible.png`：桌面端模拟 `LLM_UPSTREAM_ERROR` 时可见的“基础洞察模式”与原因提示。
- `rob-03-mobile-390x844.png`：移动端结果页面，无横向溢出。
- `api-result.json`：标准输入、文档 block、审计状态和错误码摘要。
- `evidence-budget.json`：token 预算、复杂度、覆盖率和外发策略。
- `uat-results.json`：机器可读验收汇总。

首次 UAT 发现默认本地运行目录存在临时文件权限问题，已通过独立可写运行目录完成复测；该环境修正不改变业务接口和 `8787` 端口。开放缺陷：0。

## 12. 下一阶段需求与设计补充：阶段 A 业务下限可靠

### 12.1 需求目标

本阶段在现有稳健性基础上增加业务领域可靠性：每次洞察必须解析并绑定适用 Skill；先生成可核验的 Business Fact Pack，再调用 LLM；LLM 失败、超时或结论校验失败时，使用领域化确定性事实报告，不得退化为只有通用行数和均值的摘要。

### 12.2 Skill 约束

现有 Skill Registry/Governance 继续作为唯一 Skill 管理边界。Skill 增加或规范化以下可选字段：`insightMethods`、`requiredFacts`、`evidenceRequirements`、`fallbackNarrative`、`qualityThresholds`。未命中适用 Skill 时，运行记录 `skillRefs=[]` 并明确标记为通用分析，不得伪装成领域分析。

### 12.3 Fact Pack 业务契约

在现有 Evidence Pack 内部结构上补充业务事实层：`facts`（确定性业务事实）、`derivedMetrics`（公式、分子、分母、聚合口径和除零状态）、`methods`（分析方法和 Skill 方法标识）、`requiredFacts`（必需事实及满足状态）、`qualityGates`（范围、完整度、时间粒度、截断和证据覆盖门禁）和 `fallback`（降级报告事实、模板和原因）。LLM 只消费通过质量门禁的事实和证据，不直接计算业务数字。

### 12.4 销售事实引擎首期范围

首期销售 Skill 支持月度趋势、区域/省份/城市贡献、集中度、异常月份、订单金额、订单利润、订单数和客单价。客单价必须遵守 `SUM(订单金额) / DISTINCTCOUNT(订单编号)`，禁止对客单价直接求和。事实引擎输出每项事实的证据 ID、时间范围、维度范围和计算方法。

### 12.5 降级和质量门禁

领域降级结果状态为 `degraded`，提供事实、质量告警、限制和可执行建议模板，并明确 `provider=deterministic-fallback`。以下情况不得生成“已完成 AI 洞察”：无适用 Skill、必需事实缺失、数据范围未知、证据覆盖不足、LLM 超时或 Narrator 结论无法校验。

### 12.6 验收边界

阶段 A 使用平台 P1/关键 P2、模块 M2/关键 M3。必交证据包括 Skill 版本、Fact Pack、事实计算对照、LLM 正常/失败双路径、降级状态、审计记录、8787 API 响应和桌面/390x844 截图。UAT 详细规则统一引用 `PLATFORM_AND_MODULE_UAT_GOVERNANCE.md`，本文件不再重复定义平台级 UAT 总则。
