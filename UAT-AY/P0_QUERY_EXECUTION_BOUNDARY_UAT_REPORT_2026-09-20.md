# Smart Query P0 查询执行边界与派生计算治理 UAT 报告

## 1. 验收结论

- 验收日期：2026-09-20
- 验收入口：`http://127.0.0.1:8787/`
- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- 数据集修订：5
- 已加载 Skill：`sales-opportunity-a53@1.3.0`
- 验收范围：UAT-AY-001～UAT-AY-020
- 验收结果：20/20 通过
- 真实浏览器证据：20 张概述截图、19 张详情截图，共 39 张；UAT-AY-002 为预期澄清态，无查询详情页
- 查询结果契约：所有实际执行的查询均为 `accuracy=exact`、`isSample=false`、`isTruncated=false`
- 业务替代结果：未使用 fallback

UAT-AY-002 的问题缺少客户具体值，平台正确进入澄清态，没有猜测客户或返回伪结果，因此按预期通过。UAT-AY-003、UAT-AY-008、UAT-AY-013 在本轮初测中暴露平台通用缺陷，完成平台级修复后均通过同入口真实浏览器复测。

## 2. 执行边界验收口径

1. 源端筛选、分组、聚合、排序、排名、TopN 和明细读取由 Wyn 执行。
2. 平台不得先读取最多 20,000 行明细，再在本地重建业务筛选、聚合、排序或排名结果。
3. 平台派生计算采用默认拒绝策略，只允许白名单中已注册的操作，并且输入必须是完整、非样本、非截断且可校验的 Wyn 聚合结果。
4. 展示整理与语义校验不改变 Wyn 返回的业务事实。
5. 查询无法确定时进入澄清或能力不可用状态，不使用业务 fallback 伪造结果。

## 3. UAT 明细

| 编号 | 问题内容 | 测试结论 | 不通过原因分析 | 修复方案 | 修复验收情况 | 执行归属与结果契约 | Trace ID | 相关截图 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-AY-001 | 订单名称15247的商机金额是多少 | 通过 | 无 | 无需修复 | 返回 `412,228.87` 元，订单条件由 Wyn 筛选。 | Wyn；1 行；精确、完整、非样本、非截断、无 fallback | `trace-afd59c74-b2aa-40dd-b416-5c3feb1a3d77` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-001-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-001-detail.png) |
| UAT-AY-002 | 某个客户的商机金额是多少 | 通过（预期澄清） | 缺少客户具体值，无法形成确定查询。 | 无需修复；保留澄清机制。 | 页面显示“请明确要查询的客户具体值”，未执行猜测查询。 | 未执行查询；无业务 fallback | 无执行 trace | [澄清页面](p0-boundary-browser-2026-09-20/UAT-AY-002-overview.png) |
| UAT-AY-003 | 截止目前，Manufacturing product的占比是多少，具体金额是多少 | 通过（修复后） | 初测把“截止目前”错误物化为当天区间，遗漏此前历史数据，导致金额和占比偏低。 | 平台统一将“截止目前/截至目前/迄今/至今”物化为开放起点、仅含上界的累计区间；不覆盖 LLM/Skill 已选定的合法业务时间字段。占比只允许在完整 Wyn 聚合结果上执行白名单 `share-of-total` 派生。 | 筛选为 `赢单日期 < 2026-09-21`；返回 Manufacturing 金额 `2,403,914,608.08` 元，占比 `18.19%`。 | Wyn 筛选、分组、聚合；平台受治理派生 `share-of-total@1`；1 行；精确、完整、非样本、非截断、无 fallback | `trace-cbdf85b3-c226-45c4-95ab-fb4904c8714c` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-003-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-003-detail.png) |
| UAT-AY-004 | 我的客户中head_office_location是美国的名单 | 通过 | 无 | 无需修复 | 返回美国客户名单，共 7 个客户。 | Wyn；7 行；精确、完整、非样本、非截断、无 fallback | `trace-6be0f3f6-a57e-43ca-8501-21aad5d4234f` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-004-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-004-detail.png) |
| UAT-AY-005 | 所有财年中，我的客户中head_office_location是美国和法国的名单 | 通过 | 无 | 无需修复 | 未增加时间限制；返回美国或法国客户名单，共 7 个客户。 | Wyn；7 行；精确、完整、非样本、非截断、无 fallback | `trace-ffc84f5f-f756-44c7-b3f3-bbdf4f6d152f` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-005-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-005-detail.png) |
| UAT-AY-006 | 所有财年中，我的客户中HQ是美国和法国的名单 | 通过 | 无 | 无需修复 | HQ 正确映射为客户母公司所在地；返回 7 个客户。 | Wyn；7 行；精确、完整、非样本、非截断、无 fallback | `trace-68320afc-ad1b-4a7a-a714-135764953591` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-006-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-006-detail.png) |
| UAT-AY-007 | 我的POE客户名单 | 通过 | 无 | 无需修复 | POE 映射为规范源值并使用多值成员包含；返回 7 个客户。 | Wyn；7 行；精确、完整、非样本、非截断、无 fallback | `trace-71721e9d-8643-4fb0-9119-28f95de35d5e` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-007-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-007-detail.png) |
| UAT-AY-008 | 我的POE、MNC客户名单 | 通过（修复后） | 查询结果正确，但初测概述出现 `POE（Private Entity（POE））`、`MNC（Multinational Corporation（MNC））` 的简称重复嵌套。 | 平台通用识别查询枚举值中的“全称（简称）”，Narrator 出现重复嵌套时有限重试；不写 POE/MNC 单点替换，不产生 fallback。 | 概述变为“查询客户类型为 POE 或 MNC 的客户名单，共返回 7 个客户。” | Wyn；7 行；精确、完整、非样本、非截断、无 fallback | `trace-bd1988fb-ce51-4518-837f-df9e9610df45` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-008-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-008-detail.png) |
| UAT-AY-009 | 所有财年中，我的POE客户名单 | 通过 | 无 | 无需修复 | 未增加时间限制；返回 7 个 POE 客户。 | Wyn；7 行；精确、完整、非样本、非截断、无 fallback | `trace-85588779-4e43-4a56-a8ae-9d8fac05c5e0` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-009-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-009-detail.png) |
| UAT-AY-010 | 我最热卖的product是什么，是哪些客户 | 通过 | 无 | 无需修复 | 最热卖产品为 `Digital Ecosystem Enterprise Alliances`，销售额 `2,753,703,370.49` 元，涉及 7 个客户。 | Wyn 多阶段查询：产品聚合、排序与 Top1 后由 Wyn 下钻客户；精确、完整、非样本、非截断、无 fallback | `trace-9a99a810-6687-40de-b834-a7451c9999fa` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-010-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-010-detail.png) |
| UAT-AY-011 | 请列举去年Digital Ecosystem Enterprise Alliances 产品的客户名单，及每个客户的订单金额 | 通过 | 无 | 无需修复 | “去年”使用上一赢单财年 FY26；返回 1 个客户，订单金额 `1,897,687,040` 元。 | Wyn；1 行；精确、完整、非样本、非截断、无 fallback | `trace-106c9e5a-c790-4b8c-b244-cf2fc206fec0` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-011-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-011-detail.png) |
| UAT-AY-012 | x-ssl的项目有哪些 | 通过 | 无 | 无需修复 | `xssl = 1` 由 Wyn 筛选；返回 13,802 个项目，页面应用前端分页。 | Wyn；13,802 行；精确、完整、非样本、非截断、无 fallback | `trace-c6ca230c-1292-4137-8712-20cbf7b6e50a` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-012-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-012-detail.png) |
| UAT-AY-013 | 去年x-ssl的项目有哪些，请列出项目的名称，pursuit leader、oppo partner、product、client等信息 | 通过（修复后） | 初测将普通“上一赢单财年 FY26”误当成当前锚定 FY27，导致合法计划被错误阻断。 | 财年锚点校验仅对“当前/锚定/目标/本次财年”等明确表达生效；普通上一财年按请求期间校验。 | 使用 FY26；返回 48 行完整结果，包含项目、pursuit leader、oppo partner、product、client。 | Wyn；48 行；精确、完整、非样本、非截断、无 fallback | `trace-9607b997-bb45-4c01-8b5c-350af43adc87` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-013-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-013-detail.png) |
| UAT-AY-014 | 有什么recurring的项目 | 通过 | 无 | 无需修复 | 优先使用 recurring 字段，按包含 `Yes` 的成员语义筛选；返回 11,830 个项目。 | Wyn；11,830 行；精确、完整、非样本、非截断、无 fallback | `trace-6951b962-4d44-426f-a887-b7e0a1e3611a` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-014-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-014-detail.png) |
| UAT-AY-015 | 有哪些商机是 PSM的，prime office 是哪里 | 通过 | 无 | 无需修复 | PSM 映射为 `is_subcode = 1`；返回商机和 prime office，共 7,659 行。 | Wyn；7,659 行；精确、完整、非样本、非截断、无 fallback | `trace-b2b62e62-4f3e-42a1-93d4-b1fdd11bcea1` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-015-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-015-detail.png) |
| UAT-AY-016 | 去年，有哪些商机是 PSM的，prime office 是哪里，请列出项目名称、client等信息 | 通过 | 无 | 无需修复 | 使用 FY26；PSM 映射为 `is_subcode = 1`；返回项目、客户和 prime office，共 6 行。 | Wyn；6 行；精确、完整、非样本、非截断、无 fallback | `trace-c65baca9-a8ce-44cf-8e03-509f116b215e` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-016-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-016-detail.png) |
| UAT-AY-017 | 有哪些商机是 PSM的，prime office 是哪里，请列出项目名称、client name、客户类型、product等信息 | 通过 | 无 | 无需修复 | 返回项目、客户、客户类型、product 和 prime office，共 7,655 行。 | Wyn；7,655 行；精确、完整、非样本、非截断、无 fallback | `trace-15d206ce-fdc5-404f-bf71-4ea622253717` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-017-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-017-detail.png) |
| UAT-AY-018 | MNC、POE客户的商机金额是多少 | 通过 | 无 | 无需修复 | MNC、POE 使用同字段多值成员包含；商机金额合计 `10,811,846,592.18` 元。 | Wyn；1 行；精确、完整、非样本、非截断、无 fallback | `trace-55d30620-6b1b-4d06-9dae-21875b4a2232` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-018-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-018-detail.png) |
| UAT-AY-019 | MNC 客户的商机金额 大于20万的商机有几个 | 通过 | 无 | 无需修复 | MNC 成员包含及金额大于 200,000 均由 Wyn 执行；去重商机数为 4,301。 | Wyn；1 行聚合；精确、完整、非样本、非截断、无 fallback | `trace-609e4a56-74f3-4eb1-b944-d6d452641d5e` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-019-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-019-detail.png) |
| UAT-AY-020 | MNC 客户的商机金额 大于20万的商机，分别是哪些客户、product | 通过 | 无 | 无需修复 | 返回 516 个客户-product 去重组合，涉及 7 个客户和 89 个产品；页面显示 6 页。 | Wyn；516 行；精确、完整、非样本、非截断、无 fallback | `trace-9f875aa1-e7fa-49c2-a2ca-f0a464c69b50` | [概述](p0-boundary-browser-2026-09-20/UAT-AY-020-overview.png) / [详情](p0-boundary-browser-2026-09-20/UAT-AY-020-detail.png) |

## 4. 本轮平台级缺陷闭环

### 4.1 累计时间区间守恒

- 缺陷：相对时间语义“截止目前”被错误收窄为当天区间。
- 风险：查询执行成功但历史记录被静默遗漏，属于高风险事实错误。
- 平台修复：统一累计时间协议为开放起点、仅含上界的区间；结构化基线只纠正区间形状，不覆盖合法业务时间字段。
- 验收：UAT-AY-003 返回正确累计金额和占比，详情显示 `赢单日期 < 2026-09-21`。

### 4.2 财年锚点与请求期间分离

- 缺陷：普通“上一赢单财年 FY26”被当作当前锚定 FY27 校验。
- 风险：合法查询计划在执行前被错误拒绝，用户直接得不到结果。
- 平台修复：只有明确表达“当前/锚定/目标/本次财年”时才按当前锚点验证，上一财年等请求期间独立校验。
- 验收：UAT-AY-013 使用 FY26 并返回 48 行完整结果。

### 4.3 枚举简称展示规范化

- 缺陷：Narrator 对已经包含简称的规范枚举值再次包裹简称。
- 风险：查询事实正确但面向用户的概述不专业、难读。
- 平台修复：通用识别“全称（简称）”结构，重复嵌套时有限重试；不硬编码销售场景、不生成替代答案。
- 验收：UAT-AY-008 的用户概述已显示为“POE 或 MNC”。

## 5. 最终判定

本轮 P0 查询执行边界与派生计算治理达到当前验收目标：Wyn 继续拥有业务查询执行权，平台本地业务结果重建路径被默认拒绝，受治理派生计算可审计，20 个真实用户问题均取得预期结果或预期澄清。权限穿透、非索引数据集和 Wyn 原生分页不属于本轮范围，未纳入本报告结论。
