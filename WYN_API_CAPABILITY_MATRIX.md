# Wyn API 能力矩阵

> 验证批次：Phase 0 / 2026-08-22（管理员 Token；最新矩阵 11/11）
> 
> 验证数据集：`2b445034-38fe-4350-9cab-b7684c28b5f8`（AI对话分析-销售数据）、`ebbbbf49-60dd-4761-9722-fa6543eac4a9`（智慧试验室运营中心数据AI）、`8875ab24-8d24-4a9e-be39-01e44a5678a9`（零售数据）
> 
> 当前身份：管理员 Token

## 1. 接口依据

官方文档：

<https://www.grapecity.com.cn/solutions/wyn/help/docs/embedded-integration/data-query-api>

现有项目已使用的接口：

| 能力 | 接口 | 当前项目位置 | 状态 |
| --- | --- | --- | --- |
| 数据集发现 | `POST /api/v2/common/documents/search` | `server.mjs:loadDatasetDocuments` | 已验证 |
| 数据集定义 | 文档返回的 `contentUrl` | `server.mjs:loadDatasetMetadata` | 已验证 |
| 数据集查询 | `POST /api/v2/data/datasets/{id}/query` | `server.mjs:executeDatasetQuery` | 已验证 |
| Wyn AI 问数代理 | `POST /api/v2/chat/analysis/queries` | `server.mjs:handleChat` | 旧链路，不作为新问数核心 |

官方文档明确的数据集查询 POST 结构：

```json
{
  "QueryType": "NONE|WAX",
  "Query": "WAX expression or empty",
  "DatasetParameters": {},
  "Format": "Arrow|Json",
  "Options": {}
}
```

已确认的选项包括：`RowLimit`、`UnknownTypeHandle`、`MissParameterHandle`。

官方文档同时说明：用户上下文和组织上下文参数不能通过请求参数伪造，只能从当前用户声明读取。这为权限验证提供了明确依据，但不等同于固定服务端 Token 自动代表浏览器用户。

## 2. 元数据实测结果

通过项目接口：

```text
GET /api/datasets/2b445034-38fe-4350-9cab-b7684c28b5f8/metadata
```

实测结果：

| 项目 | 结果 |
| --- | --- |
| 数据集名称 | AI对话分析-销售数据 |
| revision | 7 |
| supportChatAnalysis | true |
| indexed | true |
| 字段数 | 27 |
| 时间字段 | 订购日期 |
| 指标字段 | 订单单价、购买数量、标准价格、进货价格、订单金额、订单利润 |
| 维度字段 | 支付方式、运货商、商品名称、类别名称、客户名称、员工姓名、供应商名称 |
| 地理字段 | 客户地区、客户省份、客户城市、经度、纬度等 |
| AI 数据集描述 | 用于销售场景业务分析 |
| 字段级描述 | 订单金额：订单金额在30万以上的就是重点客户 |
| 字段级同义词 | 当前数据集返回数量为 0 |
| 层级定义 | 当前规范化结果未发现独立层级结构 |
| 计算字段 | 当前 `WAXExpressions` 数量为 0 |
| 默认聚合 | 当前 27 个字段的 `Aggregation` 均未返回值 |

结论：当前数据集提供了可用的字段、类型、AI 描述和地理提示，但“层级、同义词、默认聚合、计算字段”不能假设一定存在，需要在其他真实数据集和原始定义 Fixture 中继续确认。

## 3. 查询实测结果

### 3.1 NONE

请求：

```json
{
  "QueryType": "NONE",
  "Query": "",
  "Format": "Json",
  "Options": {
    "RowLimit": "5",
    "UnknownTypeHandle": "CastToString",
    "MissParameterHandle": "Error"
  }
}
```

结果：成功返回销售明细，包含订单编号、订购日期、客户、地区、订单金额、订单利润等字段。

注意：Wyn 实际响应体是带 BOM 的 JSON 字符串，字符串内部再次包含 JSON 数组。已在 `server.mjs` 修复为兼容单层和嵌套 JSON 的解析方式。

### 3.2 WAX 概览

使用现有 `buildAnalysisQueryBundle()` 生成的受控 WAX：

```text
EVALUATE ROW(...)
```

结果：成功返回一行聚合结果：

| 指标 | 值 |
| --- | ---: |
| source_rows | 6,793 |
| total | 24,613,596.8 |
| orders | 6,793 |
| profit | 11,855,100.8 |
| date_min | 2017-01-01 |
| date_max | 2025-02-19 |

### 3.3 当前能力矩阵

| 能力 | 文档依据 | 真实验证 | 结论 |
| --- | --- | --- | --- |
| NONE 明细 | 数据集支持 NONE | 已验证 | 可用，必须受 RowLimit 约束 |
| WAX 聚合 | 缓存数据集支持 WAX | 已验证 | 可用 |
| WAX 分组 | WAX 返回表对象 | 已验证客户地区、客户、月份 | 可用，受控分组最多两维 |
| 时间粒度 | 由 WAX 表达式和应用归一化处理 | 已验证月度、季度、年度粒度 | 可用；应用按 UTC 归并，时区边界仍需业务确认 |
| 排序 | WAX `TOPN` 受控编译 | 已验证区域降序 | 可用；空值顺序待扩展 |
| 字面量过滤 | 受控 WAX 编译 | 已验证字符串、数字、日期、`in`、`isNotNull` | 可用；空值正向筛选未开放 |
| 字段比较 | 受控 WAX 编译 | 已验证数值字段比较（订单金额 > 订单利润） | 可用首期；日期字段比较仍需业务场景验证 |
| RowLimit | 官方 Options | 已验证返回受限数据 | 可用；应用区分 `limitReached` 与 `isTruncated`，Wyn 未提供确定性截断标志时标记 `truncationConfidence=possible` |
| 分页 | 数据集查询文档未确认统一分页协议 | 未验证 | 第一阶段不依赖分页，使用受控 RowLimit |
| Arrow | 官方 Format | 未验证 | 后续可作为性能优化，不阻塞 JSON MVP |
| 用户上下文参数 | 官方文档声明只能从用户声明读取 | 未验证 | 需要两用户权限 UAT |
| 非索引精确聚合 | 当前数据集 indexed=true | 未验证 | 需要非索引数据集对照 |

## 4. 当前发现的 Bug

| 编号 | 严重度 | 描述 | 状态 |
| --- | --- | --- | --- |
| B-001 | P1 | Wyn 数据查询返回 JSON-encoded string 时，项目只解析一层，导致真实 rows 被识别为空 | 已关闭：BOM/嵌套 JSON 解析修复后管理员真实 UAT 和查询矩阵通过 |

## 4.1 多数据集真实 UAT（2026-08-22）

证据文件：`test/uat-artifacts/phase0/multi-dataset-latest.json`，管理员服务 `http://127.0.0.1:8818`，4/4 通过。

| 数据集 | revision | indexed | 字段数 | 真实查询证据 |
| --- | ---: | --- | ---: | --- |
| AI对话分析-销售数据 | 7 | true | 27 | 元数据目录读取；本批次作为跨数据集目录基线 |
| 智慧试验室运营中心数据AI | 3 | true | 73 | 按“科室名称”聚合“总TAT”平均值和记录数，返回 20 行 |
| 零售数据 | 3 | true | 20 | 按“类别名称”聚合“订单金额/订单利润”，返回 8 行 |

实验室数据集字段语义描述覆盖 73 个字段，包含总 TAT、达标、通知耗时等业务描述；零售数据集字段语义描述覆盖 5 个字段，包含客户分级和“销量=订单金额”等规则。三个数据集本批次均返回 `indexed=true`，因此非索引数据集精确聚合仍不能宣称已验证。

## 5. 下一批 Phase 0 探针

1. 在获得受限账号后完成数据集权限和行级权限对照。
2. 在获得非索引数据集后完成精确聚合与样本边界对照。
3. 若 Wyn 提供明确协议，再验证分页和 Arrow 性能路径。

## 6. 真实回归记录（2026-08-22）

管理员 Token 下，指定数据集 `2b445034-38fe-4350-9cab-b7684c28b5f8` 的真实 UAT 已通过：

- 元数据：revision=7、27 个字段、`indexed=true`；
- 质量样本：5000 行，`isSample=true`、`limitReached=true`、`isTruncated=false`、`truncationConfidence=possible`；
- WAX 概览：source_rows=6793、total=24613596.8、orders=6793、profit=11855100.8；
- WAX 客户/地区聚合：分别返回 91 行和 6 行，未达到上限；
- 独立会话：创建会话、发送“查看销售额趋势”成功，返回 `wynai.insight-document/v1`，包含 KPI、文本、图表、表格和范围告警。
- Canonical 查询矩阵：月/季/年粒度、区域/类别聚合排序、数值字段比较、字符串/数字/日期/`in`/`isNotNull` 过滤共 11/11 通过，证据见 `test/uat-artifacts/phase0/query-matrix-latest.json`。
- 多数据集 UAT：三个真实数据集元数据、实验室 TAT 聚合、零售销售/利润聚合和 indexed 事实共 4/4 通过，证据见 `test/uat-artifacts/phase0/multi-dataset-latest.json`。

尚未宣称通过的能力：双账号数据集/行级权限、非索引数据集精确聚合、统一分页协议、Arrow 性能路径。
