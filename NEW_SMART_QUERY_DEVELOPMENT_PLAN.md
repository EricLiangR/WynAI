# 新智能问数项目需求与开发计划

> 2026-09-20 P0 执行边界实施状态：结果契约、QueryProgram v2、派生白名单、统一 Guard、WAX 源端结果筛选、完整性阻断和执行责任账本已落地；自动化测试通过；真实浏览器 UAT-AY-001～020 已逐题截图验收，20/20 符合预期。时间粒度服务端表达尚未确认，当前严格阻断本地归并。

> 2026-09-20 时间权威防回归状态：平台级规范化、财年/日期复合约束校验和 8 类形态矩阵已完成，时间专项 24/24、`npm test` 487/487、`npm run check` 通过；AY-033 真实浏览器连续 5/5、AY-034 连续 3/3 以及 AY-032、AY-003、明确自然年、B-008 邻近回归均已截图验收通过。最后边界补丁后又复测了 AY-003、明确自然年和 AY-033，均未回归。

> 文档状态：Active implementation / Phase 0-4 首期能力已交付；Phase 3 可视化与意图规划性能增强已于 2026-08-25 完成；Phase 5 外部身份、向量库和分布式能力按依赖推进
> 
> 目标：在不依赖 Wyn AI 问数 API 的前提下，基于 Wyn 数据集、元数据和语义配置，建设独立的会话式智能问数能力。
> 
> 适用项目：WynAI

## 1. 需求理解

本项目不是重新建设数据存储或数据治理平台，而是在 Wyn 之上增加一层独立的问数产品能力：

1. Wyn 继续负责数据集、数据集权限、数据集语义配置和数据查询执行。
2. WynAI 负责自然语言理解、对话上下文、Skills、查询规划、结果计算、证据绑定、页面结构编排和最终渲染。
3. 大模型不直接生成 SQL、WAX 或任意执行 Payload，而是输出项目统一、版本化的中间模型。
4. 查询结果不限制为单个图表，可以生成一个由指标、文本、图表、表格、筛选范围、口径说明、数据质量提示等组成的结构化分析页面。
5. 用户可以基于上一轮的问题、筛选条件、指标、维度、结果集和图表继续追问。
6. 第一阶段的 Skills 以结构化配置和本地知识文件为主，暂不引入向量数据库。

## 2. 当前项目基础与已知事实

当前项目已经具备以下可复用能力：

- 从 Wyn 文档搜索接口发现数据集；
- 读取数据集 `contentUrl` 中的数据集定义；
- 规范化 `Fields`、字段类型、字段角色、字段描述、`AIAssistantInfo`、`ColumnAssistantInfos`、字段同义词和聚合配置；
- 使用 `CanonicalQueryRequest` 描述平台无关的查询需求；
- 使用受控 WAX 适配器执行 Smart Query 的筛选、计数、投影、聚合、排序和排名；
- 仅在显式 `data-insight` 策略中使用 Dataset NONE 适配器执行受治理质量采样；
- 将不同查询适配器的结果转换为统一 `CanonicalResultSet`；
- 通过 Planner/Critic 进行多轮分析、追问和证据绑定；
- 使用 ECharts 和已有分析结构生成可视化结果。

当前仍依赖 Wyn AI 的主要路径是：

```text
POST /api/chat
  -> Wyn /api/v2/chat/analysis/queries
  -> Wyn 返回问数结果和视图
```

新系统需要增加独立的会话式问数编排路径，不能继续把 Wyn AI 返回的视图作为核心结果来源。

## 3. 可行性判断

### 3.1 总体结论

总体可行，且适合在现有项目上增量建设。查询安全边界、语义目录、查询路由和结果标准化已经存在，主要新增工作集中在：

- 独立的问数会话编排器；
- 项目级统一 LLM 交互契约；
- 多元素分析页面的结构化内容模型；
- Skills 和业务知识配置体系；
- 已验证 Wyn 查询接口的稳定接入和结果边界治理。

### 3.2 当前继续维护的前提

以下事项属于当前项目继续维护的能力范围：

1. 数据集定义接口是否完整返回层级、计算字段、同义词、默认聚合、业务描述、字段格式和 AI 分析配置。
2. 数据集查询接口对 WAX 和 NONE 的已纳入能力，包括聚合、分组、时间粒度、排序、过滤、字段比较、明细、统一 20,000 行上限和超时行为。
3. Wyn 返回的聚合结果是否存在排序、空值、日期格式、数字格式和时区差异。

### 3.3 权限和数据引擎边界

本项目不建设或验证 Wyn 用户权限穿透、行级权限代理、非索引数据集精确聚合和 Wyn 原生分页协议。Wyn 继续负责其既有权限和数据查询执行边界，WynAI 只对已接入的受控查询、结果契约和应用前端分页负责。上述取消项不作为开发任务、UAT 用例或发布门禁。

## 4. WAX 与 NONE 执行边界

当前查询层有两种重要模式：

### WAX 业务查询

- Wyn 在数据集侧执行筛选、计数、字段投影、聚合、分组、排序和排名；
- Smart Query 的标量、名单、明细、趋势、排名和分布查询全部使用该路径；
- 结果必须满足完整计数、非样本、非截断等结果契约；
- 超过 20,000 行或计数不一致时阻断，不允许切换到 NONE 或平台本地加工。

### NONE 质量采样

- NONE 是 Wyn 数据集 API 的原生能力，通常返回受 `RowLimit` 限制的原始行；
- 平台仅在显式 `data-insight` 策略下用于无筛选质量采样，并强制标记 `isSample=true`；
- Smart Query 策略禁止注册、执行或交付 NONE 结果；
- NONE 样本不得在平台本地执行用户业务筛选、聚合、排序或排名，也不得包装成业务答案。

因此，当前纳入范围的结果必须区分：

- **精确结果**：由 Wyn 服务端完整聚合得到；
- **受限样本**：只代表返回范围，不能外推全局；
- **无法回答**：当前查询能力不足以支持所需口径。

产品界面和最终答案必须披露结果范围、是否采样、是否截断和是否为估算。不能把样本计算结果伪装成完整数据集结果。非索引数据集精确聚合不属于当前项目范围。

## 5. 目标总体架构

```text
用户问题
  |
  v
Conversation API
  |
  +-- Conversation State / 历史结果引用 / 当前筛选上下文
  |
  +-- Skill Resolver / 数据集语义目录 / 用户知识
  |
  v
LLM Planner
  |
  v
统一 AIInteractionResponse v1
  |
  +-- 意图与澄清结果
  +-- CanonicalQueryRequest[]
  +-- 分析方法和展示意图
  |
  v
Schema Validator + Query Planner/Compiler
  |
  v
Query Router
  |
  +-- smart-query: Controlled WAX Adapter only
  +-- data-insight: Controlled WAX Adapter + governed Dataset NONE Adapter
  +-- 后续可增加其他受控适配器
  |
  v
Wyn Dataset Query API
  |
  v
CanonicalResultSet[]
  |
  +-- 确定性指标计算
  +-- Evidence / Provenance
  +-- 结果质量与范围判断
  +-- Chart Composer
  +-- InsightDocument Composer
  |
  v
结构化分析页面
```

大模型不能直接输出 HTML、JavaScript、ECharts 任意代码或 Wyn 原始 Payload。大模型可以提出页面布局意图和内容类型，但最终页面结构必须经过服务端 Schema 校验和确定性渲染。

## 6. 项目级统一交互模型

统一模型是本项目的核心接口，所有需要调用大模型的功能模块都应复用同一套协议族，而不是每个模块单独设计 Prompt 和返回格式。

### 6.1 协议族

建议拆为四个可独立版本化的模型：

1. `AIInteractionRequest`：发送给大模型的任务、语义目录、Skills、对话上下文和结果摘要。
2. `AIInteractionResponse`：大模型返回的意图、澄清、查询需求、分析方法和展示意图。
3. `CanonicalQueryRequest`：服务端实际执行的统一查询中间模型。
4. `InsightDocument`：最终面向前端的多元素分析页面模型。

它们之间的关系是：

```text
AIInteractionRequest
  -> LLM
AIInteractionResponse
  -> 校验、补全、编译
CanonicalQueryRequest
  -> Wyn
CanonicalResultSet
  -> 确定性计算与内容编排
InsightDocument
  -> 前端渲染
```

### 6.2 AIInteractionResponse v1 的建议结构

```json
{
  "schema": "wynai.ai-interaction/v1",
  "type": "query.plan",
  "status": "ok",
  "intent": {
    "name": "sales_trend",
    "confidence": 0.92,
    "summary": "查看指定期间的销售额趋势"
  },
  "clarification": null,
  "assumptions": [],
  "semanticRefs": {
    "datasetId": "dataset-id",
    "metrics": ["订单金额"],
    "dimensions": ["订购日期"]
  },
  "queryRequests": [],
  "analysisMethod": {
    "id": "time-series",
    "version": "1.0"
  },
  "presentationIntent": {
    "documentType": "analysis-page",
    "preferredBlocks": ["kpi", "text", "chart", "table"]
  },
  "followUp": {
    "enabled": true,
    "suggestions": []
  },
  "diagnostics": {
    "skillRefs": [],
    "semanticWarnings": []
  }
}
```

`queryRequests` 中只能出现 Canonical 查询字段，禁止出现 `sql`、`wax`、`query`、`payload`、`pivotPayload` 或 `adapter`。所有请求必须由服务端重新校验，必要时由受控编译器生成，而不是信任模型返回值。

### 6.3 InsightDocument v1 的建议结构

```json
{
  "schema": "wynai.insight-document/v1",
  "documentType": "analysis-page",
  "title": "销售额趋势分析",
  "scope": {
    "datasetId": "dataset-id",
    "filters": [],
    "timeRange": null,
    "accuracy": "exact",
    "isSample": false,
    "isTruncated": false
  },
  "blocks": [
    { "type": "kpi", "id": "kpi-total", "title": "销售额", "value": 123456 },
    { "type": "text", "id": "summary", "content": "...", "evidenceIds": [] },
    { "type": "chart", "id": "trend", "chartType": "line", "dataRef": "rs-query-1", "encoding": {} },
    { "type": "table", "id": "ranking", "dataRef": "rs-query-2", "columns": [] },
    { "type": "warning", "id": "scope-warning", "message": "..." }
  ],
  "evidence": [],
  "nextQuestions": []
}
```

初始支持的 Block 类型建议包括：`kpi`、`text`、`chart`、`table`、`filter-summary`、`metric-definition`、`warning`、`divider`。后续可以增加 `comparison`、`funnel`、`ranking`、`map` 等受控类型。

### 6.4 版本管理要求

- 每个协议必须带 `schema` 标识和版本号；
- Schema 采用兼容性规则，破坏性变更升级主版本；
- 服务端保存请求和响应的 Schema 版本；
- 每个版本有 JSON Schema、规范化器、拒绝原因和兼容转换器；
- 为 Planner、Critic、报告生成和页面编排分别建立固定 Fixture；
- 记录模型版本、Prompt 版本、Skill 版本和语义目录 revision；
- 升级时执行旧版本回放测试，确保历史运行仍可读取；
- 禁止以字符串解析方式判断模型意图，必须使用结构化 Schema 校验。

## 7. 多轮对话模型

会话状态不能只保存聊天文本，应保存结构化上下文：

```text
conversationId
datasetId / datasetRevision
activeMetrics
activeDimensions
activeFilters
activeTimeRange
previousResultSetIds
previousInsightDocumentId
confirmedMetricDefinitions
loadedSkillRefs
pendingClarification
```

需要支持的核心操作：

- 新问题；
- 继承上一轮指标或筛选；
- 修改筛选条件；
- 更换维度；
- 同比/环比/期间比较；
- 下钻和上卷；
- 解释原因；
- 查看明细；
- 重新计算或刷新数据；
- 导出当前分析页面。

如果问题存在多个合理解释，应返回 `status=needs_clarification`，而不是直接生成不确定的查询。

## 8. Skills 和知识体系（第一阶段不使用向量库）

第一阶段采用结构化、本地化和可审核的方式：

```text
skills/
  sales/
    skill.json
    metrics.json
    workflows.json
    examples.json
  laboratory/
    skill.json
    metrics.json
```

Skill 建议包含：

- `id`、`version`、`name`；
- 适用组织、用户、数据集和场景；
- 触发词和同义词；
- 指标定义、字段映射和默认聚合；
- 推荐的维度和筛选；
- 分析步骤和后续查询规则；
- 禁止误用的字段或口径；
- 示例问题和预期结果；
- 审核状态和变更记录。

优先级建议为：系统安全规则 > Wyn 数据集语义 > 数据集/组织 Skill > 用户 Skill > 当前对话补充。若 Skill 与数据集语义冲突，应提示并要求确认，不应静默覆盖数据集口径。

## 9. 分阶段开发计划

### Phase 0：Wyn 查询能力验证

当前状态：已完成当前范围。管理员 Token 下的指定销售数据集元数据、NONE、WAX 概览、客户/地区聚合和过滤矩阵已实测；权限穿透、非索引精确聚合和 Wyn 原生分页不属于当前计划。

目标：把所有外部依赖从“推断”变成“实测证据”。

工作项：

- 保存真实数据集定义样本并建立脱敏 Fixture；
- 验证 AI 开关、层级、字段描述、同义词、默认聚合、计算字段和格式是否返回；
- 建立查询能力矩阵：聚合、分组、时间粒度、排序、过滤、字段比较、明细、20,000 行上限、空值和截断；
- 记录 Wyn 版本、接口路径、请求参数和响应差异。

交付物：`WYN_API_CAPABILITY_MATRIX.md`、脱敏 API Fixture 和查询结果边界报告。

验收标准：任何产品能力都能追溯到已验证的 Wyn 接口能力；不能支持的能力明确标记为不支持或样本模式。

### Phase 1：统一交互协议与查询模型

当前状态：已完成首期。已落地 `lib/protocol/interaction-contract.mjs`、`AIInteractionRequest/Response v1`、`InsightDocument v1`、四份可复用 JSON Schema 和契约测试。

目标：建立项目级、版本化的大模型交互边界。

工作项：

- 定义 `AIInteractionRequest/Response v1`；
- 定义 `CanonicalQueryRequest v1` 的兼容策略；
- 定义 `InsightDocument v1`；
- 编写 JSON Schema、校验器、规范化器和错误模型；
- 为 Planner、Critic、报告和页面编排统一请求/响应日志；
- 建立协议 Fixture 和旧版本回放测试。

交付物：协议 Schema、TypeScript/JavaScript 类型定义、版本说明、契约测试。

### Phase 2：独立查询内核

当前状态：已完成首期。已落地结果范围 `limitReached`、`truncationConfidence`，并保留 `isTruncated` 兼容字段。

目标：不调用 Wyn AI，直接根据 Canonical 请求访问 Wyn 数据集接口。

工作项：

- 复用并完善 `QueryRouter`、WAX 和 NONE 适配器，并由显式执行策略隔离两者适用范围；
- 增加 exact/sample/truncated/estimated 结果范围标识；
- 增加查询缓存、超时、并发和预算控制；
- 增加字段、聚合、过滤、权限和数据集 revision 校验；
- 为每次查询保存 request、compiled plan、resultSet、provenance 和 evidence。

交付物：独立查询服务 API、查询审计记录、查询能力测试集。

### Phase 3：会话式问数 MVP

当前状态：基础链路完成，语义准确性增强中。已提供 `/api/smart-query/conversations` 会话创建和 `/messages` 连续问数接口，返回组合式 `InsightDocument v1`；但真实用户 UAT 已发现多年份、年度粒度和多轮时间范围存在语义丢失，当前有限规则 Planner 尚未达到原规划的 LLM 结构化规划与全问题族验收要求。增强范围、阶段和生产门槛见 `SMART_QUERY_SEMANTIC_ACCURACY_ENHANCEMENT_PLAN.md`。

目标：实现单数据集的连续问数和多元素分析页面。

工作项：

- 会话创建、恢复、清理和历史查询；
- 当前指标、维度、筛选和时间范围的结构化继承；
- Planner、澄清、查询执行和结果解释循环；
- 支持趋势、排名、比较、占比、下钻和明细预览；
- 生成 `InsightDocument`，前端渲染指标、文本、图表、表格和告警；
- 支持结果证据和口径展示。

交付物：独立问数 API、会话 UI、可复用页面 Block 组件、端到端验收场景。

Phase 3 的“接口、查询执行和页面可用”与“自然语言语义准确性通过”分别验收。少量固定句式或其他模块的 LLM UAT 通过，不能代表独立问数整体准确性通过；后者以版本化黄金问题集、显式约束保留、结果一致性和真实 Wyn 多轮 UAT 为准。

### Phase 4：Skills 第一阶段

当前状态：基础版已完成。已落地本地结构化 Skill Registry、递归加载、作用域解析、优先级排序、指标冲突澄清、Planner/Critic 注入、无 LLM 确定性指标口径，以及受保护的治理 API（草稿、审批、退役、回滚、版本列表和审计）；完整可视化管理界面和更复杂知识库待后续迭代。

目标：用可管理配置提升特定业务场景的问数准确性。

工作项：

- Skill Manifest、指标定义、场景流程和示例格式；
- Skill 加载、作用域、优先级和冲突检测；
- 数据集/组织/用户级 Skill 配置；
- Skill 版本、审核、回滚和运行记录；
- 以离线问题集评估字段识别、指标口径、查询选择和答案准确性。

明确不包含：向量库、复杂 RAG、自动从大量非结构化文档生成生产 Skill。

### Phase 5：生产化与高级能力

当前状态：已完成当前范围。本地 Skill 版本治理和智能问数请求主体上下文、会话访问控制、限流、跨进程请求审计已实现并通过自动化/UAT；Wyn 终端身份代理、双账号权限对照、非索引精确聚合不属于当前范围。

- 多数据集联合分析；
- 更复杂的计算指标和指标资产中心；
- 向量检索和文档知识库；
- 异步长查询、共享缓存和分布式运行存储；
- 完整身份认证、权限映射、审计和限流；
- 人工反馈闭环、回放评测和模型版本对比。

## 10. 测试与验收策略

### 契约测试

- 模型输出缺字段、未知字段、危险字段时拒绝；
- 不同协议版本可以正确转换或明确失败；
- 禁止 SQL/WAX/Payload 泄漏到 LLM 输出契约；
- 页面 Block 只能使用白名单类型和合法 ResultSet 引用。

### 查询测试

- 聚合结果与已纳入范围的 Wyn 查询结果逐项比对；
- 日期粒度、时区、空值、排序和截断测试；
- 精确结果、样本结果和估算结果边界测试；
- 结果范围、样本、截断和空结果测试。

### 对话测试

- “继续按区域看”“只看华东”“改成利润率”“为什么下降”等上下文追问；
- 模糊指标触发澄清；
- 会话恢复后上下文一致；
- 结果集过期或数据集 revision 变化时重新确认。

### 页面测试

- KPI、文本、图表、表格、口径和告警组合渲染；
- 空结果、截断、样本和权限拒绝状态；
- 页面不包含未绑定证据的数字；
- 导出和历史回放保持一致。

## 11. 主要风险与控制措施

| 风险 | 控制措施 |
| --- | --- |
| Wyn 权限由外部系统负责 | 本项目不修改或验证 Wyn 权限穿透，避免将管理员 UAT 外推为普通用户结论 |
| Wyn 元数据不完整 | 建立自有语义目录增量层，但保留 Wyn 原始 revision 和来源 |
| NONE 样本被误认为全量 | 强制 `accuracy`、`isSample`、`isTruncated` 字段，并在页面中展示范围 |
| 模型生成不可执行查询 | 统一中间模型、JSON Schema、字段白名单和确定性编译器 |
| Skill 覆盖真实数据口径 | 设定语义优先级、冲突检测和人工审核 |
| 多轮上下文漂移 | 保存结构化会话状态和 ResultSet 引用，不只依赖聊天文本 |
| 多元素页面出现无证据数字 | 所有数值绑定 evidenceId，渲染前做证据校验 |
| Wyn API 版本变化 | 能力矩阵、Fixture、版本探针和适配器隔离 |

## 12. 第一批需要确认的决策

1. Phase 0 使用哪一个或哪几个真实数据集作为验证样本。
2. 第一阶段是否只支持单数据集问数。
3. 第一阶段必须支持的指标类型：基础聚合、同比/环比、比率、排名、占比、明细中的哪些部分。
4. WynAI 当前服务端 Token 是否具备终端用户身份代理能力。
5. 首期 `InsightDocument` 的页面 Block 白名单。
6. Skill 首批落地的业务场景和指标范围。
7. 精确结果不可用时，产品是允许展示样本分析，还是直接要求用户缩小范围/更换数据集。

## 13. 建议的近期执行顺序

```text
1. 选定真实数据集和两类测试用户
2. 完成 Wyn 元数据、查询和权限能力矩阵
3. 固化 AIInteractionResponse v1、CanonicalQueryRequest v1、InsightDocument v1
4. 用真实 Wyn 结果校准 WAX/NONE 适配器和范围标识
5. 实现独立单轮问数
6. 增加会话状态和连续追问
7. 增加多元素 InsightDocument 页面
8. 引入第一批结构化 Skills
```

## 14. Phase 3-V：独立问数可视化增强

状态：已完成（2026-08-25）。详细需求与设计见 `SMART_QUERY_VISUALIZATION_REQUIREMENTS_AND_DESIGN.md`，截图验收见 `SMART_QUERY_VISUALIZATION_UAT_REPORT_2026-08-25.md`。

### 14.1 需求范围

- 放开“一个维度 + 一个指标才生成图表”的旧限制；
- 支持折线图、柱形图、横向条形图、饼图、环形图、组合图和堆叠柱形图；
- 建立分类、系列、数值三类图形编码；
- 支持自然语言指定图表、横轴、系列和指标 mark；
- 支持自动图表推荐、适用性校验、高基数限制和表格降级；
- 支持多轮图表修改和允许类型内的前端即时切换；
- 使用项目级、版本化 `VisualizationSpec v1`，禁止任意 ECharts/SQL/WAX Payload。

### 14.2 决策原则

1. 用户明确表达优先，但不能绕过数据适用性和完整性规则。
2. 时间维度优先作为分类；第二维度作为系列。
3. 两个非时间维度时，高基数维度作为分类，低基数维度作为系列。
4. 普通比较、排名、趋势、构成和混合量纲分别使用柱形、条形、折线、环形和双轴组合图。
5. 超过 2 个维度、3 个指标、50 个非时间类别或 120 个时间点时，保留表格而不生成误导图表。
6. 图表限制 TopN 或系列成员时，页面明确告知，并始终保留完整明细表。

### 14.3 交付和验收

- 协议与实现：`lib/visualization/visualization-spec.mjs`、`schemas/wynai.visualization-spec.v1.schema.json`；
- 会话与文档：`activeVisualization`、InsightDocument chart block；
- 前端：ECharts 白名单渲染、响应式 Canvas、图表即时切换；
- 自动化：全量 142/142；语法检查通过；
- 真实页面 UAT：11/11，包含多轮、高基数和 390x844 移动端；
- 缺陷：B-029 至 B-033 全部关闭。
## 15. Phase 3-P：意图规划性能与可靠性

状态：已完成（2026-08-25）。详细需求与设计见 SMART_QUERY_INTENT_LATENCY_REQUIREMENTS_AND_DESIGN.md，验收证据已合并到 DEVELOPMENT_PROGRESS_REPORT.md。

### 15.1 触发问题

复杂度较高但语义已经完整的问题仍强制调用大模型，三条真实请求分别等待约 180 秒。前端按定时器轮换的阶段说明又让用户误以为系统已经进入 Wyn 查询或回答组织阶段，实际服务仍在等待意图模型。

### 15.2 实施范围

1. 完整且通过覆盖校验的确定性意图走 deterministic-fast-path。
2. 意图规划使用独立 10 秒预算，不与 180 秒报告/探索预算共用。
3. 连续失败 2 次后熔断 60 秒，模糊问题回到受控澄清。
4. 浏览器取消传播到意图 LLM，取消审计状态为 499。
5. 响应和请求审计增加规划路径及耗时字段。
6. 页面等待文案改为可证明的通用状态，不再伪造具体阶段。
7. .env 示例和 Windows 部署模板同步新增 INTENT_LLM_TIMEOUT_MS。

### 15.3 验收门槛与结果

| 门槛 | 目标 | 实际 |
| --- | --- | --- |
| 完整意图 LLM 调用 | 0 次 | 0 次 |
| 确定性规划 | 小于 100ms | 7ms（API UAT），1-2ms（浏览器两轮审计） |
| 端到端 | 当前环境小于 3 秒 | 379ms；浏览器首轮服务端 318ms |
| 结果正确性 | 2021-2025、收入、同比、组合图 | 通过 |
| 多轮继承 | 只新增华东筛选 | 通过 |
| 自动化 | 全量通过 | 145/145 |
| 视觉 UAT | 回答、详情、图表、表格、上下文均可用 | 3 张 1280x720 截图通过 |

### 15.4 后续监控

生产环境继续按 plannerMode 统计 P50/P95/P99、LLM 尝试率、熔断次数和 499 取消率。若需展示真实“规划/查询/渲染”阶段，必须增加服务端事件流，不能恢复前端计时器推测。
## 16. Phase 3-R 风险分级与受控学习（2026-08-25）

新增七项持续增强需求：统一风险模型、分级 LLM 路由、双重校验、端到端日志回放、用户反馈学习、跨行业 Skill 治理和领域评测体系。详细需求、角色边界、API 和验收标准见 SMART_QUERY_RISK_ROUTING_LEARNING_REQUIREMENTS_AND_DESIGN.md。

本阶段坚持“反馈形成候选、审批后才能发布”：普通用户纠正不会自动修改生产 Skill；实验室与零售已建立独立 Skill 和草稿评测包，黄金答案仍需对应业务负责人确认。

## 17. Phase 3-S：系统性语义与 LLM 边界收敛（2026-08-25）

状态：已完成。范围包括年度分区排名、订单去重计数、单年同比内部维度、大区别名、追加式多轮、面向未决槽位的澄清、组合图单位族、LLM 语义非扩张及运行说明分类。

验收门槛和结果：

| 门槛 | 结果 |
|---|---|
| 自动化与静态检查 | npm test 164/164；npm run check 通过 |
| 真实 Wyn API | 7/7，通过原问题和自然语言变体 |
| 浏览器用户 UAT | 7 张 1280x720 截图，回答、详情、图表/表格、上下文和多轮均通过 |
| 可观测性 | 9 个事件按 trace 连续回放 |
| 缺陷 | B-039 至 B-045、E-004、E-005 均关闭 |

详细需求、设计、测试、截图和 Bug 闭环见 SMART_QUERY_SYSTEMIC_SEMANTIC_FIX_UAT_REPORT_2026-08-25.md。仍依赖外部输入的事项为两类受限账号、非索引数据集和跨行业口径审批。
## Phase 3-F：通用公式派生指标（2026-08-25，已完成）

| 工作项 | 交付 | 状态 |
| --- | --- | --- |
| 公式指标 Skill 模型 | 白名单算子、稳定依赖 ID、聚合顺序、单位、除零策略 | 完成 |
| 版本化交互协议 | QuestionSemanticFrame v2、BusinessQueryIntent v2、QueryProgram v1 兼容扩展 | 完成 |
| 受控执行 | Wyn 基础聚合后计算、内部依赖裁剪、结果完整性校验 | 完成 |
| LLM 治理 | 中风险复核、遗漏/发明/篡改拒绝、展示元数据确定性恢复 | 完成 |
| 首个业务指标 | sales-baseline@1.2.0 毛利率 | 完成 |
| 自动化与真实 UAT | 专项 11 例、全量回归、真实 Wyn 7 例、浏览器截图 3 例 | 完成 |

专项文档：`SMART_QUERY_FORMULA_DERIVED_METRICS_REQUIREMENTS_DESIGN_AND_UAT_2026-08-25.md`。

## 18. 2026-08-26 复杂时间语义与多维多指标增强

状态：已完成。通用时间语义由 `skills/system/temporal-semantics/skill.json`（approved）治理，支持“年月、年和月、按月份、每个月”等 month 表达；LLM 负责未见表达归一化，确定性层负责校验。项目分组上限由 2 提升为 8，WAX 编译器对四维请求生成单次 `SUMMARIZECOLUMNS`。销售额、利润、毛利率、客单价支持多指标组合，泛化同比在多指标场景进入对象澄清；超过可读阈值时只展示完整表格。

自动化 `npm test` 190/190、`npm run check` 通过；真实 Wyn 复杂 UAT 10/10、公式指标 UAT 7/7；浏览器截图 3 张及控制台检查通过。详细需求、设计、缺陷和证据见 `SMART_QUERY_COMPLEX_MULTI_DIMENSION_TIME_SEMANTICS_REQUIREMENTS_DESIGN_AND_UAT_2026-08-26.md`。

## 19. 2026-08-27 智能问数入口与表格/图表策略优化

状态：已完成。用户可见入口统一为“智能问数”；可见维度超过 2 个或指标超过 3 个时强制表格优先；表格主体固定高度滚动，工具栏和分页保持可见；语义解析优先最长显式字段以保留并列产品层级。

交付与验收：`npm run check` 通过，`npm test` 212/212 通过；真实 Wyn 页面 UAT 通过，截图见 `test/uat-artifacts/smart-query-ui-2026-08-27/three-dimensions-table-only.png`。本阶段关闭 `SEM-UI-001`（并列产品维度被泛化子串过滤）。

## 20. 2026-08-27 结果行数口径与极简提示

状态：已完成。系统区分内部计算范围和用户可见结果范围：同比等派生计算所需基期行数保留在诊断字段，最终 `totalRowCount` 在 QueryProgram 投影后重算。前端仅依据明确截断标记告警，完整结果不显示数据行数提示，只保留分页控件。

## 构成占比和纠正型多轮后续能力（2026-08-27）

本次专项已完成基础闭环。后续迭代继续沿用以下项目级约束：

1. 所有构成、贡献、份额类表达优先进入受治理派生类型，不以单个关键词补丁替代统一语义模型。
2. 用户否定并重述时必须进行根替换，旧 pending 只能作为审计历史，不能参与新意图规划。
3. 任何图表选择都必须保留结构化意图、适用性校验和完整表格后备。
4. 评测包新增“错误澄清纠正”对话轨迹，要求检查 pending 是否清空、是否重复澄清和日志是否可回放。
5. 继续补充跨行业 Skill 的占比口径、分母范围和多层分区定义，并在审批后进入生产目录。


## 九点平台方案落实追踪（2026-08-28）

本计划的九点提案均按“增强既有链路 + 增加统一协议层”实施：入口和会话保持现有 API；Skills、语义帧、Canonical Query 和 Wyn 权限边界保持不变；新增 `result-presentation-plan/v1` 作为规划与渲染之间的稳定接口，并用日志/评测/UAT 形成闭环。

| # | 工作包 | 当前状态 | 后续门槛 |
|---|---|---|---|
| 1 | 既有平台链路增强 | 已完成 | 持续回归 |
| 2 | 统一中间模型与版本管理 | v1 已落地 | v2 兼容策略 |
| 3 | 语义与多轮状态机 | 已完成基础版，时间比较兼容修复已关闭 | 更广泛口语评测 |
| 4 | Wyn 查询执行与结果边界 | 管理员真实查询已验证 | 持续维护 20,000 行上限、样本、截断和空结果契约 |
| 5 | 结果展示规划 | 图表/表格协同、占比原值保留、高基数降级已完成 | 更多行业可视化规则 |
| 6 | Skills 治理 | approved Skill、公式依赖、冲突审计已完成基础版 | 管理界面、审批流程产品化 |
| 7 | 跨行业评测 | 销售/实验室/零售包和 50 组回归已落地 | 业务负责人黄金答案审批 |
| 8 | 日志与反馈学习 | 10 段 trace 回放、反馈候选隔离已完成 | 生产监控和反馈运营 |
| 9 | 平台化测试/UAT | API、自动化、DOM、截图、日志交叉验收已建立 | CI 门禁和长期基准集 |

### 本轮完成门禁

`npm test` 228/228、`npm run check` 通过；真实 Wyn 管理员 UAT 4/4 通过。截图与机器可读报告位于 `test/uat-artifacts/presentation-plan-2026-08-28/`。当前无开放缺陷；“两类受限账号、非索引数据集权限和跨行业黄金答案审批”仍是外部依赖，不阻断本轮交付。

## 2026-09-14 P0 Wyn 能力与 LLM 稳定性收口

本阶段已完成 P0-A（Wyn 能力与结果边界）和 P0-B（LLM 调用链稳定性）在指定新数据集上的平台验收，固定数据集为 `18b86197-65e3-4682-8501-6e7125afad02`。

| 工作包 | 完成内容 | 状态 |
|---|---|---|
| 明细查询契约 | BusinessQueryIntent v2 增加 `queryMode=aggregate|detail`；detail 禁止指标、派生指标和排名，Canonical 路由至 NONE | 已完成 |
| 结果边界 | 统一 20,000 行应用上限；前端 100 行/页分页；明确样本、截断和未知总数 | 已完成 |
| 交付叙述 | Narrator 不再引用内部预览行数；最多 3 次 LLM 尝试，失败返回错误，不生成业务 fallback | 已完成 |
| LLM 稳定性 | 10 次连续健康探针全部成功，重试和 fallback 均为 0；真实 Planner/Critic/Narrator 链路成功 | 已完成 |
| 可观测性 | 查询事件增加 adapter、adapterVersion、quality；保留 trace、编译和结果质量证据 | 已完成 |

本阶段自动化结果：`npm run check` 通过，`npm test` 428/428 通过；真实浏览器关键路径截图见 `P0_WYN_LLM_PROGRESS_2026-09-14.md`。本阶段不修改 Wyn 权限逻辑，不使用业务 fallback；权限穿透、非索引精确聚合和 Wyn 原生分页不属于后续计划。

当前后续重点转向语义准确性、LLM 长期稳定性、结果契约和用户体验。20,000 行是平台和 Smart Query 的统一应用交付上限，页面使用已验收的前端分页；不再扩展为 Wyn 原生分页能力。

### 2026-09-17 查询正确性纠偏（取代上表中的明细和结果边界结论）

9 月 14 日的 `detail -> NONE` 与“先交付 20,000 行再提示受限”是历史实现，不再是正式问数能力：对原始 28,944 行的固定新数据集，旧路径的 B-001 只找到 2 行，而 Wyn 先过滤后的正确结果是 7 行。现已将 Smart Query 默认适配器限定为 WAX；原始行先在 Wyn 过滤并计数，超过 20,000 行或计数与取数不一致时停止生成答案。聚合后计算需要完整中间分组；NONE 只用于独立、明确标记的无筛选质量样本，分析入口亦不再在 Wyn 筛选失败时取未筛选样本本地过滤。前端分页仍仅分页已验证完整交付的结果。

专项自动化与真实浏览器 B-001 已验收；B-002 至 B-010 和其余 UAT 库在该阶段仍需逐条重跑，不能沿用旧截图结论。截至 9 月 17 日，LLM 输出中的 `queryMode=aggregate/detail` 仍为当时协议；该历史状态已由 9 月 21 日的 queryMode/NONE 架构清理取代。详见 `UAT-AY/WYN_FILTER_BEFORE_CAP_UAT_2026-09-17.md`。

## 2026-09-18 P0 执行边界与派生计算治理（开发完成，动态真实 UAT 已运行）

本工作包把“Wyn 先执行、平台仅做受治理二次加工”升级为不可绕过的平台不变量。所有影响业务数据范围的筛选、分组、基础聚合、排序、排名和 TopN 默认由 Wyn 执行；平台只能对完整、非样本、非截断且总数可验证的 Wyn 聚合结果执行版本化白名单操作。

实施范围包括：QueryProgram v2 执行所有权、版本化结果契约、派生计算注册表、统一运行时 Guard、Wyn 能力下推、执行责任账本、架构/变异测试门禁以及 UAT-AY-001 至 020 的真实浏览器回归。未注册操作、部分结果和样本结果一律阻断，不允许 fallback、近似计算或从前 20,000 行推断全量。

专项需求、设计、分阶段计划和完成定义见 `SMART_QUERY_EXECUTION_BOUNDARY_AND_DERIVED_CALCULATION_GOVERNANCE_REQUIREMENTS_DESIGN_2026-09-18.md`。结果契约、QueryProgram v2、派生注册表、统一 Guard、源端聚合筛选、完整性阻断和责任账本已完成；`npm run check`、`npm test` 和 `git diff --check` 已通过。固定 AY 回归与动态真实浏览器证据均已完成，动态语义门禁已关闭。

2026-09-29 动态语义 UAT 已执行 12 条真实用户问题并完成最终截图、DOM 和控制台证据：修复后 12/12 通过。DYN-07、DYN-09 的结果粒度问题和 DYN-10 的赢单季度时间分组问题已通过通用平台能力修复；DYN-10 的 FY26 0 行为合法完整空结果。详细证据见 `UAT-AY/dynamic-semantic-uat-2026-09-29/DYNAMIC-SEMANTIC-UAT-REPORT-2026-09-29.md`。此前失败截图仍保留用于回归审计。

### 2026-09-20 Phase 3-T2：时间约束权威规范化与防回归

本阶段解决同一业务期间被重复物化为“财年字段筛选 + 日期范围筛选”的平台级回归。实现不绑定数据集 ID、销售业务或 AY 问句，而是依据 approved Skill 的 `calendarPolicy`、用户显式时间表达、元数据字段类型和结构化意图统一决策。

实施内容：

1. 在 LLM 意图规范化后建立 `time.authority`，区分 `skill-calendar-policy` 与 `user-explicit-composite`。
2. 用户未明确要求日期范围时，以 Skill 声明的财年 `eq/in` 为范围权威，移除 LLM 推断的重复日期范围。
3. 用户明确自然年、日期区间或截止日期时保留日期范围；明确复合条件时同时保留财年和日期条件。
4. 时间分组与时间范围分离：财年负责范围，合法日期字段可继续负责月/季/年分组。
5. 覆盖校验接受权威财年条件作为完整时间物化，不再强制叠加日期范围。
6. 发布门禁新增时间形态矩阵与 AY-033 Trace 回放；任何 0 行结果都不能代替约束来源核验，不允许业务 fallback。

验收门槛：专项矩阵、受影响测试和全量测试通过；AY-033 连续至少 5 次返回相同 2 行，详情只保留 `赢单财年 = 26` 与 `revenue > 10000000`；AY-034 连续至少 3 次保持合法 0 行；相关“去年、财年、截至目前”问题无回归，并保留真实浏览器概述、详情、trace 和截图。

当前结果：上述门槛已全部满足，证据见 `UAT-AY/TIME_AUTHORITY_REGRESSION_UAT_REPORT_2026-09-20.md`。本阶段可以关闭；后续修改时间语义、Skill 日历策略或 LLM Intent 规范化时，22 条时间专项矩阵和 AY-033/034 必须继续作为发布门禁。

## 2026-09-20 AY/B/综合发布回归基线冻结

### 目标

将 AY、B 组、解释型、语义边界和多值字段问题固化为可重复的发布门禁，防止平台级语义修复重新破坏筛选、时间物化、字段角色、结果完整性或用户可见执行证据。

### 已完成

- 版本化评测包 `sales-ay-release@1.0.0`，覆盖 52 条 AY、B、EXPLAIN、SEM 和 MV 用例。
- 同一 8787 候选进程完成 API 52/52 和真实浏览器截图 52/52。
- 真实浏览器逐条展开“详情”，验证执行归属、Trace、结果范围和内部字段不泄漏；控制台 error/warn 为 0。
- 修复相对财年说明中“请求目标财年 + 当前锚点财年”被误判为冲突的通用时间账本边界，并增加自动化回归。
- 2026-09-21 跨日复验将“截止目前”的固定日期断言改为统一业务日期锚点表达式；API 与 Codex 内置浏览器再次完成 52/52，全部截图重建，控制台、内部泄漏和 fallback 均为 0。

### 发布门禁规则

后续修改若触及 LLM 意图规范化、时间 Skill、查询约束、字段投影或结果展示，必须先运行 `npm run uat:ay-release`，并在同一 8787 候选版本重跑真实浏览器截图；52 条中任意一条业务失败、澄清态错误、fallback、样本/截断结果、内部字段泄漏或控制台异常，都不得标记 `releaseReady`。

### 明确不属于本轮

该发布基线本身未实施 `queryMode/NONE` 架构清理。后续 2026-09-21 专项已启动并取代该未完成状态：新 Smart Query 链路不再生成或依赖 `queryMode`，Canonical 执行形态由指标、维度和时间粒度等结构推导；Smart Query 执行策略只允许 `wyn-wax-controlled`，NONE 仅保留给独立数据洞察的明确质量采样。权限穿透、非索引数据集和 Wyn 原生分页仍不重新纳入范围。

## 2026-09-21 queryMode/NONE 架构清理

本专项将结果展示形态与查询执行方式彻底解耦：`expectedResult.shape` 继续描述用户希望看到的标量、表格、趋势或明细展示，但不能决定使用聚合、投影或哪个适配器。Canonical 模式只根据结构化意图推导：有指标时为聚合，有时间粒度的指标查询为比较，无指标且有投影字段时为源端投影。

Smart Query 使用默认拒绝的 `smart-query` 执行策略，只允许 Wyn/WAX 适配器，运行结果必须为非样本；多数据集和开放分析入口同样透传该策略。独立数据洞察使用 `data-insight` 策略，可保留 NONE 质量采样，但其结果必须标记为样本，不能进入 Smart Query 业务答案。新运行审计字段统一为 `executionStrategy`；历史保存结果中的 `queryMode` 只允许兼容读取，不参与新请求路由。

发布门禁新增：禁止 Smart Query 注册 NONE、禁止 Smart Query 接受 `isSample=true`、允许数据洞察质量采样、展示形态变化不得改变 Canonical 执行模式、旧 `queryMode` 输入不得影响路由、会话必须显式传递 `executionPolicy=smart-query`。本专项不增加销售场景、固定问题或数据集 ID 特判。

## 2026-09-22 P0 受治理语义映射

目标是把数据集/Skill 字典从“供模型参考的文本”升级为可校验的执行证据。实施包括：

1. 字典解析结果必须以 `field + concept + operator + canonicalValue + sourcePhrase + skillRef` 原子绑定，字段和值不得拆分迁移。
2. 未知简称若无法从当前数据集、已加载 Skill、用户确认或既有受治理约束获得证据，必须先澄清，不得由 LLM 自由猜测。
3. requiredMetrics/requiredDimensions 的覆盖校验优先按源字段、业务概念和 Skill 同义词解析，再使用输出 alias。
4. Canonical 编译前再次校验规范值所属字段和操作符，错误绑定不得发送给 Wyn。
5. 自动化与真实浏览器 UAT 同时验证正向 MNC、未知 MCN/POC、partner 输出字段和错误字段绑定阻断。

本工作包不优化或收紧多轮上下文继承；相关行为保持现状，并由既有回归用例继续保护。禁止新增固定问题、销售专用代码分支或业务 fallback。

完成状态：代码、Schema、销售 Skill 同义词、专项测试与项目文档已更新；全量自动化 `539/539`、`npm run check` 通过。8787 真实浏览器完成合法 MNC + `partner`、未知 MCN、未知 POC 三类用户路径及合法查询技术详情验收，4/4 通过，控制台 warning/error 为 0。证据见 `UAT-AY/governed-semantic-mapping-2026-09-22/GOVERNED_SEMANTIC_MAPPING_UAT_REPORT_2026-09-22.md`。
# 2026-09-28 平台语义权威与最大可信可执行子集实施补充

本补充属于平台级能力建设，不针对单个数据集、Skill 或 AY 用例硬编码。

## 目标

- LLM 是唯一的业务语义解释者；平台不再根据关键词、字段顺序或确定性业务基线生成第二份语义意图并否决 LLM。
- 平台只负责协议规范化、Schema/权限/字段/操作符校验、Skill 已声明映射、Wyn 编译执行、结果契约和审计。
- 用户要求拆为可追溯 `requestUnits`。独立输出无法执行时允许显式部分完成；范围条件、核心分组、排名依据和派生依赖缺失时必须澄清，禁止扩大查询范围。
- 用户可见结果必须区分完整完成、部分完成和无法执行，并同时保留技术详情。

## 验收门禁

每次重大语义改动必须通过固定历史回归库、至少 10 条由字段目录/数据集语义/Skill 动态生成的新问题，以及真实浏览器截图。动态问题生成器不得读取修复代码或预设答案；失败的新问题进入永久回归库。
