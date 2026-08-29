# 智能问数构成占比与纠正型多轮状态机需求、设计和 UAT

> 状态：开发中  
> 日期：2026-08-27  
> 关联缺陷：`SEM-SHARE-001`、`CONV-CORRECTION-001`、`CLARIFY-TYPE-001`

## 1. 问题与目标

真实对话“去年各地区销售额的占比”被错误识别成“同比增长率计算对象不明确”；用户明确否定并重述“用饼图展示各地区销售额占比分布”后，系统仍重复原澄清。

本迭代目标不是增加销售关键词，而是建立跨数据集可复用的构成占比语义和纠正型多轮状态转换：

- 区分同比、环比、构成占比、Skill 公式和未知公式；
- 将构成占比编译为受控 QueryProgram，不由 LLM 生成任意公式；
- 识别用户否定、纠正和完整重述，废弃错误 pending 意图；
- 将用户明确图表要求保存在结构化意图中，并继续接受可读性与数据质量校验；
- 通过真实 Wyn 查询、浏览器操作、日志和截图验证最终体验。

## 2. 功能需求

### 2.1 构成占比语义

`QuestionSemanticFrame v2` 新增派生类型 `share-of-total`：

```json
{
  "type": "share-of-total",
  "sourceConcept": "revenue",
  "shareDimensionConcept": "region",
  "denominatorScope": "filtered-result",
  "alias": "revenue_share",
  "resultType": "percentage",
  "status": "resolved"
}
```

- “占比、份额、构成、比例分布”在同时存在指标与分组维度时归一为 `share-of-total`。
- 单指标、单分组维度时不得澄清。
- 多指标且占比对象不明确时，澄清必须引用“占比”，不得误称同比。
- 分母默认是应用用户筛选后的结果总体；不得跨越用户权限、数据集或筛选范围。
- 多维结果按非占比维度分区。例如“每年各地区销售额占比”在每个年份内分别合计为 100%。

### 2.2 受控计算

`QueryProgram v1` 新增 `derive-share-of-total`：

- 输入：一个已聚合指标别名、占比分组维度和分区别名；
- 计算：`当前分组值 / 同分区所有分组值合计`；
- 分母为 0 时返回空值并记录质量告警；
- 输出为 `derived-measure`、`percentage`；
- 仅为计算而查询的基础指标可在最终结果中隐藏。

### 2.3 可视化意图

- “饼图、环形图、柱形图、折线图、组合图、仅表格”进入结构化 `visualizationIntent`。
- 用户明确要求饼图时仍需通过完整、非负、低基数等数据适用性校验。
- `share-of-total` 百分比结果可作为饼图数值；完整明细继续保留表格。

### 2.4 纠正型状态转换

会话状态机区分：`resolve-slot`、`correction-replace`、`fresh-question`、`cancel`。

- 出现“理解错了、理解有问题、不是、我的意思是、应该是、纠正”等明确否定表达时，进入纠正判断。
- 纠正文本包含指标、维度或派生/图表要求等完整业务槽位时，清除旧 pending，单独规划纠正文本。
- 不得再使用“原问题 + 用户澄清”的字符串拼接保留已被否定的错误槽位。
- 纠正行为写入 `IntentPatch` 和运行 trace，便于完整复原。
- 纠正后若仍不完整，只询问当前真正未决槽位；不得重复已被用户否定的澄清。

## 3. 验收标准

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| UAT-SHARE-01 | 去年各地区销售额的占比 | 首轮直接返回；地区、销售额占比、去年范围正确 |
| UAT-SHARE-02 | 用饼图展示去年各地区销售额占比分布 | 返回饼图；各项非负且占比合计约 100% |
| UAT-SHARE-03 | 每年各地区销售额占比 | 每个年份内占比合计约 100% |
| UAT-SHARE-04 | 各商品类别利润份额 | 复用同一语义，不依赖“销售额”特例 |
| UAT-CLARIFY-01 | 多指标占比对象不明确 | 澄清“哪个指标的占比”，不得出现“同比增长率” |
| UAT-CORRECTION-01 | 错误澄清后用户完整纠正 | 一次纠正后返回结果，不重复原澄清 |
| UAT-CORRECTION-02 | 用户取消 | 清除 pending，保留已提交上下文 |
| UAT-CORRECTION-03 | 用户提出新问题 | 与旧 pending 隔离 |

## 4. 测试与 UAT 留痕

自动化覆盖语义帧、BusinessQueryIntent、QueryProgram、会话状态机、可视化选择和协议回归。真实 UAT 使用指定数据集、`http://127.0.0.1:8787`、真实 Wyn 查询，保存 API/日志摘要、DOM 断言和截图。

## 5. 实施结果

- `share-of-total` 已进入 QuestionSemanticFrame v2、BusinessQueryIntent v2、QueryProgram v1 和版本化 JSON Schema。
- 占比使用一次 Wyn 聚合查询，QueryProgram 在受控结果集内按分区计算；基数指标可作为内部依赖隐藏。
- `visualizationIntent` 已进入结构化意图；占比字段可作为饼图/环形图数值，仍执行完整性、非负和低基数校验。
- 纠正型多轮已实现 `correction-replace`：完整纠正文本独立规划，旧 pending 意图清除，并写入 `IntentPatch` 与 `clarification.corrected` 事件。
- 回答摘要改为使用可见指标名称，避免“订单金额占比、占比”重复文案。

## 6. 自动化测试结果

| 批次 | 结果 |
|---|---|
| 构成占比/纠正专项 | 7/7 通过 |
| 语义、会话、QueryProgram、可视化回归 | 53/53 通过 |
| 项目全量 `npm test` | 223/223 通过 |
| `npm run check` | 通过 |

## 7. 真实 Wyn 与浏览器 UAT

数据集：`2b445034-38fe-4350-9cab-b7684c28b5f8`；服务：`http://127.0.0.1:8787`；视口：1280×720。

| 用例 | 实际结果 | 状态 |
|---|---|---|
| UAT-SHARE-01 去年各地区销售额的占比 | 6 个地区；占比合计 1.000000；自动环形图；无 pending | 通过 |
| UAT-SHARE-02 明确要求饼图 | 图表类型 `pie`；数值字段 `revenue_share`；占比合计 1.000000 | 通过 |
| UAT-SHARE-03 多期间分区占比 | 每个年份分区分别合计 1.000000 | 通过 |
| UAT-CLARIFY-01 成交转化率未知口径 | 澄清真实术语；不出现同比/环比 | 通过 |
| UAT-CORRECTION-01 完整纠正 | 一轮内 `correction-replace` 收敛；pending 清空；不重复澄清 | 通过 |
| UAT-CORRECTION-02 日志复原 | `clarification.corrected` 记录前后问题和 transition | 通过 |
| UAT-UX-01 回答摘要 | 已修复重复“占比”文案 | 通过 |

截图证据：

- [首次占比结果](test/uat-artifacts/composition-share-correction-2026-08-27/01-share-result.png)
- [未知口径澄清](test/uat-artifacts/composition-share-correction-2026-08-27/02-clarification.png)
- [纠正后饼图结果](test/uat-artifacts/composition-share-correction-2026-08-27/03-corrected-result.png)
- [纠正后完整页面](test/uat-artifacts/composition-share-correction-2026-08-27/04-corrected-full.png)

日志证据：`data/operation-events/operation-event-d32e360f-77b5-4b97-9145-161628f8b4a9.json`，记录 `clarification.corrected`、旧问题、新问题和 `correction-replace`。

## 8. 缺陷闭环

| 编号 | 严重度 | 问题 | 修复 | 状态 |
|---|---|---|---|---|
| SEM-SHARE-001 | P1 | “占比”被当作未知公式/同比对象 | 新增受治理 `share-of-total` 与分区计算 | 已关闭 |
| CLARIFY-TYPE-001 | P1 | 未知公式澄清固定称同比 | 澄清引用实际术语并区分派生类型 | 已关闭 |
| CONV-CORRECTION-001 | P1 | 用户纠正后仍拼接旧问题，重复澄清 | `correction-replace` 清除旧 pending 后独立规划 | 已关闭 |
| UAT-TEXT-001 | P2 | 占比回答摘要重复后缀 | 摘要改用可见 `displayRequest.measures` | 已关闭 |
| UAT-ENV-001 | P2 | 受限进程不能写会话目录导致真实 API UAT EPERM | 以工作区正常权限运行 8787；复验通过 | 已关闭 |


## 9. 平台化方案覆盖与 2026-08-28 增量验收

本轮不是新增一条独立执行链路，而是在既有会话接收、Skills 解析、Canonical Query、Wyn 查询、结果校验和 InsightDocument 渲染链路上增加统一展示规划层。`wynai.result-presentation-plan/v1` 作为跨模块中间协议，记录可见维度、指标、表格列、图表绑定、优先级、可读性原因和查询投影；既有 `BusinessQueryIntent v2`、`QueryProgram v1`、`InsightDocument v1` 继续复用。

| 九点平台提案 | 本轮落实 | 状态 |
|---|---|---|
| 1. 整体平台链路增强 | 会话链路增加 `presentation.planned`，不改变 Wyn 权限和查询适配边界 | 已完成 |
| 2. 统一中间模型/版本管理 | `wynai.result-presentation-plan/v1` Schema、运行时协议登记和文档契约 | 已完成 |
| 3. 语义理解与多轮状态机 | 时间比较语义修复；多轮仍由 pending/committed 状态机承载 | 已完成 |
| 4. Wyn 查询与权限继承 | 真实数据集一次多维聚合；查询仍走 Wyn 适配器和原有身份边界 | 已验证（管理员） |
| 5. 结果展示规划 | 原始指标+派生占比并列；按维度/指标/基数自动 chart-and-table 或 table-only | 已完成 |
| 6. Skills 与语义治理 | 占比、公式和时间语义由 approved Skill/确定性编译器治理 | 已完成（基础版） |
| 7. 跨行业评测 | 既有销售/实验室/零售评测包继续复用，本轮增加构成和高复杂度场景 | 已完成（基础版） |
| 8. 日志、反馈与持续改进 | trace 事件包含规划、查询、校验、展示决策和结果行数；可回放 | 已完成 |
| 9. 平台化测试与 UAT | 自动化回归 + 真实 Wyn API + 浏览器 DOM/截图 + trace 交叉核验 | 已完成 |

### 9.1 本轮真实 UAT

- 服务：`http://127.0.0.1:8787`
- 数据集：`2b445034-38fe-4350-9cab-b7684c28b5f8`
- 自动化门禁：`npm test` 228/228；`npm run check` 通过。
- 截图和结构化证据：`test/uat-artifacts/presentation-plan-2026-08-28/uat-results.json`。
- 截图：`01-share-original-and-chart.png`、`02-profit-share-combo.png`、`03-multi-period-share.png`、`04-multidim-table-pagination.png`。
- 结果：4/4 通过；开放缺陷 0。多维场景实际返回 728 行、前端第 1/8 页，未生成误导性图表；多期间占比按年份分别归一并保留原始销售额。

### 9.2 时间语义兼容修复

“多年度范围 + 分别/各自比较”现在会形成显式年度分组并进入结果覆盖校验；单年度“各自是多少”仍不会凭空增加年度维度。该修复补充了 `time-semantics` 回归用例，避免为兼容旧意图而牺牲当前平台语义。