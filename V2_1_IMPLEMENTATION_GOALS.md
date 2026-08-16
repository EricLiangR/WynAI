# V2.1 自主探索实施目标与验收计划

> 状态：Completed / Strict UAT Passed  
> 日期：2026-08-01  
> 关联需求：[PRODUCT_REQUIREMENTS_V2_1.md](./PRODUCT_REQUIREMENTS_V2_1.md)  
> 关联设计：[PRODUCT_DESIGN_V2_1.md](./PRODUCT_DESIGN_V2_1.md)  
> 完成证据：[UAT_V2_1_RESULTS.md](./UAT_V2_1_RESULTS.md)

## 1. 本轮目标

交付一个能够证明“不同问题产生不同分析路径，并可由结果触发下一轮查询”的 V2.1 纵向切片。首轮重点是闭环真实性，不以一次性实现所有高级算法为目标。

## 2. 可落地交付范围

### M1 文档与契约

- 修正 V2.0 已完成能力边界。
- 固化 V2.1 PRD、设计、目标和差异化 UAT。
- 定义 Planner、Critic、Finding 与审计字段。

退出条件：文档明确区分 AI 决策与确定性计算，且验收能够发现固定查询模板。

### M2 问题驱动 Planner

- 实现 Semantic Capability Profile。
- 实现 profitability、customer、product、anomaly、open 五类确定性降级规划。
- 接入受控 LLM Planner，验证并执行其 CanonicalQueryRequest。
- 只保留质量和概览两个系统探针。

退出条件：五类问题的探索查询集合不完全相同；非法 AI 计划被拒绝。

### M3 结果驱动 Critic

- 将标准结果摘要交给 Critic。
- 支持至少一轮 follow-up。
- 记录触发结果、原因、父假设、停止原因和预算。

退出条件：自动化测试证明 follow-up 来自第一轮结果，而非启动时预置。

### M4 动态 Finding 与呈现

- 按实际查询生成 Evidence、Finding 和 Chart。
- 报告和导出只展示本次实际产生的主题。
- 前端显示 Planner 模式、意图、实际查询目的和停止原因。

退出条件：利润、客户、产品场景的图表和章节结构存在可解释差异。

### M5 测试与 UAT

- 通过语法检查、单元测试、契约测试和 V1/V2 回归。
- 在真实 Wyn 与已配置 LLM 上执行五类问题。
- 运行安全、降级、持久化和导出验收。
- 输出 `UAT_V2_1_RESULTS.md`。

退出条件：所有阻断级用例通过；未通过项必须有真实原因和后续动作，不能以“图表已生成”代替验收。已完成 `14/14` 严格 UAT 和最新 `9/9` run 独立审计。

## 3. 量化门槛

| 指标 | 目标 |
| --- | --- |
| 明确意图覆盖 | profitability/customer/product/anomaly 4 类全部可识别 |
| 开放探索 | 不输入 focus 可生成多主题计划 |
| 不同问题查询集合完全相同 | 0 组 |
| AI 原始 SQL/WAX/Payload 接受数 | 0 |
| follow-up 触发来源可追溯 | 100% |
| 数值 Finding 证据覆盖率 | 100% |
| 图表 evidenceId 有效率 | 100% |
| 严格 UAT 中 fallback/partial 被拒绝 | 100% |
| 非严格体验中的降级状态透明 | 100% |
| 自动化测试 | 全部通过 |
| 真实 UAT 阻断用例 | 全部通过 |
| 最新业务 run 独立审计 | `9/9` 通过 |
| 受控阿里云 LLM 请求不含 Token/Key/完整明细 | `100%` |

## 4. 明确非目标

- 本轮不承诺完整 RFM、购物篮、预测和因果推断。
- 本轮不开放数据源 SQL。
- 本轮不把 Wyn 内部 Pivot Payload 暴露给 Planner。
- 本轮不以随机生成不同查询冒充自主探索；差异必须能由用户问题、语义能力或前轮结果解释。

## 5. 完成定义

代码、自动化测试、真实 Wyn/LLM UAT、动态导出和审计记录已全部达到上述门槛，状态为 Completed。后续功能迭代必须以本文件和 UAT 结果为回归基线。

## 6. 当前进度

M1—M5 已完成。当前自动化测试 `65/65` 通过，行覆盖率 `95.61%`；真实 UAT `14/14` 通过，最新 `9/9` run 审计通过。已修复查询口径、受限范围外推、空时间、报告降级、负时长误解读、日期数字误判和专项相关性问题。详细记录见 [UAT_V2_1_RESULTS.md](./UAT_V2_1_RESULTS.md)。
