# 数据洞察能力覆盖增强：需求、设计与 UAT

## 1. 目标

将“用户请求的维度/指标”与调用方实际提供的结果集 Schema 做平台级匹配，避免单个字段缺失导致整项洞察失败，同时禁止 Planner 用未请求或不存在的字段替代用户问题。

本增强适用于 Wyn 问数、独立问数以及未来 API/MCP 调用，Skill 只负责声明业务方法边界，平台负责能力覆盖、执行状态和披露。

## 2. 能力覆盖契约

新增 `wynai.insight-capability-coverage/v1`，由平台根据用户问题和结果集字段生成：

- `requested`：用户明确提到的能力（时间、供应商、产品、销售额、利润等）；
- `available`：可由 Schema 字段支持的能力及实际字段；
- `unavailable`：请求了但缺少字段的能力，原因为 `missing-field`；
- `execution`：`full`、`partial`、`blocked` 或 `unclassified`；
- `canProceed`：是否允许继续编排。

平台只检查字段能力，不根据数据值推断缺失期间、业务稀疏或数据质量。

## 3. 执行规则

| 情况 | 处理 | 结果状态 |
|---|---|---|
| 所有明确请求能力可用 | 执行全部计划 | `completed` |
| 部分能力缺失，但仍有可执行能力 | 跳过依赖缺失能力的假设，继续其他核心/扩展分析，并披露未执行项 | `completed-partial` |
| 所有明确请求能力均缺失 | 不生成误导性替代洞察 | `needs_review`，接口层报告失败 |
| 未识别到明确能力 | 交由现有 Skill/Planner 处理 | 按现有规则 |

缺少“产品”字段时，供应商、类别、时间和指标分析仍可执行；产品粒度分析必须明确标记为未执行。不得将“产品类别”误识别为“产品”。

## 4. 代码设计

- `capability-coverage.mjs`：确定性能力识别和 Schema 匹配，支持中文显示名、源字段名、`metricId`、`semanticType`。
- `server.mjs`：在创建 SkillPlan 时生成能力覆盖，写入 Evidence Pack、编排结果和 InsightDocument；缺失项以警告 block 持久化。
- `lib/data-insights/llm-orchestrator.mjs`：将能力覆盖传入 Planner 上下文，要求 Planner 只使用可用能力；根据覆盖情况计算 `completed`、`completed-partial`、`needs_review`。
- 不改变现有 `InsightInput v1` 字段，不引入兼容旧协议；新增契约作为诊断和编排扩展字段。

## 5. 验收标准

1. 完整字段请求得到 `execution=full`，不增加未请求扩展。
2. 缺少产品字段时得到 `execution=partial`、`canProceed=true`，并保留其他可执行分析。
3. 所有明确请求能力缺失时得到 `execution=blocked`、`canProceed=false`，不返回伪造的替代洞察。
4. LLM 编排结果包含 `capabilityCoverage` 和 `PARTIAL_CAPABILITY_COVERAGE` 诊断。
5. InsightDocument 持久化“部分请求未执行”提示。
6. 原有 Planner/Critic/Narrator、证据校验和严格 LLM 规则回归通过。

## 6. UAT 记录

执行日期：2026-08-30

自动化 UAT 用例：

- 缺少产品字段的局部覆盖：通过；
- 所有请求能力缺失的整体阻断：通过；
- 编排结果返回 `completed-partial` 并披露缺失能力：通过；
- 原有洞察编排回归：通过。

验证命令：

```text
node --test test/insight-llm-orchestrator.test.mjs
npm run check:insight
```

浏览器 UAT 尚未执行。本次变更的浏览器验收重点是：提交包含“产品”但结果集没有产品列的问题后，页面应显示已有洞察内容，并显示“产品”未执行提示，而不是整页失败。
