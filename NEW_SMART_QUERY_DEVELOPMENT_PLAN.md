# 新智能问数项目需求与开发计划

> 文档状态：Active implementation / Phase 0-2 基础能力已交付；Phase 3 基础链路完成、语义准确性增强中；Phase 4 基础版已交付；Phase 5 及外部身份/数据源验证持续推进
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
- 使用受控 WAX 适配器执行聚合查询；
- 使用 Dataset NONE 适配器执行明细或受控样本查询；
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
- Wyn 接口能力和权限穿透的实测验证。

### 3.2 必须验证的前提

以下事项目前不能仅凭代码推断，需要在真实 Wyn 环境中验证并形成测试记录：

1. 数据集定义接口是否完整返回层级、计算字段、同义词、默认聚合、业务描述、字段格式和 AI 分析配置。
2. 数据集查询接口对 WAX 和 NONE 的实际支持范围，包括聚合、分组、时间粒度、排序、过滤、字段比较、明细、分页、最大返回行数和超时行为。
3. Wyn 数据集查询在不同身份下是否执行同样的数据集权限、行级权限和数据权限。
4. 服务端使用 `WYN_TOKEN` 调用查询接口时，是否代表终端用户身份，还是仅代表一个固定服务账号。
5. 未启用索引的数据集是否支持精确的服务端聚合，还是只能返回受限原始样本。
6. Wyn 返回的聚合结果是否存在排序、空值、日期格式、数字格式和时区差异。

### 3.3 权限穿透的准确表述

“最终调用 Wyn 数据集查询，所以默认继承用户权限”这个判断只有在调用链携带了终端用户身份时成立。

如果 WynAI 使用固定服务端 Token，Wyn 可能只看到服务账号，不能自动知道浏览器当前用户。因此必须在 Phase 0 做两类用户的对照测试：

- 用户 A 能访问、用户 B 不能访问的数据集；
- 同一数据集下用户 A、用户 B 可见行不同的行级权限场景。

只有查询结果和权限预期一致后，才能把“权限穿透”列为正式产品能力。否则需要增加 Wyn 用户身份代理、短期委托 Token、服务端权限映射或明确的二次权限校验。

## 4. NONE 样本模式说明

当前查询层有两种重要模式：

### WAX 聚合查询

- Wyn 在数据集侧执行聚合、分组和部分过滤；
- 适合总额、趋势、排名、分布等精确聚合结果；
- 结果行数通常是分组后的行数；
- 仍需要标记是否被 Wyn 的行数上限截断。

### NONE 明细查询

- 通常返回数据集原始行；
- 当前项目在服务端对返回行执行受控过滤和字段投影；
- 受 `RowLimit` 限制，当前适配器将其标记为 `isSample=true`；
- 适合明细预览、质量检查、示例数据和受控局部分析；
- 不适合将返回样本当成全数据集，直接回答“全局总额”“所有客户排名”等问题。

因此，未启用 Wyn 索引的数据集并不一定不可用，但必须区分：

- **精确结果**：由 Wyn 服务端完整聚合得到；
- **受限样本**：只代表返回范围，不能外推全局；
- **无法回答**：当前查询能力不足以支持所需口径。

产品界面和最终答案必须披露结果范围、是否采样、是否截断和是否为估算。不能把样本计算结果伪装成完整数据集结果。Phase 0 需要验证非索引数据集是否存在可用的精确聚合路径。

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
  +-- Controlled WAX Adapter
  +-- Dataset NONE Adapter
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

### Phase 0：Wyn 能力与权限验证

当前状态：部分完成。管理员 Token 下的指定销售数据集元数据、NONE、WAX 概览、客户/地区聚合已实测；双账号权限、非索引数据集和完整过滤矩阵仍需外部依赖。

目标：把所有外部依赖从“推断”变成“实测证据”。

工作项：

- 保存真实数据集定义样本并建立脱敏 Fixture；
- 验证 AI 开关、层级、字段描述、同义词、默认聚合、计算字段和格式是否返回；
- 建立查询能力矩阵：聚合、分组、时间粒度、排序、过滤、字段比较、明细、分页、空值和截断；
- 建立索引/非索引数据集对照测试；
- 建立两用户数据集权限和行级权限测试；
- 记录 Wyn 版本、接口路径、请求参数和响应差异。

交付物：`WYN_API_CAPABILITY_MATRIX.md`、脱敏 API Fixture、权限验证报告。

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

- 复用并完善 `QueryRouter`、WAX 和 NONE 适配器；
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

当前状态：部分完成。本地 Skill 版本治理（草稿、审批、退役、回滚、持久化审计）和智能问数请求主体上下文、会话访问控制、限流、跨进程请求审计已实现并通过自动化/UAT；Wyn 终端身份代理、双账号权限对照、非索引精确聚合仍未验证。

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

- 聚合结果与 Wyn 原生结果逐项比对；
- 日期粒度、时区、空值、排序和截断测试；
- 精确结果、样本结果和估算结果边界测试；
- 两个用户的权限和行级数据隔离测试。

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
| 固定 Token 绕过终端用户权限 | Phase 0 双用户和行级权限实测；必要时引入用户身份代理 |
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
