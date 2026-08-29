# 数据洞察平台级修复与 PC UAT 报告

日期：2026-08-29  
服务端口：`8787`  
验收级别：模块级 PC UAT（真实 LLM 链路 + 结果正文截图）

## 1. 验收对象

- 问数问题：过去五年，每个季度不同地区、不同商品类型的收入、利润情况
- 洞察 ID：`ins-d56c1c51-beca-43c7-8a61-6705dcd942fa`
- 运行 ID：`ir-80abe53a-ea61-4873-9cd4-4dd08fe841d3`
- 数据规模：728 行、5 字段、100% 完整
- 模型：`deepseek-v4-flash-0731`
- Provider：`llm-gateway` / `dashscope.aliyuncs.com`

## 2. 平台级修复内容

1. 统一证据目录纳入 `businessFacts.facts`，Planner/Critic/Narrator 使用同一证据 ID 集合，修复“有效业务事实被判不存在”。
2. 对发送给 LLM 的业务事实、证据目录和 Evidence Pack 做服务端压缩，并在调用前执行上下文预算检查，避免重复注入和超上下文。
3. 声明校验支持比例事实（`0~1` 转百分比）、下降/增长方向、四舍五入误差、阈值与范围表达。
4. 期间变化率证据的公式操作数、期间范围字段纳入可核验值集合，支持核验本期/前期金额和期间年份。
5. 支持分组贡献的单项占比和累计占比核验，行动建议必须与已接受的洞察证据关联。
6. 增加一次受控 Narrator 修订轮：首次稿存在不支持声明时重新生成；修订仍不通过则返回失败，禁止降级成功或静默放行。

## 3. 自动化验证

- `node --test test/insight-llm-orchestrator.test.mjs`：12/12 通过
- `node --test test/insight-llm-orchestrator.test.mjs test/data-insight-platform-hardening.test.mjs`：13/13 通过
- 新增覆盖：比例转百分比、下降率绝对值、阈值/范围、季度标签、分组占比、公式金额、证据期间年份、修订轮。

## 4. 真实运行结果

最终运行返回 `status=completed`，`diagnostics=null`，没有 `degraded` 或 fallback 文案。正文包含：

- 管理摘要：总销售额 `12,878,830.61`、总利润 `6,167,864.61`、毛利率 `47.89%`
- 关键发现：每年第二季度环比下降约 `46.43%`、`53.25%`、`49.85%`、`53.99%`；前三大地区销售额占比 `76.73%`；品类贡献差异
- 风险判断：区域集中度风险、季节性下降风险
- 行动建议：第二季度促销/客户激励、区域拓展、产品组合优化

Gateway 记录显示本次最终成功链路 Planner、Critic、Narrator 均 HTTP 200；无超时、无失败、无 fallback。首次稿出现不支持声明时使用了 1 次 `narrator-repair`，最终校验通过。

## 5. PC UAT 截图

截图分辨率：1280×720。截图中可见数据洞察工作台、真实 InsightDocument v1，以及管理摘要、关键发现、风险判断、行动建议内容：

[insight-result-pc-content-actions-1280x720.png](D:/工作计划/20251210-AIGC/WynAI/.uat-platform-repair-2026-08-29/insight-result-pc-content-actions-1280x720.png)

## 6. 验收结论

**通过。** 本次修复解决的是平台证据契约、声明语义校验和受控修订机制问题；真实 PC 页面已展示有业务意义的 LLM 洞察正文。严格模式保持生效，LLM 失败或证据不足时仍会明确失败，不生成降级洞察。

## 7. `ins-fb3d07dc-f0e` 复盘与复验

- 完整 ID：`ins-fb3d07dc-f0e1-4bf2-a407-a87b5c116d71`
- 首次失败分类：LLM 调用均成功，但 Narrator 声明校验失败（百分比/分组总额证据缺口）；随后发现 Critic 的局部 `insufficient` 被错误当成全局失败。
- 平台修复：贡献证据增加单项占比和总额；分组证据增加 measure/total；质量事实增加维度基数；修订请求携带具体 rejected claims；Critic 仅在没有任何 supported 假设时阻断，部分 supported 时保存带边界说明的正式洞察并创建 Explore follow-up。
- 最终运行：`status=completed`，`diagnostics=null`，文档 `business-insight` 已持久化，4 个正文块；Explore follow-up：`ir-e76ea04f-cbbf-49c8-a8a2-cf00710a2035`。
- Gateway：最终链路 9 次调用全部成功，失败/超时/重试/fallback 均为 0；模型 `deepseek-v4-flash-0731`，端点 `dashscope.aliyuncs.com`。
- PC UAT：通过，截图明确包含真实洞察正文：

[ins-fb3d07dc-pc-insight-content-1280x720.png](D:/工作计划/20251210-AIGC/WynAI/.uat-platform-repair-fb3d07dc-2026-08-29/ins-fb3d07dc-pc-insight-content-1280x720.png)
