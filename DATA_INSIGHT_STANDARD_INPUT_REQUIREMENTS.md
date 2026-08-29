# 数据洞察标准输入协议与 Wyn 问数接入需求

> 文档版本：1.0
>
> 目标协议：`wynai.insight-input/v1`
>
> 状态：当前阶段需求与设计已确认，待开发验收
>
> 更新日期：2026-08-25（Asia/Shanghai）

## 1. 背景

当前“数据洞察”只接收 Wyn 问数产生的 `viewId`、`aggregationResult` 和 Pivot 结果，模块内部同时承担 Wyn 专属结果解析、结果缓存、数据预览和二次洞察。这使数据洞察无法作为独立能力被独立问数、未来业务功能、外部 API 或 MCP 复用。

目标架构是让数据洞察只依赖一个版本化标准输入协议。Wyn 问数、独立问数和未来其他来源在各自模块内完成结果适配，然后使用同一协议调用数据洞察。数据洞察不得解析或依赖任何来源的私有数据格式。

```text
Wyn 问数 -------- Wyn 结果适配器 ----┐
独立问数 ------- 独立问数适配器 -----+--> InsightInput v1 --> 数据洞察
未来功能 ------- 各自来源适配器 ------┘
```

## 2. 架构原则

1. 数据洞察对外只有一个标准输入协议，不提供 Wyn 专属输入分支。
2. 来源模块负责把私有结果转换为 `InsightInput v1`，数据洞察负责协议校验、存储、分析和展示。
3. `viewId`、`aggregationResult`、Pivot Payload 等 Wyn 私有概念只能存在于 Wyn 问数及其适配器中。
4. 数据洞察使用通用 `insightId` 标识一次已接收的洞察输入；来源 ID 只用于追溯和幂等，不作为数据洞察主键。
5. 前端、后端、外部 API 和 MCP 均可成为调用方；调用位置不改变业务协议。
6. “允许调用”与“数据可信等级”分离。认证主体来自会话、Token、API Key 或服务身份，不要求调用方在业务请求体中声明用户和组织。
7. 数据可信等级由服务端根据认证上下文判定。调用方不得通过请求体把自身数据声明为平台已验证数据。
8. 输入缺少范围、采样或截断信息时，数据洞察必须将相应状态标记为未知，不得默认数据为完整全量结果。
9. 协议允许后续增加来源类型，但数据洞察不得根据 `source.type` 选择不同的私有格式解析逻辑。

## 3. InsightInput v1

### 3.1 最小有效输入

```json
{
  "schema": "wynai.insight-input/v1",
  "title": "2025 年各区域销售额",
  "resultSets": [
    {
      "id": "sales-by-region",
      "schema": [
        { "name": "区域", "type": "string", "role": "dimension" },
        { "name": "销售额", "type": "number", "role": "measure" }
      ],
      "rows": [
        { "区域": "华东", "销售额": 1200000 }
      ]
    }
  ]
}
```

### 3.2 字段要求

| 字段 | 本期要求 | 说明 |
| --- | --- | --- |
| `schema` | 必填 | 固定为 `wynai.insight-input/v1` |
| `title` | 必填 | 本次结果或分析目标的可读标题 |
| `resultSets` | 必填 | 至少一个标准结果集 |
| `resultSets[].id` | 必填 | 输入内唯一的结果集 ID |
| `resultSets[].schema` | 必填 | 字段名称和字段类型；`role` 可选 |
| `resultSets[].rows` | 必填 | 二维对象行数组，字段必须受 Schema 约束 |
| `source` | 可选 | `type`、`sourceId`、`traceId` 等追溯信息 |
| `datasets` | 可选 | 数据集 ID、名称和 revision |
| `context` | 可选 | 原始问题、分析目标等业务上下文 |
| `scope` | 可选 | 筛选、时间范围、统计口径和结果范围 |
| `quality` | 可选 | 采样、截断、估算和告警；缺失时按 unknown 处理 |
| `evidence` | 可选 | 已有证据和可追溯引用 |

用户、组织和可信等级不作为业务请求体必填字段。部署启用身份和多租户后，这些信息由认证层提供，并由服务端写入审计与访问控制上下文。

### 3.3 本期接口

```http
POST /api/data-insights/inputs
GET  /api/data-insights
GET  /api/data-insights/{insightId}
POST /api/data-insights/{insightId}/generate
```

接收成功至少返回：

```json
{
  "schema": "wynai.insight-input-ack/v1",
  "insightId": "ins-...",
  "status": "accepted"
}
```

`POST /inputs` 必须执行版本、大小、结果集、Schema、行结构、字段引用和 ID 唯一性校验。错误输入必须返回明确的 4xx，不得进入洞察结果列表。

## 4. 当前阶段最小开发范围

当前阶段只有两个业务目标：完成 `InsightInput v1` 标准接入能力，以及完成 Wyn 问数按该标准接入数据洞察。为实现这两个目标所必需的数据洞察内部解耦属于本期范围。

### 4.1 交付一：InsightInput v1

1. 新增 `wynai.insight-input/v1` JSON Schema 和协议规范。
2. 实现标准输入的校验、规范化和错误响应。
3. 实现唯一标准接收接口，成功后生成通用 `insightId`。
4. 将数据洞察结果列表、详情读取和二次洞察改为围绕 `insightId` 工作。
5. 让现有数据预览、完整度统计、数值扫描、本地洞察和外部 LLM 洞察消费规范化结果，而不是消费 Wyn 私有结构。
6. 本期继续使用现有进程内结果存储和容量限制，不新增数据库或长期持久化。

### 4.2 交付二：Wyn 问数适配

1. 在 Wyn 问数模块边界内实现 Wyn 结果适配器。
2. 适配器负责解析 `viewId`、Wyn View、`aggregationResult` 和 Pivot Payload，并生成合法 `InsightInput v1`。
3. Wyn 问数获得可用结构化结果后，通过数据洞察唯一标准接收边界注册结果。
4. 数据洞察只保存通用 `insightId`、标准结果集和可选来源追溯信息，不再解析 Wyn 私有结构。
5. Wyn 问数现有“进入数据洞察”流程改为使用 `insightId`，用户体验和现有二次洞察能力保持可用。
6. 保留必要的来源追溯：`source.type=wyn-query`、原 `viewId` 和可用 trace 信息；这些字段不得成为洞察算法分支条件。

### 4.3 无兼容迁移

1. 本期采用后端、Wyn 问数适配器和前端同步切换的一次性迁移，不实现旧接口兼容层。
2. 删除 `GET /api/analysis-results`、`GET /api/analysis-results/{viewId}` 和 `POST /api/secondary-insights` 路由。
3. 数据洞察页面、自动化测试和 Wyn 问数入口必须同步切换到 `/api/data-insights` 系列接口。
4. 当前版本不承诺旧前端连接新后端，也不承诺项目外未登记调用方继续使用旧接口。
5. Wyn 问数内部可以继续使用 `viewId` 组织视图加载与结果捕获；跨越 Wyn 适配器边界后只能使用 `insightId` 和标准输入。

## 5. 当前阶段明确不做

- 独立问数接入数据洞察；
- 独立问数界面的“进入数据洞察”入口；
- MCP Server 或 MCP Tool 封装；
- 面向项目外部应用的 API 产品化、开发者门户或 SDK；
- OAuth2、API Key 管理、跨租户权限体系和公开互联网部署；
- 匿名调用策略和可信等级的完整产品化；
- `dataReference`、对象存储、大文件上传或超大结果集异步导入；
- 数据洞察算法、Prompt、报告能力或界面视觉重构；
- 数据洞察结果的数据库持久化、历史归档和跨进程恢复；
- 为未来来源提前编写空适配器。

上述事项不得混入本期验收。独立问数接入将在本期完成并验收后单独立项。

## 6. 验收标准

### 6.1 协议验收

1. 合法最小输入可以注册并返回唯一 `insightId`。
2. 包含完整 scope、quality、source 和 evidence 的输入可以无损读取。
3. 错误协议版本、空结果集、重复结果集 ID、Schema 与行字段冲突、超出大小限制均返回明确 4xx。
4. 调用方未提供用户、组织、来源或可信等级时，只要满足最小协议仍可接收。
5. 未声明采样、截断和范围的信息在洞察详情中显示为 unknown，而不是完整或精确。

### 6.2 Wyn 问数端到端验收

1. 用户完成一次 Wyn 问数并加载结构化结果后，系统生成一个标准洞察输入和 `insightId`。
2. 用户可以从 Wyn 问数进入数据洞察，并看到与原结果一致的标题、字段、行数据和质量信息。
3. 数据预览、确定性统计和“开始洞察”均可正常完成。
4. 数据洞察接口和核心逻辑中不再要求 `viewId`、`aggregationResult` 或 Pivot Payload。
5. 相同来源结果重复注册时使用幂等规则避免产生无边界重复记录。
6. Wyn 结果为空、未加载或无法转换时给出明确状态，不注册伪造或空洞察结果。
7. 旧 `/api/analysis-results*` 和 `/api/secondary-insights` 路由返回 404，不再作为可用接口。

### 6.3 回归验收

1. Wyn 问数原有查询、View 展示和流式响应不受影响。
2. 数据洞察原有结果列表、详情预览和二次洞察行为保持可用。
3. 自动化测试覆盖协议校验、Wyn 适配器、标准接收边界和端到端主路径。
4. 项目现有自动化测试全部通过，并完成一次真实 Wyn 环境浏览器验收。

## 7. 完成定义

只有同时满足以下条件，本阶段才可关闭：

1. `InsightInput v1` Schema、接口、校验和测试均已落地；
2. 数据洞察核心只消费规范化标准输入；
3. Wyn 问数已通过自身适配器调用标准接收边界；
4. Wyn 问数到数据洞察的真实端到端验收通过；
5. 独立问数没有被隐式接入或作为本阶段完成条件；
6. 验收结果和遗留项已记录，随后才能启动“独立问数 + 数据洞察”增强开发。

## 8. 后续方向（非本期）

后续迭代可以在不改变数据洞察核心协议语义的前提下增加：独立问数适配器、MCP 封装、外部 API 认证、可信等级、`dataReference`、大结果集异步接入和持久化存储。若确需扩展字段，使用向后兼容的可选字段或发布新的协议版本，不允许来源模块绕过标准接入边界。

## 9. 技术设计

### 9.1 模块边界

```text
Wyn View 代理捕获
  |  viewId / View / aggregationResult / Pivot Payload
  v
WynQueryInsightAdapter                 数据洞察公共 API
  |  adapt()                              |  POST InsightInput v1
  |                                       |
  +--------------- InsightInput v1 -------+
                         |
                         v
                 InsightInput Normalizer
                 - 版本和大小校验
                 - ResultSet / Schema / Row 校验
                 - scope / quality 缺省规范化
                         |
                         v
                  DataInsightStore
                 - insightId
                 - 幂等更新
                 - 容量裁剪
                         |
             +-----------+-----------+
             |                       |
       列表与详情 API             洞察生成器
```

数据洞察协议、存储和生成器不得 import Wyn 适配器。Wyn 适配器可以依赖标准协议，并通过与公共 API 相同的注册服务写入数据洞察存储。

### 9.2 标准化结果集

每个结果集必须满足：

- `id` 在一个输入内唯一；
- `schema` 至少包含一个字段，字段名唯一；
- 每一行都是普通 JSON 对象；
- 行内不得出现 Schema 未声明字段；
- 非空值必须符合声明类型；
- 单次输入最多 8 个结果集、每个结果集最多 100 个字段和 5000 行；
- 未提供 scope 或 quality 时补为 unknown 状态，不能补为 exact、完整或全量。

本期支持 `string`、`number`、`integer`、`boolean`、`date`、`datetime`、`object`、`array` 和 `unknown` 字段类型。`unknown` 表示调用方无法稳定声明类型，不表示结果已经验证。

### 9.3 存储模型

数据洞察记录只保存：

```text
DataInsightRecord
  insightId
  createdAt
  updatedAt
  idempotencyKey
  input: InsightInput v1
```

列表摘要、行列数和完整度由标准 `resultSets` 计算，不保存来源私有字段。InsightRun、InsightDocument 和审计记录使用 JSON 持久化仓库，服务重启后可恢复；列表默认过滤软归档/软删除记录，详情、版本、导出和审计均按受信用户/组织身份过滤。

阶段 5/6 补充：正式生成必须走外部 LLM Planner/Critic/Narrator；服务端先构建 Evidence Pack，审计记录 Prompt hash、模型、Skill 版本、工具调用、阶段耗时和 `rawRowsToLlm=false`。配额、并发、重试、软归档/恢复/删除和敏感字段脱敏属于统一治理边界。

### 9.4 幂等策略

- 公共调用方可以通过 `Idempotency-Key` 请求头提供幂等键；
- 未提供显式幂等键，但同时存在 `source.type` 和 `source.sourceId` 时，服务端使用两者生成来源幂等键；
- 同一幂等键再次提交时更新原记录并保持 `insightId` 不变；
- 没有幂等信息的合法请求每次创建新记录；
- Wyn 问数使用 `wyn-query + viewId` 作为幂等来源，Aggregation 与 Pivot 分阶段到达时更新同一条记录。

### 9.5 Wyn 适配时序

1. Wyn 问数返回 `viewId`，前端加载 Wyn View。
2. View 代理捕获 data-insight 请求和 Pivot 响应。
3. Wyn 适配器在私有缓存中合并同一 `viewId` 的捕获片段。
4. 只有提取到非空二维结果后，适配器才生成 `InsightInput v1` 并注册。
5. 后续捕获到更完整结果或 View 定义时，以同一来源幂等键更新记录。
6. “进入数据洞察”按钮通过标准列表接口按 `source.type/source.sourceId` 定位 `insightId`，然后打开详情。

### 9.6 API 响应与错误

| 场景 | 状态码 |
| --- | --- |
| 标准输入创建或幂等更新成功 | `201` 或 `200` |
| JSON 或协议字段无效 | `400` / `422` |
| 请求体或结果集超出限制 | `413` / `422` |
| `insightId` 不存在 | `404` |
| 尚未捕获到指定 Wyn 结果 | 标准列表返回空集合，不创建占位记录 |
| 洞察模型调用失败 | `502`，保留已经注册的标准输入 |

错误响应统一包含可读 `message`，协议校验错误可附带 `code` 和 `path`，不得返回 Token、模型密钥或完整私有上游请求。

### 9.7 安全与开放性

本期公共接收接口不强制请求体包含用户、组织、来源或可信等级，也不实现新的认证产品。服务仍受现有部署边界保护。未来加入 API Key、OAuth2、MCP 或多租户时，在认证层形成主体与可信上下文，`InsightInput v1` 的数据语义无需随调用位置改变。
# 阶段 1 补充：InsightRun 运行关联

标准输入注册后必须返回 `insightId` 与 `runId`。`runId` 对应 `wynai.insight-run/v1`，默认以 `interpret` 模式进入 `queued`，后续通过状态机记录规划、执行、完成/失败、重试和生成版本；输入本身仍保持幂等，运行记录与输入记录分离。


# 阶段 1 补充：InsightRun 运行关联`n`n标准输入注册后必须返回 `insightId` 与 `runId`。`runId` 对应 `wynai.insight-run/v1`，默认以 `interpret` 模式进入 `queued`，后续通过状态机记录规划、执行、完成/失败、重试和生成版本；输入本身仍保持幂等，运行记录与输入记录分离。


阶段 4/5/6 补充：运行对象记录 Skill refs、诊断证据要求和 parentRunId；数据洞察与 AI 数据分析共用 InsightRun，运行接口按受信用户/组织身份过滤。

### 9.8 平台稳健性增强（2026-08-28）

标准输入契约保持不变。数据洞察内部对高维结果执行复杂度评估、Evidence Pack 预算和查询相关证据选择；LLM 生成结果支持 `completed/degraded/failed` 状态。证据校验失败只隔离无法验证的结论，确定性基础洞察可作为明确标记的降级结果返回。详见 `DATA_INSIGHT_PLATFORM_ROBUSTNESS_REQUIREMENTS_DESIGN_UAT_2026-08-28.md`。

### 9.9 平台化扩展要求（2026-08-28）

`InsightInput v1` 的语义和最小字段保持不变。数据洞察内部新增 Skill/Facts 质量层：标准输入规范化后先解析适用 Skill、生成 Business Fact Pack 和确定性业务事实，再进入 LLM 编排或领域化降级。调用方不需要感知内部使用的 Skill、Fact Pack 或 LLM 供应商，但运行审计必须记录这些信息。

阶段 A 仅实现销售领域事实能力和 Skill 绑定；独立问数适配器、MCP 和外部 API 产品化仍不纳入本阶段。平台与模块验收分别按 `PLATFORM_AND_MODULE_UAT_GOVERNANCE.md` 执行。
