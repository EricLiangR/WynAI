# 独立问数语义准确性全覆盖增强计划

> 文档状态：Implemented baseline / continuous regression
>
> 创建日期：2026-08-22（Asia/Shanghai）
>
> 适用范围：左侧“独立问数”入口及其会话、规划、查询、结果验证、页面编排和 Skills 链路
>
> 基线数据集：`2b445034-38fe-4350-9cab-b7684c28b5f8`（销售数据集，revision 7）
>
> 关联文档：`NEW_SMART_QUERY_DEVELOPMENT_PLAN.md`、`DEVELOPMENT_PROGRESS_REPORT.md`、`WYN_API_CAPABILITY_MATRIX.md`、`SMART_QUERY_INTENT_LATENCY_REQUIREMENTS_AND_DESIGN.md`

## 1. 结论

本次问题不是 Wyn 数据查询接口算错，而是独立问数在查询前错误理解了用户问题，并将一个语义不完整但结构合法的查询交给 Wyn 精确执行。现有查询内核、Canonical 查询模型、结果归一化、InsightDocument、Skill Registry 和 Wyn 适配器均可复用；需要重点重构的是“自然语言问题到业务查询意图”的规划主链路，并补齐查询前语义完整性校验、查询后结果一致性验证和系统化评测。

当前独立问数可以继续用于受控测试，但不能标记为“自然语言问数整体准确性已验收”。在本计划的生产门槛通过前，复杂问题应澄清或明确降级，不能返回看似精确但没有回答问题的结果。

## 2. 本次问题证据与根因

### 2.1 已复现问题

| 会话证据 | 用户问题 | 实际查询语义 | 实际回答 | 正确语义 |
| --- | --- | --- | --- | --- |
| `conv-5ad7bd7f-498b-4395-b6f5-cb4b9c108ac9.json` | 23、24、25年各自的销售额是多少 | 无时间过滤、无年度分组、`sum(订单金额)`、scalar | 全数据集总额 `¥24,613,596.8` | 2023/2024/2025 三个年度分组销售额 |
| `conv-567629dd-d028-4ad0-9bcb-405cb929af01.json` | 每年销售额统计 | 无年度分组、scalar | 全数据集总额 `¥24,613,596.8` | 按年分组的销售额序列 |
| 同上第二轮 | 继续按月份 | 改为月粒度，但没有可继承的限定时间范围 | 返回 2016 年起全部月份 | 保留上一轮范围，仅把粒度从年改为月；若上一轮未限定范围，应明确范围或澄清 |

页面中的“精确结果”只表示 Wyn 精确执行了收到的查询，不表示该查询精确表达了用户问题。后续 UI 必须把“数据执行范围”和“语义回答置信度”分开显示。

### 2.2 直接根因

`lib/conversation/question-planner.mjs` 当前是有限正则规划器：

- 只识别四位年份和“去年”，不识别两位年份、多年份列表或年份范围；
- 只识别“按月/月份/每月/月度/趋势”，不识别“每年/年度/逐年/各年”；
- 没有把“各自/分别/每个”转换为分组或多结果要求；
- 只要识别到“销售额”等指标，就把问题判定为已理解；
- Canonical 校验只验证字段和结构是否合法，不验证显式用户约束是否全部保留；
- 多轮主要继承 `activeQueryRequest`，没有独立保存完整的时间、比较、结果形状和待澄清状态。

### 2.3 系统性根因

当前主链路实际更接近：

```text
有限正则规则 -> CanonicalQueryRequest -> Wyn -> 页面
```

而原始规划要求的主链路是：

```text
结构化会话状态 + 语义目录 + Skills + 用户问题
-> LLM 结构化 Planner
-> 版本化业务意图
-> 服务端校验与编译
-> CanonicalQueryRequest
-> Wyn
-> 结果一致性验证
-> InsightDocument
```

现有严格外部 LLM `14/14` UAT 验证的是自主分析 Planner/Critic/报告链路，不能证明独立问数入口已经使用该 Planner，也不能替代独立问数问题集验收。

## 3. 与原始规划的差距

| 能力 | 原始目标 | 当前状态 | 差距级别 | 增强方向 |
| --- | --- | --- | --- | --- |
| 统一版本化交互协议 | 所有 LLM 模块复用协议族 | v1 已有，但独立问数主要绕过 LLM 业务意图 | P0 | 增加 `BusinessQueryIntent v2` 并接入独立问数主链路 |
| 自然语言规划 | LLM 结合语义和 Skills 生成结构化意图 | 有限正则直接生成 Canonical | P0 | 确定性预解析 + LLM Planner + 受控编译 |
| 时间语义 | 范围、粒度、相对时间、比较 | 仅单四位年份、去年、按月 | P0 | 统一 TimeSemantics 模型和解析器 |
| 查询完整性 | 显式约束不可丢失 | 只检查结构合法 | P0 | Query Intent Coverage Validator |
| 结果一致性 | 结果形状、范围和问题一致 | 只检查查询是否成功 | P0 | Result Intent Validator |
| 多轮状态 | 保存结构化时间、比较和澄清状态 | 主要保存上一条查询 | P0 | ConversationState v2 + 状态差量合并 |
| 澄清 | 多义、低置信或不可执行时澄清 | 仅少数未知指标/维度触发 | P1 | 槽位置信度和风险分级澄清 |
| 复杂分析 | 比较、占比、排名、下钻、明细、原因分析 | 只覆盖少量趋势/排名 | P1 | 意图分解、查询图和确定性计算 |
| Skills | 提升业务口径和场景准确性 | Registry/治理已具备，未完整驱动问数 Planner | P1 | Skill 解析结果进入意图生成和校验 |
| 评测体系 | 问题集、回放、模型版本对比 | 少量固定句式测试 | P0 | 黄金集、变体集、多轮集、对抗集和线上回放 |
| UI 可解释性 | 展示口径、证据和范围 | 组合页面已具备，语义准确性与执行精度混用 | P1 | 展示“我如何理解”和可修改的查询范围 |

## 4. 目标、非目标和原则

### 4.1 目标

1. 用户的显式指标、维度、筛选、时间、排序、数量和比较约束不得静默丢失。
2. 同义问题生成等价业务意图和等价 Canonical 查询。
3. 多轮追问只修改用户明确提出的槽位，其他已确认上下文稳定继承。
4. 复杂问题可生成由 KPI、文本、图表和表格组成的组合页面，并且每个结论可追溯到查询或确定性计算证据。
5. Skills 能按数据集、组织、用户和场景参与指标映射、默认行为、工作流和澄清。
6. 无法可靠回答时优先澄清或安全拒绝，不输出伪精确答案。

### 4.2 非目标

- 不让大模型生成 SQL、WAX、原始 Wyn Payload、HTML、JavaScript 或任意图表代码；
- 不重建 Wyn 数据存储、权限和查询引擎；
- 本专项首轮不依赖向量库或复杂 RAG；
- 不以无限制自由 Join 作为首期目标；
- 不用更多正则堆叠替代完整语义规划架构。

### 4.3 设计原则

- **语义意图与执行查询分离**：LLM 表达“要什么”，受控编译器决定“如何查”。
- **显式约束优先**：用户原句中的约束高于默认值，任何丢失均阻止执行。
- **确定性边界**：字段白名单、时间归一化、查询编译、公式、权限、证据和渲染由程序控制。
- **版本可回放**：模型、Prompt、Schema、语义目录、Skill 和编译器版本都进入运行记录。
- **失败可见**：低置信、歧义、降级和校验失败不能伪装成成功。
- **测试以语义为单位**：验收问题、意图、查询、结果和答案五层，不只检查 HTTP 200 或页面有数字。

## 5. 目标架构

```text
用户问题
  + ConversationState v2
  + Wyn SemanticCatalog
  + Resolved Skills
        |
        v
Deterministic Pre-parser
  - 时间/数字/TopN/显式实体候选
  - 原句约束清单 ConstraintLedger
        |
        v
LLM Query Planner
  - 输出 AIInteractionResponse v2
  - 内含 BusinessQueryIntent v2
        |
        v
Intent Normalizer / Semantic Resolver
  - 字段与指标白名单绑定
  - 时间归一化
  - 低置信与冲突澄清
        |
        v
Intent Coverage Validator
  - 检查所有显式约束是否有落点
  - 检查结果形状和操作不变量
        |
        v
Canonical Compiler
  - 生成 CanonicalQueryRequest v1/v2
  - 禁止原始 SQL/WAX/Payload
        |
        v
Wyn Query Router / WAX / NONE
        |
        v
Result Intent Validator
  - 行数、形状、字段、时间覆盖、排序、TopN
        |
        v
Deterministic Metrics + Evidence
        |
        v
InsightDocument Composer -> 会话式 UI
```

### 5.1 组件职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Pre-parser | 抽取高置信时间、数字、明确操作词和原句约束 | 最终字段绑定和复杂业务推理 |
| LLM Planner | 意图分类、槽位候选、比较关系、结果形状、澄清和展示意图 | SQL/WAX/Payload、最终权限和字段合法性 |
| Semantic Resolver | 用 Wyn 元数据和 Skills 绑定字段/指标 | 猜测不存在的字段 |
| Coverage Validator | 校验问题约束与意图/查询一一对应 | 自动放宽用户条件 |
| Canonical Compiler | 把业务意图编译为平台无关 Canonical 查询 | 自由文本理解 |
| Wyn Adapter | 把 Canonical 查询安全转换并执行 | 判断查询是否回答了用户问题 |
| Result Validator | 检查结果是否满足意图形状和范围 | 编造缺失数据 |
| Composer | 用已验证结果生成受控页面块 | 生成任意 HTML/代码或无证据结论 |

## 6. 项目级统一协议增强

### 6.1 协议决策

新增 `BusinessQueryIntent v2` 作为所有问数、模板报告和自主分析模块可复用的业务查询中间模型；新增 `AIInteractionResponse v2` 对其封装。`CanonicalQueryRequest v1` 暂时保持兼容，由服务端编译器生成；只有现有 Canonical 无法表达的确定性能力才升级到 v2。

LLM 返回 `BusinessQueryIntent v2`，不直接返回可执行 Wyn 查询。这样既保持项目级一致性，也避免模型绕过语义校验。

### 6.2 BusinessQueryIntent v2 建议结构

```json
{
  "schema": "wynai.business-query-intent/v2",
  "id": "intent-...",
  "operation": "aggregate",
  "datasetRefs": [{ "id": "...", "revision": 7 }],
  "metrics": [
    { "semanticRef": "订单金额", "aggregation": "sum", "alias": "revenue" }
  ],
  "dimensions": [
    { "semanticRef": "订购日期", "role": "time", "grain": "year", "alias": "year" }
  ],
  "filters": [],
  "timeContext": {
    "calendar": "gregorian",
    "timezone": "Asia/Shanghai",
    "range": { "start": "2023-01-01", "endExclusive": "2026-01-01" },
    "periods": [2023, 2024, 2025],
    "grain": "year",
    "comparison": null
  },
  "ranking": null,
  "expectedResult": {
    "shape": "time-series",
    "minimumRows": 3,
    "maximumRows": 3,
    "requiredDimensions": ["year"],
    "requiredMetrics": ["revenue"]
  },
  "conversationDelta": {
    "mode": "new-question",
    "inherit": [],
    "replace": ["metrics", "timeContext", "dimensions"]
  },
  "confidence": {
    "overall": 0.96,
    "slots": { "metric": 0.99, "time": 0.98, "shape": 0.97 }
  },
  "ambiguities": [],
  "assumptions": ["23、24、25年解释为2023、2024、2025自然年"],
  "provenance": {
    "constraintIds": ["c-year-list", "c-each", "c-sales"],
    "semanticRefs": ["订单金额", "订购日期"],
    "skillRefs": []
  }
}
```

### 6.3 必需枚举和字段

- `operation`：`aggregate`、`trend`、`rank`、`compare`、`share`、`detail`、`drill-down`、`roll-up`、`explain`；
- `timeContext`：绝对范围、离散期间、粒度、日历、时区、同比/环比/同期关系；
- `expectedResult.shape`：`scalar`、`grouped-table`、`time-series`、`ranking`、`detail-table`、`comparison`、`composite`；
- `confidence.slots`：指标、维度、筛选、时间、比较、形状分别评分；
- `ambiguities`：候选解释、影响槽位、是否阻止执行和澄清选项；
- `conversationDelta`：明确本轮继承、替换、添加、移除或重置哪些状态；
- `provenance.constraintIds`：保证用户显式约束能追踪到意图和最终查询。

### 6.4 版本治理

1. 每个协议有 JSON Schema、规范化器、兼容转换器、危险字段拒绝和版本说明。
2. 破坏性修改升级主版本；增加可选字段升级次版本。
3. 运行记录保存 `schemaVersion`、`model`、`promptVersion`、`compilerVersion`、`semanticRevision`、`skillRefs`。
4. 历史 v1 运行只读兼容；v2 主链路可通过 Feature Flag 回退到受控 v1。
5. 每次模型、Prompt、Skill 或编译器升级都必须对同一黄金集做基线对比。

## 7. 语义能力全覆盖矩阵

### 7.1 时间语义

| 类别 | 示例 | 标准化结果 | 执行策略 |
| --- | --- | --- | --- |
| 四位年份 | 2025年销售额 | 2025 自然年 | `[2025-01-01, 2026-01-01)` |
| 两位年份 | 23年销售额 | 2023，自带解释记录 | 世纪歧义时澄清；业务数据范围可辅助消歧 |
| 多年份 | 23、24、25年各自销售额 | periods 2023/2024/2025，grain=year | 年分组 + 范围过滤，期望 3 行 |
| 年份范围 | 2023-2025年 | 连续三年 | 年分组 + 范围过滤 |
| 年度粒度 | 每年/逐年/按年度 | grain=year | 必须有时间维度，禁止 scalar |
| 月/季/周/日 | 按月、每季度、逐周 | 对应 grain | 使用已验证的 Wyn 时间粒度能力 |
| 相对时间 | 去年、本月、近三个月 | 基于会话时区和锚点时间 | 记录解析后的绝对范围和锚点 |
| 离散期间 | 2023年和2025年 | periods 非连续 | 受控 `in`/范围组合或多查询 |
| 同比/环比 | 今年同比、上月环比 | comparison | 查询当前与基期，确定性计算变化率 |
| 同期 | 今年1-5月与去年同期 | aligned periods | 对齐日历边界后比较 |
| 财年 | FY2025、2025财年 | calendar=fiscal | Skill/组织配置定义起始月，否则澄清 |
| 多轮改粒度 | 继续按月份 | replace grain only | 保留 activeTimeRange、指标和筛选 |

时间解析统一使用半开区间 `[start, endExclusive)`，并固定会话时区；禁止由页面或模型自行拼接日期字符串。

### 7.2 指标、维度和分析操作

| 能力 | 必要意图信息 | 查询/计算要求 | 关键校验 |
| --- | --- | --- | --- |
| 单指标总量 | 指标、聚合、范围 | scalar 聚合 | 不得遗漏显式筛选 |
| 多指标 | 指标列表、单位 | 同一查询或可对齐多查询 | 单位和粒度兼容 |
| 分组统计 | 指标、维度 | group by | “每个/分别/各自”不得 scalar |
| 趋势 | 时间维度、粒度 | 时间升序 | 必须覆盖请求时间范围 |
| Top/Bottom N | 维度、指标、方向、N | 分组、排序、limit | 三者缺一不可 |
| 排名 | 排名范围、并列策略 | 排序 + 排名计算 | 结果数量与规则一致 |
| 占比 | 分子、分母、分组 | 两个可验证结果或窗口计算 | 分母范围一致、和约等于 100% |
| 同比/环比 | 当前期、基期、指标 | 两期查询 + 白名单公式 | 基期为零策略明确 |
| 明细 | 字段、筛选、分页 | NONE/detail | 显示样本、截断和分页边界 |
| 下钻/上卷 | 当前层级、目标层级 | 替换维度，继承范围 | 层级来自 Wyn/Skill 语义 |
| 原因分析 | 目标指标、异常期间、候选维度 | 查询图、多维贡献分析 | 结论必须绑定证据，不宣称因果 |
| 复合问题 | 子意图和依赖关系 | 多查询 DAG | 子查询均通过完整性和结果校验 |

### 7.3 语义不变量

以下任一规则失败都不得执行或不得向用户输出最终答案：

1. `各自/分别/每年/每个/按...` 必须生成对应分组或多个明确子结果，不能生成 scalar。
2. 多年份问题必须包含年度维度或按年份拆分查询，并覆盖所有年份。
3. 趋势必须包含时间维度和明确粒度。
4. TopN 必须同时包含分组维度、按指标排序和 `limit=N`。
5. 同比/环比必须包含当前期、基期和确定性计算定义。
6. 用户显式时间、区域、产品、客户、阈值和排序约束必须在意图及 Canonical 查询中有对应项。
7. “继续按月份”只修改时间粒度，不得清空已确认的范围、指标和筛选。
8. 单位或聚合口径冲突必须澄清，不能自动选一个口径。
9. 结果行数和形状必须满足 `expectedResult`；不满足时只能修复查询、澄清或报错。
10. 用户可见“精确”只描述数据范围；语义置信度和假设必须独立表达。

## 8. 多轮会话状态 v2

会话不能只依赖上一条 Canonical 查询反推上下文，新增显式结构化状态：

```text
ConversationState v2
  conversationId
  datasetRefs / semanticRevisions
  activeMetrics
  activeDimensions
  activeFilters
  activeTimeRange / activeTimePeriods / activeTimeGrain
  activeComparison
  activeRanking
  activeExpectedResult
  confirmedAssumptions
  loadedSkillRefs
  pendingClarification
  previousIntentIds / resultSetIds / documentId
  turnVersion
```

### 8.1 多轮操作语义

| 用户表达 | 状态操作 |
| --- | --- |
| 改成利润 | replace metric；保留时间、维度、筛选 |
| 再看华东 | add/replace region filter；保留其他槽位 |
| 不看华东 | remove region filter |
| 继续按月份 | replace time grain；保留 time range |
| 改看2024年 | replace time range；保留指标和维度 |
| 再加上利润 | add metric |
| 按商品下钻 | replace dimension with child level |
| 重新开始/清除条件 | 显式 reset，不隐式继承 |
| 刚才第二个结果 | resolve by turn/result reference，不靠字符串猜测 |

每轮保存变更前状态、`conversationDelta` 和变更后状态，支持审计、回放和撤销。

## 9. Planner 路由与澄清策略

### 9.1 路由

- 规则快速通道只处理已经过黄金集验证的单指标、单范围、高置信模板；
- 含多时间段、比较、多个约束、指代、原因、占比或复合页面要求的问题进入 LLM Planner；
- 快速通道和 LLM 都必须生成相同的 `BusinessQueryIntent v2`，经过相同校验器；
- LLM 不可用时，未被快速通道完整覆盖的问题必须澄清或提示暂不可执行，不能降级为无关通用查询。

### 9.2 澄清门槛

触发澄清的条件：

- 指标、时间、比较或分组任一关键槽位低于设定置信度；
- 同一术语匹配多个不等价业务指标；
- 两位年份存在世纪歧义且数据/上下文不能可靠消歧；
- Skill 与 Wyn 语义或其他高优先级 Skill 冲突；
- 结果范围可能是样本，但用户要求精确总量；
- 查询能力超出已验证 Wyn 能力；
- 多轮指代无法唯一解析。

澄清问题应短、可选择，并保存 `pendingClarification`；用户回答后从待确认意图继续，不重新猜测全部问题。

## 10. 查询前和查询后验证

### 10.1 ConstraintLedger

Pre-parser 为用户原句建立约束账本，每项包含：

- `constraintId`、原文片段和类型；
- 标准化候选及置信度；
- 在 BusinessIntent 中的目标路径；
- 在 Canonical 查询中的目标路径；
- 状态：`covered`、`ambiguous`、`unsupported`、`lost`。

任何高置信显式约束为 `lost` 时禁止执行。

### 10.2 查询前验证器

验证内容：字段存在和角色正确、指标默认聚合、时间范围和粒度、结果形状、TopN、排序、过滤运算符、权限上下文、数据集 revision、查询预算、Skill 冲突和语义不变量。

验证结果分为：

- `valid`：可执行；
- `repairable`：只允许确定性、可证明的修复，并记录修复前后差异；
- `needs_clarification`：需要用户选择；
- `unsupported`：当前 Wyn 能力或数据语义不支持；
- `rejected`：危险字段、越权或协议违规。

### 10.3 结果一致性验证器

查询成功后至少验证：

- 实际列是否包含要求的指标和维度；
- scalar/grouped/time-series/ranking/detail 形状是否一致；
- 返回行数是否在预期范围内；
- 时间最小值、最大值和期间集合是否覆盖请求；
- TopN 是否真的按指定指标和方向排序；
- 分组键是否为空或异常合并；
- 多查询结果的粒度、单位和对齐键是否兼容；
- exact/sample/truncated/estimated 是否满足用户精度要求；
- 页面结论中的每个数值是否能绑定 ResultSet 或白名单公式证据。

验证失败时不得生成成功答案。一次确定性重编译仍失败则澄清或返回可理解的错误。

## 11. InsightDocument 与用户体验增强

1. 保持当前消息流和多元素页面，不回退到一次性表单。
2. 每轮显示简洁的“理解范围”：指标、时间、分组、筛选；支持用户直接纠正。
3. 区分三类信息：业务答案、数据范围提示、内部诊断。内部模型/适配器错误不作为业务警告直接展示。
4. 组合问题按意图生成 KPI、比较、趋势图、排名表、说明文本等受控 Block。
5. 图表类型由确定性规则基于结果形状选择；LLM 只能给偏好。
6. 所有文本结论带 Evidence ID；无证据段落不能包含确定性数值。
7. 当系统澄清时保留对话上下文和未执行意图，不展示空图表或伪结果。
8. 页面显式区分“数据精度：精确/样本/截断”和“理解状态：已确认/含假设/待澄清”。

## 12. Skills 增强

第一阶段继续采用本地结构化 Skills，不引入向量库。

### 12.1 Skill 内容扩展

- 指标语义 ID、同义词、字段映射、默认聚合、单位和格式；
- 维度层级、默认时间字段、自然年/财年定义；
- 业务筛选词典和实体规范化；
- 常见问题模板及对应 `BusinessQueryIntent v2` Fixture；
- 复合分析工作流和查询依赖图；
- 禁止组合、易混淆口径和必须澄清条件；
- 推荐页面 Block 和后续问题；
- 黄金问题、反例和版本变更影响。

### 12.2 优先级和治理

优先级保持：系统安全规则 > Wyn 语义 > 数据集/组织 Skill > 用户 Skill > 当前对话补充。Skill 不能覆盖字段存在性、权限和 Wyn 已确认口径；冲突进入澄清。每次运行固定解析后的 Skill 版本，后续更新不修改历史会话证据。

## 13. 可观测性与审计

每轮独立问数保存以下脱敏记录：

- 原始问题、结构化会话前后状态；
- Pre-parser 约束账本；
- Planner 输入摘要、输出、模型和 Prompt 版本；
- BusinessIntent、标准化和修复差异；
- Canonical 查询及编译器版本；
- Wyn 请求的安全摘要、耗时和 ResultSet 范围；
- 查询前/后验证结果；
- InsightDocument 和 Evidence 映射；
- 用户反馈、重问、澄清和最终是否解决。

失败分类统一为：`understanding`、`semantic-resolution`、`constraint-loss`、`compilation`、`wyn-execution`、`result-shape`、`evidence`、`presentation`、`permission`、`dependency`。报告必须按类别统计，不能把所有失败都记为模型失败。

## 14. 测试与 UAT 体系

### 14.1 五层验收

| 层 | 验收对象 | 示例断言 |
| --- | --- | --- |
| L1 问题理解 | BusinessIntent | 识别 2023/2024/2025、年度粒度、销售额 |
| L2 查询编译 | CanonicalQueryRequest | 时间过滤、年分组、sum、期望 3 行 |
| L3 Wyn 执行 | ResultSet | 查询成功、列和范围正确 |
| L4 结果一致性 | Validator | 恰有三个年度且覆盖全部请求年份 |
| L5 答案与页面 | InsightDocument/UI | 三个数值、图表/表格证据一致、可继续追问 |

### 14.2 黄金问题集

建立版本化数据集，至少包含：

- 80 个时间表达问题；
- 60 个指标/聚合/同义词问题；
- 60 个分组、TopN、排序、占比和排名问题；
- 40 个同比/环比/期间比较问题；
- 40 个明细、下钻、上卷和原因分析问题；
- 50 组多轮会话，每组 3-8 轮；
- 50 个歧义、不可支持、越权和应澄清反例；
- 每个核心意图至少 5 种等价说法，包括口语、缩写、标点差异和错别字容错。

每个用例保存：问题/对话、预期 BusinessIntent、允许的等价 Canonical 查询、结果不变量、期望页面 Block、是否应澄清和适用数据集 revision。

### 14.3 本次问题必须进入阻断集

1. `23、24、25年各自的销售额是多少`
2. `2023、2024、2025年分别卖了多少`
3. `23-25年每年的营收`
4. `每年销售额统计`
5. `按年度看销售额`
6. `2023到2025逐年统计订单金额`
7. 第一轮限定 2023-2025，第二轮 `继续按月份`
8. 第一轮每年统计但未限定范围，第二轮 `继续按月份`，验证系统采用已确认全范围或发起范围澄清

### 14.4 自动化测试

- Schema/Normalizer/危险字段契约测试；
- 时间解析、约束账本和状态差量属性测试；
- Planner Fixture 和 Prompt 回放测试；
- 语义不变量的表驱动测试；
- Intent -> Canonical 编译快照和等价性测试；
- Result Validator 的缺列、少行、错序、范围不足和样本测试；
- 多轮状态、澄清恢复、跨进程恢复和并发隔离测试；
- InsightDocument Evidence 完整性和 UI 响应式测试；
- 模型/Prompt/Skill/编译器升级前后对比测试。

### 14.5 真实 Wyn UAT

所有主要问题族必须在 `8787` 服务和真实管理员 Token 下执行，保存：问题、意图、Canonical 查询、ResultSet 摘要、验证结果、页面截图和人工结论。获得两类受限账号后补做数据集权限、行级权限和会话隔离对照；在此之前不得宣称终端用户权限穿透已验收。

### 14.6 浏览器截图和用户视角验收（强制门禁）

每个可交付阶段除 API/自动化测试外，必须从左侧真实入口完成浏览器 UAT，并保留关键截图。至少覆盖桌面和 390x844 移动视口、初始状态、加载状态、成功结果、多轮追问、澄清、无数据、错误和范围提示。

截图验收不能只判断“页面能显示”，必须同时人工核对：用户问题、侧栏上下文、结果标题、KPI、图表、表格、文本结论、时间范围、单位和 Evidence 是否一致；使用独立受控查询核对关键数值。任何页面数值正确但没有回答用户问题、范围错误、图表与表格不一致或“精确”文案误导的场景均判失败。

阶段 UAT 产物必须包含：用例步骤、预期、实际、截图路径、正确性分析、易用性分析、Bug 编号、修复前后对照和最终人工结论。API UAT 通过不得覆盖浏览器 UAT 失败。

## 15. 质量指标与生产门槛

| 指标 | 定义 | MVP 增强门槛 | 生产门槛 |
| --- | --- | ---: | ---: |
| Intent accuracy | 主意图正确 | >= 90% | >= 95% |
| Metric accuracy | 指标及聚合正确 | >= 95% | >= 98% |
| Dimension accuracy | 分组/层级正确 | >= 93% | >= 97% |
| Filter/time accuracy | 显式筛选和时间完整 | >= 95% | >= 99% |
| Query shape accuracy | scalar/趋势/排名等形状正确 | >= 95% | >= 99% |
| Explicit constraint retention | 高置信显式约束无丢失 | 100% | 100% |
| Canonical executable rate | 已判定可执行的查询成功编译 | >= 98% | >= 99.5% |
| Answer/evidence correctness | 答案数值和证据一致 | >= 98% | >= 99.5% |
| Clarification precision | 该澄清时澄清且问题有效 | >= 85% | >= 92% |
| Multi-turn retention | 未修改槽位正确继承 | >= 95% | >= 99% |
| Equivalent phrasing consistency | 同义表达生成等价意图 | >= 90% | >= 97% |
| Safe refusal rate | 不支持/高风险问题不伪答 | >= 95% | >= 99% |
| P95 首屏时间 | 简单问数端到端 | <= 8s | <= 5s（按部署基线复核） |

P0 阻断用例、显式约束保留和答案证据正确性不使用平均分豁免：任何一个高风险用例出现“自信误答”都阻止发布。

## 16. 分阶段实施计划

### E0：状态纠偏与评测基线

**目标**：把本次发现转为可重复的失败测试，统一真实状态口径。

**工作项**：

- 登记 B-010，重新打开 B-008 的广义语义准确性范围；
- 将两份真实会话制作成脱敏回放 Fixture；
- 建立 `test/smart-query-golden/` 数据格式、评分器和首批阻断集；
- 在报告中区分自主分析 LLM UAT 与独立问数 Planner UAT；
- 增加运行审计字段基线，确认不保存 Token/Key。

**主要模块**：`DEVELOPMENT_PROGRESS_REPORT.md`、`test/question-planner.test.mjs`、新黄金集和评分脚本。

**自动化测试**：本次 8 个阻断问题先进入独立评测基线并记录为失败；在 E1 修复前不把预期失败混入 `npm test` 主回归造成持续红灯，现有已通过测试不得回退。

**真实 UAT**：在 `8787` 重放三条真实问题并保存当前失败基线。

**退出门槛**：问题可稳定复现、评分口径和证据路径明确；不以修复前失败阻断 E1 开发。

**回滚**：仅新增评测和状态纠偏，无运行时风险。

### E1：时间语义、约束账本和结果形状基础

**目标**：先消除当前多年份/年度粒度和显式约束丢失问题。

**工作项**：

- 实现 TimeSemantics 标准化器和 ConstraintLedger；
- 支持两位/四位年份、多年份、范围、年/月/季粒度及常用相对时间；
- 建立结果形状推断和十条语义不变量；
- 将快速规则规划器改为输出 BusinessIntent，不直接拼 Canonical；
- 增加查询前完整性校验和当前 B-010 修复。

**主要模块**：新增 `lib/semantics/time-semantics.mjs`、`constraint-ledger.mjs`、`intent-invariants.mjs`；改造 `lib/conversation/question-planner.mjs` 和测试。

**自动化测试**：时间矩阵、等价表达、年度/多年份形状、丢失约束拒绝、边界日期和时区测试。

**真实 UAT**：本次阻断集全部在销售数据集执行，并人工核对三年聚合与月度继承。

**退出门槛**：8 个阻断用例 100% 通过；显式时间约束保留 100%；不影响现有 Top5/2025/利润/华东用例。

**回滚**：Feature Flag 切回旧快速通道；旧通道仅允许已验证模板，复杂问题改为澄清。

### E2：独立问数 LLM Planner 主链路

**目标**：落实原规划的版本化 LLM 结构化规划，不再依赖有限正则覆盖自然语言。

**工作项**：

- 落地 `BusinessQueryIntent v2`、`AIInteractionResponse v2` Schema/Normalizer/转换器；
- 构造仅包含必要 Wyn 语义、Resolved Skills、会话状态和约束账本的 Planner 请求；
- 接入现有 DashScope 客户端，使用严格结构化输出；
- 建立复杂度路由、超时、重试、熔断和安全降级；
- 禁止 LLM 输出 SQL/WAX/Payload，并做递归危险字段扫描；
- 保存模型、Prompt、Schema 和语义 revision。

**主要模块**：`lib/protocol/`、`schemas/`、新增 `lib/conversation/llm-query-planner.mjs` 和路由器；改造 `lib/conversation/session.mjs`。

**自动化测试**：协议契约、Fixture 回放、危险字段、模型无效输出、超时与降级测试。

**真实 UAT**：销售数据集各问题族至少 10 条；严格要求审计记录显示真实 Planner 模型且无确定性伪成功。

**退出门槛**：主问题集 Intent accuracy >= 90%，显式约束保留 100%，复杂问题不再进入无关通用分析。

**回滚**：`SMART_QUERY_PLANNER_MODE=rules|llm|shadow`；先 shadow 对比，再灰度启用。

### E3：受控编译、语义完整性和结果验证器

**目标**：即使 Planner 出错，也不能执行或展示明显不匹配的查询。

**工作项**：

- 实现 BusinessIntent -> Canonical Compiler；
- 实现字段角色、聚合、范围、形状、TopN 和比较不变量；
- 实现确定性可修复规则和修复审计；
- 实现 Result Intent Validator；
- 将验证状态接入会话、Evidence 和失败分类。

**主要模块**：新增 `lib/query/intent-compiler.mjs`、`intent-validator.mjs`、`result-intent-validator.mjs`；复用 QueryRouter 和 ResultNormalizer。

**自动化测试**：每条不变量正反例、编译快照、故障 ResultSet 注入、证据映射测试。

**真实 UAT**：人为构造错误 Planner 输出，确认被拦截；真实查询验证时间覆盖、行数、列、排序和样本边界。

**退出门槛**：查询形状准确率 >= 95%；故意丢约束/错形状样本 100% 被拦截；答案证据正确率 >= 98%。

**回滚**：验证器支持 `shadow/enforce`，但 P0 约束丢失规则从启用起不可绕过。

### E4：多轮状态与操作语义

**目标**：形成稳定的连续对话，而不是每轮重新猜测或只复制上一条查询。

**工作项**：

- 落地 ConversationState v2 和 conversationDelta 合并器；
- 支持继承、替换、添加、移除、重置、下钻、上卷和结果指代；
- 完成 pendingClarification 生命周期；
- 支持跨进程恢复、并发版本冲突和历史 v1 状态迁移；
- UI 展示当前理解范围和本轮修改。

**主要模块**：`lib/conversation/session.mjs`、会话存储、`public/app.js` 和相关样式。

**自动化测试**：50 组多轮 Fixture、状态属性测试、并发/恢复/越权隔离测试。

**真实 UAT**：至少 15 组 3-8 轮会话，覆盖“继续按月份”“改成利润”“只看华东”“清除条件”。

**退出门槛**：多轮上下文保留 >= 95%，P0 状态槽位 100%，浏览器桌面/移动无消息覆盖和布局溢出。

**回滚**：保留 v1 会话读取转换器；新会话可切回单轮受控模式，但不回退为错误继承。

### E5：指标、比较、计算和复杂问法

**目标**：覆盖业务问数的主要问题族和组合式答案。

**工作项**：

- 多指标、Top/Bottom、排名、占比、同比、环比、同期；
- 明细预览、分页边界、下钻/上卷；
- 复合问题拆分为查询 DAG；
- 原因分析采用贡献和相关证据措辞，不宣称因果；
- 白名单公式、单位和空值/除零策略。

**主要模块**：BusinessIntent/Canonical Compiler、确定性指标计算、InsightDocument Composer。

**自动化测试**：各问题族正反例、公式属性测试、多查询对齐和单位兼容测试。

**真实 UAT**：每个能力至少 5 条销售数据问题，并对聚合结果做独立查询核对。

**退出门槛**：各核心问题族 >= 90%，高风险计算和证据 100% 可追溯；未支持能力安全澄清/拒绝。

**回滚**：按 `operation` 单独开关；失败操作不影响基础聚合和趋势。

### E6：Skills 与业务域覆盖

**目标**：让业务口径和用户场景稳定提升 Planner，而不是仅出现在审计记录中。

**工作项**：

- 扩展销售 Skill 的指标、时间、层级、词典、工作流和黄金问题；
- 将 Skill 候选同时用于 Planner、Resolver、Validator 和建议问题；
- 建立数据集/组织/用户冲突决策和可视化解释；
- 增加 Skill 版本离线评测与发布门禁；
- 为实验室、零售数据集建立最小领域 Skill，以验证通用性。

**主要模块**：`lib/skills/`、`skills/`、Planner/Resolver/Validator。

**自动化测试**：作用域、优先级、冲突、版本回滚、Skill 前后准确率对比。

**真实 UAT**：管理员验证三个数据集；获得组织/用户账号后补权限作用域测试。

**退出门槛**：Skill 不降低通用集准确率；目标领域集有可量化提升；冲突 100% 不静默覆盖。

**回滚**：按 Skill 版本退役或回滚；运行固定旧版本保证历史可读。

### E7：组合页面、可解释性和会话 UX

**目标**：让用户看见系统如何理解问题，并能自然纠正和继续追问。

**工作项**：

- 增加理解范围、假设、数据范围和证据查看；
- 支持 comparison/ranking 等受控 Block；
- 澄清卡片、可编辑筛选和重试交互；
- 图表/表格/KPI/文本按结果形状编排；
- 完成桌面、移动端、空态、长文本、加载和错误状态。

**主要模块**：`lib/report/insight-document.mjs`、`public/app.js`、`public/styles.css`。

**自动化测试**：Document Schema、Evidence、渲染、可访问性和响应式回归。

**真实 UAT**：桌面与 390x844 移动视口，覆盖成功、澄清、无数据、样本、错误和多轮长会话。

**退出门槛**：无控制台错误、无横向溢出、无无证据数值；用户能看懂和修改当前范围。

**回滚**：新增 Block 未识别时降级为 text/table；不影响会话数据和查询证据。

### E8：全量评测、灰度和生产门槛

**目标**：以可量化证据决定是否将增强链路设为默认。

**工作项**：

- 完成黄金集、变体集、多轮集、反例集和真实 Wyn UAT；
- shadow 对比旧/新 Planner，统计准确率、延迟、澄清和失败类型；
- 进行模型/Prompt/Skill/编译器版本对比；
- 先管理员灰度，再指定用户灰度；
- 更新完整开发、测试、UAT 和 Bug 闭环报告。

**主要模块**：评测 Harness、运行审计、Feature Flags、报告脚本。

**自动化测试**：全量回归、性能、并发、会话隔离、敏感信息扫描和历史回放。

**真实 UAT**：管理员全量；受限账号可用后完成权限和行级权限对照；业务用户抽样验收。

**退出门槛**：达到第 15 节生产门槛；所有 P0/P1 缺陷关闭；无高风险自信误答；回滚演练通过。

**回滚**：按用户/会话切回稳定链路，保留全部运行证据；出现 P0 自信误答自动停止扩大灰度。

## 17. 执行顺序与依赖

```text
E0 -> E1 -> E2 -> E3 -> E4 -> E5 -> E6 -> E7 -> E8
       |           |           |
       +-- 可先修当前问题       +-- 高级问题族按操作逐项启用
```

- E0-E4 可使用当前管理员 Token 和指定销售数据集立即推进；
- E5 的高级操作按 Wyn 已验证能力逐项启用，不等待所有外部依赖；
- E6 的本地 Skills 可立即推进，用户级真实作用域依赖后续账号；
- E8 的权限/行级权限生产结论依赖用户提供两类账号；
- 非索引精确聚合结论依赖一个关闭 Wyn 索引的数据集；在此之前必须保留“未验证”状态；
- 向量库、复杂 RAG 和任意 Join 不阻塞本计划的核心语义准确性工作。

## 18. 风险和控制

| 风险 | 控制措施 |
| --- | --- |
| LLM 输出波动 | 严格 Schema、低温度、黄金集、结果不变量、版本锁定和 shadow 对比 |
| 延迟增加 | 复杂度路由、语义缓存、并行元数据准备、流式状态和超时预算 |
| 过度澄清 | 槽位级置信度、可回答风险分级和澄清精度指标 |
| 规则与 LLM 冲突 | 两者输出同一 BusinessIntent，并由同一 Validator 仲裁 |
| Skill 污染口径 | 优先级、审核、冲突检测、版本回滚和离线评测 |
| 样本被当成精确总量 | 查询前精度要求 + 结果范围验证 + UI 独立披露 |
| 模型升级回归 | 固定回放集和旧/新版本对比，不直接覆盖生产版本 |
| 权限误判 | 用户 Token 穿透实测；管理员结果不能代表普通用户权限 |
| 复合分析伪结论 | 查询 DAG、白名单计算、Evidence 完整性和非因果措辞 |

## 19. 阶段报告与 Bug 留痕模板

每个阶段完成时追加以下记录到 `DEVELOPMENT_PROGRESS_REPORT.md`：

| 日期 | 阶段 | 功能开发 | 自动化测试 | 真实 Wyn UAT | 结果 | Bug/状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | E1 | ... | 通过数/总数及失败项 | 用例、账号类型、数据集 revision | 通过/有条件通过/失败 | B-xxx：开放/已修复/已关闭 | artifact 路径 |

Bug 必须记录：编号、严重度、复现问题、期望意图、实际意图、实际 Canonical、影响、根因、修复、自动回归、真实 UAT 和关闭证据。未执行的 UAT 明确写“未开始”，不能用自动化测试代替。

## 20. 当前启动判定

E0-E4 具备立即开发条件，不需要新的外部信息。E5-E7 中不依赖新账号和新数据集的部分也可连续推进。以下项目先登记为依赖项，但不阻塞可做工作：

1. 两类受限 Wyn 账号：用于数据集权限、行级权限和用户级 Skill 作用域 UAT；
2. 一个未启用 Wyn 索引的数据集：用于区分明细样本与精确聚合能力；
3. 业务方对财年、特殊指标口径和领域 Skill 的确认：对应能力开发到可验证阶段时按具体差异确认。

本计划的第一优先级是消除“查询执行精确但回答语义错误”的自信误答；在此基础上，再扩展复杂问题、Skills 和组合页面能力。

## 21. 2026-08-22 实施状态更新

| 能力 | 状态 | 本批证据 | 后续 |
| --- | --- | --- | --- |
| E0 黄金失败集 | 已落地首批 | 修复前 9 项用户 UAT、B-010 至 B-014、修复后 9 项回归 | 扩展为跨数据集和更多表达变体 |
| E1 BusinessQueryIntent/TimeSemantics | 核心完成 | v2 Schema、ConstraintLedger、多年份/相对年份/两位年份、Asia/Shanghai | 财年、节假日和非连续期间查询仍待业务确认 |
| E2 语义候选与 LLM | 核心接线完成 | 元数据描述/同义词候选；LLM `planQueryIntent` 输出同一 v2 模型 | 完整字段检索评分、shadow 对比继续增强 |
| E3 编译/结果验证 | 核心完成 | Canonical required*、minimumRows、timeZone；缺年份验证失败 | 多查询 DAG、同比环比不变量待 E5 |
| E4 ConversationState v2 | 核心完成 | activeBusinessIntent、constraintLedger、SkillRefs、timeZone 持久化；真实三轮通过 | 清除条件、下钻/上卷、并发版本冲突扩大测试 |
| E5 复杂问法 | 未全面启动 | 基础聚合、TopN、时间趋势可用 | 同比/环比/占比、多指标、复合查询 DAG |
| E6 Skills 领域覆盖 | 基础能力完成 | 销售 Skill 多轮继承和冲突治理 | 实验室/零售最小 Skill、组织/用户账号 UAT |
| E7 组合页面/UX | 本批范围完成 | 本地化时间、阶段/耗时、取消/重试、桌面/移动截图 | 澄清卡可编辑筛选、无数据/样本长会话扩展 |
| E8 全量评测/灰度 | 未启动 | 当前管理员数据集 9/9 | 受限账号、性能并发、生产 shadow 和回滚演练 |

本批详细证据：`test/uat-artifacts/intent-v2/2026-08-22/latest.json`。修复前证据未覆盖，仍保留在 `test/uat-artifacts/phase3-semantic-ui/2026-08-22/`，用于前后对照。

## 22. 2026-08-25 意图规划性能增强

### 22.1 新增生产门槛

语义准确性通过后，不能仍以不必要的大模型等待牺牲可用性。确定性意图同时满足以下条件时，必须直接进入查询：

1. 计划状态为 supported；
2. QuestionSemanticFrame → BusinessQueryIntent 约束覆盖校验通过；
3. 不存在 required=true 且未解决的约束；
4. Canonical 编译和结果校验边界不变。

复杂度不再作为强制调用大模型的条件。大模型只处理确定性路径未完整覆盖的模糊问题，其输出仍必须通过覆盖和 Canonical 编译校验。

### 22.2 可靠性控制

- 意图模型使用独立的 INTENT_LLM_TIMEOUT_MS，默认 10 秒；报告和开放探索仍使用通用 180 秒预算。
- 同一模型实例连续失败 2 次后熔断 60 秒，期间返回受控澄清。
- 浏览器取消传递到服务端意图 LLM；取消请求以 499 留痕。
- 响应和请求审计增加规划路径、规划耗时、LLM 是否调用及耗时。
- 前端等待提示改为通用状态，取消按固定计时器伪造后端执行阶段。

### 22.3 验收结果

“过去五年，每年的销售收入和同比增长率”从 180351ms 降至真实 API 379ms，服务端规划 7ms、LLM 0 次；输出 2021-2025 五个年度、销售收入、同比增长率和组合图。多轮追问“只看华东”保留全部上轮槽位，仅新增地区筛选，服务端 270ms、规划 1ms。

专项与全量自动化 145/145 通过，浏览器截图证据见 test/uat-artifacts/intent-latency-2026-08-25/。详细需求、设计和验收口径见 SMART_QUERY_INTENT_LATENCY_REQUIREMENTS_AND_DESIGN.md。
## 20. 风险分级和持续学习扩展

语义准确性不再只以销售黄金问题回归衡量。后续 Planner 按 low/medium/high 风险路由，完整约束覆盖只是执行条件之一；行业 Skill 覆盖、派生指标、高影响领域和置信度共同决定是否必须调用 LLM 或澄清。用户反馈通过版本化日志关联原问题、意图、查询和答案，形成待审核评测或 Skill 候选。完整设计见 SMART_QUERY_RISK_ROUTING_LEARNING_REQUIREMENTS_AND_DESIGN.md。

## 23. 2026-08-25 系统性语义修复完成

本轮以用户四类失败截图为阻断集，但实施范围落在共享语义平台，不增加固定问句特判。新增或增强：

- 开放式年度分区 TopN；
- orderCount 业务指标和 Skill 聚合口径；
- 单期间同比的内部计算维度与基期扩展；
- 大区、区域、地区实体映射；
- 追加式多轮操作；
- LLM 原问题覆盖与语义非扩张双重校验；
- 混合单位图表类型与解释一致性；
- 按 trace 的端到端日志回放。

生产门槛新增：当确定性意图已完整时，LLM 可以在同一语义槽位内复核或纠正字段，但不得无依据增加用户可见指标、维度或筛选；同比等计算依赖必须标记为 internal，并在结果投影前删除。

验收结果：npm test 164/164；真实 Wyn API 7/7；浏览器 7 张截图通过；9 事件 trace 完整。详细证据见 SMART_QUERY_SYSTEMIC_SEMANTIC_FIX_UAT_REPORT_2026-08-25.md。
## 2026-08-25 通用公式派生指标落地

状态：已完成。

- `QuestionSemanticFrame v2` 和 `BusinessQueryIntent v2` 已扩展公式派生指标、依赖、聚合顺序、单位、除零策略和 Skill 版本引用。
- `QueryProgram v1` 新增聚合后公式执行与内部指标裁剪。
- 销售 Skill 升级为 `sales-baseline@1.2.0`，毛利率口径为 `SUM(订单利润) / SUM(订单金额)`。
- 未审批率类指标必须澄清；LLM 不得遗漏、发明或修改生产公式。
- 专项自动化 11/11，真实 Wyn UAT 7/7，浏览器截图 3/3。
- 详细需求、设计、结果和缺陷闭环见 `SMART_QUERY_FORMULA_DERIVED_METRICS_REQUIREMENTS_DESIGN_AND_UAT_2026-08-25.md`。
