# Smart Query 查询边界修复最终 UAT 报告

## 1. 验收范围

- 验收实例：`http://127.0.0.1:8787/`
- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- Skill：`sales-opportunity-a53@1.3.0`
- 验收日期：2026-09-21（Asia/Shanghai）
- 浏览器方式：Codex 内置浏览器，真实页面操作、真实页面截图
- 结果边界：筛选、分组、聚合、排序必须由 Wyn 执行；平台仅执行已登记的受治理派生计算和结果校验；未使用业务 fallback、样本结果或平台本地重建结果。

## 2. 重点 UAT 表

| 用例 | 问题内容 | 测试结论 | 不通过原因 | 修复方案 | 修复验收情况 | 相关截图 |
|---|---|---|---|---|---|---|
| UAT-AY-003 | 截止目前，Manufacturing product 的占比是多少，具体金额是多少 | 通过 | — | 保持“截止目前”开放起点、仅物化上界；Wyn 完成筛选和金额聚合，平台只执行白名单 `share-of-total` | 返回金额 `2,403,914,608.08` 元，占比 `18.19%`；详情显示 `赢单日期 < 2026-09-22`、1 行完整结果、无样本/截断/fallback | [概述](final-browser-after-fix/UAT-AY-003-overview.png) / [详情](final-browser-after-fix/UAT-AY-003-detail.png) |
| UAT-AY-011 | 请列举去年 Digital Ecosystem Enterprise Alliances 产品的客户名单，及每个客户的订单金额 | 通过 | — | 由 Skill 和 Wyn 字段语义绑定产品与金额；“每个客户”形成客户分组，订单金额作为 Wyn 聚合指标 | FY26 返回客户4，金额 `1,897,687,040` 元；1 行完整结果，FY26 源端筛选保留，无样本/截断/fallback | [概述](final-browser-after-fix/UAT-AY-011-overview.png) / [详情](final-browser-after-fix/UAT-AY-011-detail.png) |
| UAT-AY-023 | 不是 MNC 和 POE 客户的商机金额是多少 | 通过 | — | 使用客户类型多值字符串的 `notContainsAny` 语义，并编译为 Wyn 源端排除条件 | 返回 `2,401,301,728.07` 元；详情显示客户类型不包含 POE、MNC，1 行完整结果，无平台二次过滤/fallback | [概述](final-browser-after-fix/UAT-AY-023-overview.png) / [详情](final-browser-after-fix/UAT-AY-023-detail.png) |
| UAT-AY-030 | 请列举去年 Risk Management 产品的客户名单，及每个客户的订单金额 | 通过 | — | 由 Skill 将 Risk Management 绑定到产品小类，Wyn 执行 FY26 和产品筛选后按客户聚合 | 返回客户5，金额 `63,411,897.34` 元；1 行完整结果，产品小类与 FY26 条件一致，无样本/截断/fallback | [概述](final-browser-after-fix/UAT-AY-030-overview.png) / [详情](final-browser-after-fix/UAT-AY-030-detail.png) |
| B-003 | 去年 x-ssl 且 recurring 的项目有哪些？请返回项目名称、客户名称、recurring 类型和订单金额 | 通过 | — | recurring 按 Skill 规定使用字段本身，`recurring containsAny Yes`、`xssl = 1`、FY26 均进入 Wyn 源查询；项目、客户、recurring 作为输出维度 | 返回 6 个项目、3 个客户，订单金额合计 `61,598,555.89` 元；6 行完整结果，三项筛选均保留，无样本/截断/fallback | [概述](final-browser-after-fix/B-003-overview.png) / [详情](final-browser-after-fix/B-003-detail.png) |
| B-010 | 去年 Digital Ecosystem Enterprise Alliances 产品中 POE 客户有哪些，列出客户、项目、订单金额和创建日期 | 通过 | 修复前模型已返回金额源字段，但平台字段角色归一化只检查元数据字段名，未检查 Skill 指标同义词“订单金额”，误删 `Opportunity_amount_CNY`，随后约束守恒校验将请求错误判为失败 | `explicitMeasureDimensionFields` 统一读取 Wyn 元数据和绑定 Skill 的指标名称/同义词；明确返回字段时保留真实金额源字段投影，不引入场景关键词或固定问句分支 | API 独立重跑 `3/3` 通过；最新 8787 浏览器返回 0 行完整结果，详情保留客户、项目、订单金额、创建日期，源端筛选完整，控制台 error/warn 为 0 | [概述](final-browser-after-fix/B-010-overview.png) / [详情](final-browser-after-fix/B-010-detail.png) |

## 3. 全量回归门禁

最终 API 发布门禁结果：`52/52` 通过，`0` 失败，`releaseReady=true`。

覆盖范围包括：

- `UAT-AY-001` 至 `UAT-AY-034`
- `B-001` 至 `B-010`
- `UAT-EXPLAIN-001` 至 `UAT-EXPLAIN-004`
- `UAT-SEM-002` 至 `UAT-SEM-004`
- `MV-002`

门禁证据：[`api-release-gate.json`](final-api-after-skill-synonym/api-release-gate.json)

补充证据：

- B-010 独立 API 重跑 1：[`api-release-gate.json`](verify-b010-skill-synonym/api-release-gate.json)
- B-010 独立 API 重跑 2：[`api-release-gate.json`](verify-b010-skill-synonym-repeat-2/api-release-gate.json)
- B-010 独立 API 重跑 3：[`api-release-gate.json`](verify-b010-skill-synonym-repeat-3/api-release-gate.json)
- 定向单元/语义回归：`test/semantic-constraint-preservation.test.mjs`，49/49 通过

## 4. 结论与边界

本轮发现并修复的是平台级字段角色归一化缺口，不是 B-010 的单点问句修复。修复依赖 Wyn 元数据中的字段角色和 Skill 中已治理的指标名称/同义词，可泛化到其他“业务金额别名不同于物理字段名”的明细投影问题。

本轮没有改变以下边界：

1. 不把普通名单问题强制转换为固定 `detail` 或 `NONE` 路径。
2. 不在平台读取明细后重新执行业务筛选、聚合或排序。
3. 不使用 fallback 作为业务结果。
4. 不把用户未要求但数据集中真实存在的字段一律判为错误；本轮只校验用户明确要求的字段是否保留。

