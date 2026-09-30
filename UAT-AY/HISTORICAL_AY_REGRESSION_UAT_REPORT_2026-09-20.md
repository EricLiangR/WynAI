# AY 历史综合问题回归 UAT 截图验收报告

> 2026-09-20 当前状态更新：本报告发现的 AY-033 时间约束重复物化已完成平台级修复。专项自动化 24/24、全量 `npm test` 487/487、`npm run check` 通过；AY-033 连续 5/5 返回相同 2 行，AY-034 连续 3/3 保持合法 0 行，相关时间邻近回归通过。最后边界补丁后，AY-003、明确自然年和 AY-033 再次完成真实浏览器截图验收。原“不通过”记录及截图作为修复前历史证据保留，当前关闭证据见 [时间约束权威与 AY-033 防回归验收报告](TIME_AUTHORITY_REGRESSION_UAT_REPORT_2026-09-20.md)。

## 1. 验收结论

- 验收日期：2026-09-20
- 验收入口：`http://127.0.0.1:8787/`
- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- Skill：`sales-opportunity-a53@1.3.0`
- 本轮新增验收范围：`UAT-AY-021～034`、`B-001～B-010`、`UAT-EXPLAIN-001～004`、`UAT-SEM-002～004`、`MV-002`
- 历史登记编号：57 条（AY 34 条、B 10 条、EXPLAIN 4 条、SEM 3 条、MV 6 条）
- 直接执行并截图：52 条；其中最近一轮已通过的 `UAT-AY-001～020` 引用既有截图，本轮新增执行 32 条
- 等价覆盖：5 条旧 MV 编号，其问题文本和验收语义已被近期 AY 用例完整覆盖，不重复向 LLM 提交同一句问题
- 本轮新增浏览器截图：63 张；除澄清态 `UAT-SEM-004` 外，每条有概述和详情截图；`UAT-SEM-004` 只有概述截图是预期行为
- 连同最近一轮 `UAT-AY-001～020` 的 39 张截图，当前引用的真实浏览器证据共 102 张
- 当前总判定：56 条通过，1 条不通过；本轮新增执行为 31 条通过、1 条不通过；`B-001` 首次调用失败，重试后通过，但保留为稳定性风险
- 本轮没有修改代码

本轮特别覆盖了历史综合问题和 B 组复杂组合问题。除 `UAT-AY-033` 外，当前截图证据未发现新的稳定语义回归。`UAT-AY-033` 不是合法空结果，而是时间筛选被错误叠加导致的真实结果错误，应进入下一轮修复和复测。

`UAT-AY-001～020` 已在最近一轮真实浏览器验收中完成，本轮按约定不重复执行，引用既有报告：[P0 查询执行边界 UAT 报告](P0_QUERY_EXECUTION_BOUNDARY_UAT_REPORT_2026-09-20.md)。

旧 MV 专项中的 5 个未按原编号重跑的问题，均已由近期完全相同或语义等价的问题覆盖：

| 旧编号 | 旧问题 | 当前覆盖用例 | 覆盖结论 |
| --- | --- | --- | --- |
| MV-001 | 我的 POE 客户名单 | UAT-AY-007、UAT-AY-028 | 已以相同问题验证，返回 7 个去重客户 |
| MV-003 | 我的 POE、MNC 客户名单 | UAT-AY-008 | 已以相同问题验证，返回 7 个去重客户；旧报告按原始记录返回 20,000 行的行为已被当前正确的名单去重语义替代 |
| MV-004 | MNC、POE 客户的商机金额是多少 | UAT-AY-018 | 已以相同问题验证，返回 `10,811,846,592.18` 元 |
| MV-005 | 不是 MNC 和 POE 客户的商机金额是多少 | UAT-AY-023 | 已以相同问题验证，返回 `2,401,301,728.07` 元 |
| MV-006 | MNC 客户的商机金额大于 20 万的商机有几个 | UAT-AY-019 | 已以相同问题验证，返回 4,301 个去重商机 |

其中 MV-003 的旧验收结论不能继续作为当前预期：用户问的是“客户名单”，当前应按客户去重返回 7 个客户，而不是按底层销售记录返回 20,000 行。该变化是名单语义修正，不是结果缺失。

## 2. 验收口径和硬约束

1. 用户问题的语义理解由 LLM 驱动，不能用固定关键词规则替代。
2. 源记录筛选、分组、基础聚合、排序、排名、TopN 和明细读取必须由 Wyn 执行。
3. 严禁先读取 20,000 行明细，再由平台本地筛选、聚合、排序或排名。
4. 平台只能对 Wyn 返回的完整、非样本、非截断聚合结果执行已登记的二次操作，例如聚合结果阈值筛选。
5. 不允许业务 fallback 作为结果；无法确定时应进入澄清或能力不可用状态。
6. `0 行` 只有在查询条件已被完整执行且条件确实没有匹配数据时，才能判为合法空结果。
7. 每条用例的截图必须能确认用户问题、查询概述、查询条件、结果或明确的空结果状态。

## 3. 截图证据目录

本轮截图目录：`UAT-AY/historical-uat-browser-2026-09-20/`

截图命名规则：`<用例>-overview.png` 为用户概述和结果摘要，`<用例>-detail.png` 为技术详情、字段、执行归属、筛选和 trace。`B-001-retry-overview.png` 为首次失败后的重试成功证据。

## 4. 用例验收明细

| 编号 | 问题内容 | 测试结论 | 不通过原因分析 | 修复方案/现状 | 修复验收情况 | 执行归属与结果契约 | Trace ID | 相关截图 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-AY-021 | MNC 客户且 subsector 是 Food 的商机有多少个 | 通过 | 无 | 无需修复 | 返回 425 个去重商机，MNC 多值成员筛选和 Food 条件均保留 | Wyn 源筛选、聚合和去重计数；精确、完整、非样本、非截断、无 fallback | `trace-a11fc986-aa79-4206-93fd-10490307213b` | [概述](historical-uat-browser-2026-09-20/UAT-AY-021-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-021-detail.png) |
| UAT-AY-022 | MNC 客户是 Consumer Products 行业的商机有多少个 | 通过 | 无 | 无需修复 | 返回 877 个去重商机，客户类型和行业筛选均生效 | Wyn 源筛选、聚合和去重计数；精确、完整、非样本、非截断、无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-AY-022-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-022-detail.png) |
| UAT-AY-023 | 不是 MNC 和 POE 客户的商机金额是多少 | 通过 | 无 | 无需修复 | 返回未分组金额 `2,401,301,728.07` 元；排除条件为客户类型不包含任一 MNC、POE，没有错误增加客户分组 | Wyn 执行 `notContainsAny` 源筛选和金额聚合；精确、完整、非样本、非截断、无 fallback | `trace-9408e867-874f-4335-83a3-5b963fff41d4` | [概述](historical-uat-browser-2026-09-20/UAT-AY-023-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-023-detail.png) |
| UAT-AY-024 | x-ssl 的项目有哪些 | 通过 | 无 | 无需修复 | 返回 13,802 个项目，页面显示 139 页 | Wyn 执行 `xssl = 1` 源筛选；前端只负责已返回结果的分页展示；精确、完整、非样本、非截断、无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-AY-024-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-024-detail.png) |
| UAT-AY-025 | x-ssl 的项目有哪些（重复问题） | 通过 | 无 | 无需修复 | 与 AY-024 一致，返回 13,802 个项目、139 页 | Wyn 执行源筛选；未发生重复问题语义漂移 | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-AY-025-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-025-detail.png) |
| UAT-AY-026 | 今年 x-ssl 的项目有哪些 | 通过（按已确认口径改为去年） | 数据集没有当前财年数据，本轮按约定将“今年”改为“去年”执行 | 无需修复 | 使用 FY26，返回 9 个 x-ssl 项目 | Wyn 执行 x-ssl 和 FY26 源筛选；精确、完整、非样本、非截断、无 fallback | `trace-2d7264d3-6453-4cc5-9401-90719d27bd2a` | [概述](historical-uat-browser-2026-09-20/UAT-AY-026-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-026-detail.png) |
| UAT-AY-027 | Risk Management product 的占比是多少，具体金额是多少 | 通过 | 无 | 无需修复 | 金额 `1,027,238,235.36` 元，占比 `7.77%` | Wyn 执行筛选和聚合；平台仅对白名单、完整聚合结果执行 `share-of-total`；精确、完整、非样本、非截断、无 fallback | `trace-953c4969-02be-4d7a-861e-6984c8b2493a` | [概述](historical-uat-browser-2026-09-20/UAT-AY-027-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-027-detail.png) |
| UAT-AY-028 | 我的 POE 客户名单 | 通过 | 无 | 无需修复 | 返回 7 个 POE 客户 | Wyn 执行客户类型多值成员筛选和去重；精确、完整、非样本、非截断、无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-AY-028-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-028-detail.png) |
| UAT-AY-029 | 我最热卖的 product 是什么，是哪些客户 | 通过 | 无 | 无需修复 | 最热卖产品为 Digital Ecosystem Enterprise Alliances，涉及 7 个客户，销售额 `2,753,703,370.49` 元 | Wyn 多阶段执行产品聚合、排序、Top1 和客户下钻；精确、完整、非样本、非截断、无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-AY-029-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-029-detail.png) |
| UAT-AY-030 | 请列举去年 Risk Management 产品的客户名单及每个客户的订单金额 | 通过 | 无 | 无需修复 | FY26 返回 1 个客户，金额 `63,411,897.34` 元 | Wyn 执行 FY26、产品筛选和金额聚合；精确、完整、非样本、非截断、无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-AY-030-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-030-detail.png) |
| UAT-AY-031 | recurring 且产品是 Safety Production and Risk Control in Manufacturing 的有哪些 | 通过 | 无 | 无需修复 | 返回 137 条记录；recurring 使用包含 Yes 的成员语义 | Wyn 执行 recurring 和产品源筛选；精确、完整、非样本、非截断、无 fallback | `trace-5ed3a7b3-cab0-4b9b-8338-7eccd8db0cac` | [概述](historical-uat-browser-2026-09-20/UAT-AY-031-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-031-detail.png) |
| UAT-AY-032 | 按产品 level0 统计去年的总商机金额和商机数量 | 通过 | 无 | 无需修复 | FY26 返回 5 个产品大类；商机金额合计约 `1,973,924,783.45` 元；商机数量为 10 个去重商机 | Wyn 执行 FY26、产品大类分组、金额求和和 `pipelineCode` 去重计数；精确、完整、非样本、非截断、无 fallback | `trace-3d638341-3f96-4964-9d84-52f50ebee09d` | [概述](historical-uat-browser-2026-09-20/UAT-AY-032-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-032-detail.png) |
| UAT-AY-033 | 按产品大类统计财年 26 的总商机金额，并筛选总金额大于 1000 万 | 不通过 | 当前截图中聚合后筛选 `revenue > 10000000` 已保留，但同时错误生成了 `赢单日期 >= 2025-06-01` 和 `赢单日期 < 2026-06-01`。财年筛选和日期区间被错误叠加，导致结果从应有的 2 个产品大类变成 0 行 | 需要修复时间语义物化和财年筛选的互斥/守恒规则：用户明确指定财年时，不能由 LLM 或平台再追加未经请求的自然日期区间；保留 `赢单财年 = 26` 和 `revenue > 10000000` | 当前截图未通过；此前独立修复验收曾连续返回 2 行，但本轮回归重新暴露该问题，不能沿用旧轮次结论 | Wyn 应执行财年源筛选和产品大类聚合；平台只可在完整聚合结果执行 `resultFilters`。当前结果契约显示完整但事实范围错误 | `trace-e233d49d-e005-4597-8aa2-ae9a35fbee23` | [概述](historical-uat-browser-2026-09-20/UAT-AY-033-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-033-detail.png) |
| UAT-AY-034 | 按产品大类统计财年 26 的总商机金额和商机数量，并筛选总金额大于 1000 万且商机数量大于 3 | 通过（预期空结果） | 无 | 无需修复 | 详情显示两个聚合后条件 `revenue > 10000000`、`opportunity_count > 3`；返回 0 行，属于条件确实无匹配，不是查询失败 | Wyn 执行 FY26、分组、金额求和和去重计数；平台对完整聚合结果执行两个 AND 条件；无 fallback | `trace-da415104-eff7-44dc-844b-6da423b2da08` | [概述](historical-uat-browser-2026-09-20/UAT-AY-034-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-AY-034-detail.png) |
| B-001 | 去年 x-ssl 的项目，而且是 POE 类型的有哪些，返回项目名称、客户名称、销售总监、合作伙伴、创建日期、预计结束日期 | 通过（重试后；稳定性风险） | 首次真实调用返回 `Failed to fetch`，没有形成有效查询 trace；独立重试成功 | 需要继续分析 LLM/调用链稳定性，避免同一问题必须人工重试；本轮不把它归类为语义失败 | 重试返回 7 行，字段全部包含项目名称、客户名称、销售总监、合作伙伴、创建日期、预计结束日期；Wyn 条件包含 x-ssl、POE、FY26 | Wyn 执行源筛选和明细读取；精确、完整、非样本、非截断、无 fallback | 重试：`trace-be1eb034-a5b7-4e08-a908-6a18a28a897a`；首次无执行 trace | [首次失败概述](historical-uat-browser-2026-09-20/B-001-overview.png) / [重试成功概述](historical-uat-browser-2026-09-20/B-001-retry-overview.png) |
| B-002 | 去年 x-ssl 的 MNC 项目有哪些，列出项目、客户、产品、销售总监和商机金额 | 通过 | 无 | 无需修复 | 返回 36 条记录，涉及 7 个商机、3 个客户、7 个产品，字段完整 | Wyn 执行 x-ssl、MNC、FY26 源筛选和明细读取；无 fallback | `trace-fe78a95e-efce-4efc-8265-444bd3d7ea07` | [概述](historical-uat-browser-2026-09-20/B-002-overview.png) / [详情](historical-uat-browser-2026-09-20/B-002-detail.png) |
| B-003 | 去年 x-ssl 且 recurring 的项目，返回项目、客户、recurring 类型和订单金额 | 通过 | 无 | 无需修复 | 返回 28 条记录；x-ssl、recurring 包含 Yes、FY26 条件均保留 | Wyn 执行源筛选和明细读取；无 fallback | `trace-44dd976e-d661-4901-bffa-6a7120452784` | [概述](historical-uat-browser-2026-09-20/B-003-overview.png) / [详情](historical-uat-browser-2026-09-20/B-003-detail.png) |
| B-004 | 去年 POE 客户中 recurring 的项目，列出项目、客户、产品和预计结束日期 | 通过 | 无 | 无需修复 | 返回 18 条记录；POE、recurring、FY26 条件和要求字段均保留 | Wyn 执行多值成员筛选、recurring 筛选和明细读取；无 fallback | `trace-2bb213d5-bfc9-4a3d-b970-bdd764bd76b1` | [概述](historical-uat-browser-2026-09-20/B-004-overview.png) / [详情](historical-uat-browser-2026-09-20/B-004-detail.png) |
| B-005 | x-ssl 项目中哪些是 PSM，列出项目、客户、客户类型、prime office 和产品 | 通过 | 无 | 无需修复 | 返回 3,744 条记录；PSM 已编译为 `is_subcode = 1` 并进入 Wyn | Wyn 执行 x-ssl、PSM 源筛选和明细读取；无 fallback | `trace-ae16112b-9dfc-48d5-a823-8ada187aba84` | [概述](historical-uat-browser-2026-09-20/B-005-overview.png) / [详情](historical-uat-browser-2026-09-20/B-005-detail.png) |
| B-006 | 去年 PSM 且 x-ssl 的项目，列出项目名称和客户等信息 | 通过 | 无 | 无需修复 | 返回 26 条记录，项目和客户等字段完整 | Wyn 执行 PSM、x-ssl、FY26 源筛选和明细读取；无 fallback | `trace-23d1db42-6884-4d25-96e2-be51ff832a74` | [概述](historical-uat-browser-2026-09-20/B-006-overview.png) / [详情](historical-uat-browser-2026-09-20/B-006-detail.png) |
| B-007 | 去年 x-ssl 且指定产品的项目，列出项目、客户和产品 | 通过（注明源粒度） | 无 | 无需修复；需要在业务解释中保留源数据粒度提示 | 返回 8 条源记录，筛选和字段正确；同一商机出现多条源记录，当前无证据表明是平台重复 | Wyn 执行源筛选和明细读取；按 Wyn 源端粒度展示；无 fallback | `trace-700836a0-4bf6-468a-ab05-32d0865730b2` | [概述](historical-uat-browser-2026-09-20/B-007-overview.png) / [详情](historical-uat-browser-2026-09-20/B-007-detail.png) |
| B-008 | 去年按产品统计商机金额和商机数量 | 通过 | 无 | 无需修复 | 返回 9 个产品，每个产品 1 个去重商机，金额合计约 `50,185,000` 元 | Wyn 执行分组、金额聚合和去重计数；无 fallback | `trace-1928ece5-651e-4092-964f-10b60c8f9ad7` | [概述](historical-uat-browser-2026-09-20/B-008-overview.png) / [详情](historical-uat-browser-2026-09-20/B-008-detail.png) |
| B-009 | x-ssl、MNC 且商机金额大于 20 万的商机 | 通过 | 无 | 无需修复 | 返回 2,043 条记录；金额阈值和两个源筛选均生效 | Wyn 执行源筛选和金额条件；无 fallback | `trace-9e9a2fc9-6c93-4e81-8dce-0b38e385273c` | [概述](historical-uat-browser-2026-09-20/B-009-overview.png) / [详情](historical-uat-browser-2026-09-20/B-009-detail.png) |
| B-010 | 去年指定产品中 POE 客户有哪些 | 通过（预期空结果） | 无 | 无需修复 | 返回 0 行，页面明确显示产品、POE、FY26 筛选条件和“未找到匹配数据” | Wyn 执行产品、POE、FY26 源筛选；无 fallback | `trace-d86afa38-eec2-45eb-8f6b-ba0ce8fbe835` | [概述](historical-uat-browser-2026-09-20/B-010-overview.png) / [详情](historical-uat-browser-2026-09-20/B-010-detail.png) |
| UAT-EXPLAIN-001 | recurring + 指定产品的商机明细 | 通过 | 无 | 无需修复 | 返回 12 条记录；筛选字段和明细字段与问题一致 | Wyn 执行源筛选和明细读取；无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-EXPLAIN-001-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-EXPLAIN-001-detail.png) |
| UAT-EXPLAIN-002 | 商机数量和金额的综合统计 | 通过（展示观察项） | 无查询错误；详情指标区主要突出数量，摘要同时给出数量和金额 | 暂不改代码；后续可优化多指标卡片的并列展示 | 返回 1,370 个商机，金额 `434,171,223.46` 元；摘要证据完整 | Wyn 执行统计；无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-EXPLAIN-002-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-EXPLAIN-002-detail.png) |
| UAT-EXPLAIN-003 | Risk Management + MNC/POE 的综合明细 | 通过 | 无 | 无需修复 | 返回 2,286 条记录，产品和客户类型条件均保留 | Wyn 执行产品和多值客户类型筛选；无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-EXPLAIN-003-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-EXPLAIN-003-detail.png) |
| UAT-EXPLAIN-004 | PSM 综合明细 | 通过 | 无 | 无需修复 | 返回 7,655 条记录，PSM 条件和明细字段完整 | Wyn 执行 `is_subcode = 1` 源筛选和明细读取；无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-EXPLAIN-004-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-EXPLAIN-004-detail.png) |
| UAT-SEM-002 | 组合条件并要求 6 个字段返回 | 通过 | 无 | 无需修复 | 返回 7 条记录，6 个用户要求字段完整 | Wyn 执行源筛选和明细读取；无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-SEM-002-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-SEM-002-detail.png) |
| UAT-SEM-003 | 多条件、多字段综合查询 | 通过 | 无 | 无需修复 | 返回 48 条记录，用户要求字段完整 | Wyn 执行组合源筛选和明细读取；无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/UAT-SEM-003-overview.png) / [详情](historical-uat-browser-2026-09-20/UAT-SEM-003-detail.png) |
| UAT-SEM-004 | 要求数据集不支持的字段/能力 | 通过（预期澄清） | 用户要求无法映射到当前数据集字段或派生能力 | 保留能力不可用/需要澄清机制，不生成 fallback 结果 | 页面进入需要确认状态，没有伪造结果或错误明细 | 未执行 Wyn 业务查询；无 fallback | 无执行 trace | [澄清页面](historical-uat-browser-2026-09-20/UAT-SEM-004-overview.png) |
| MV-002 | MNC 客户名单的多值字符串筛选 | 通过 | 无 | 无需修复 | 返回 7 个客户；使用字符串成员包含语义，不依赖 JSON 数组解析 | Wyn 执行多值字符串包含筛选和去重；无 fallback | 未在截图摘要中单独展示 | [概述](historical-uat-browser-2026-09-20/MV-002-overview.png) / [详情](historical-uat-browser-2026-09-20/MV-002-detail.png) |

## 5. 关键问题分析

### 5.1 AY-033 是本轮明确的不通过项

截图中的技术详情已经证明：

- 聚合维度为产品大类；
- 聚合后筛选 `revenue > 10000000` 已经存在；
- 但源筛选同时存在 `赢单财年 = 26`、`赢单日期 >= 2025-06-01`、`赢单日期 < 2026-06-01`；
- 最终结果为 0 行。

这不是“财年 26 没有数据”的证据，因为此前独立稳定验收已经在同一数据集和 Skill 下得到 2 个产品大类。当前错误是同一个用户时间约束被物化为两套相互叠加的口径，属于平台级时间语义/查询约束守恒回归，不是数据集或 Skill 单点问题。

正确执行计划应为：

1. LLM 识别“财年 26”为分类型财年筛选；
2. 平台校验财年字段类型，保留 `赢单财年 = 26`；
3. 不得凭空追加自然日期范围；
4. Wyn 按产品大类执行分组和金额求和；
5. 平台仅对完整聚合结果应用 `revenue > 10000000`；
6. 应返回 Digital Technology `1,897,687,040` 元和 Manufacturing `66,184,542.28` 元，共 2 行。

### 5.2 AY-034 与 AY-033 的区别

AY-034 的截图详情同时显示两个聚合后条件：`revenue > 10000000` 和 `opportunity_count > 3`，且只有 `赢单财年 = 26` 源筛选。该条件组合返回 0 行，因此当前可以判为合法空结果。

不能因为 AY-033 和 AY-034 都显示 0 行，就把两者归为同一类结果：AY-033 有错误的日期范围，AY-034 没有；前者是不通过，后者是通过。

### 5.3 B-001 是调用链稳定性风险

B-001 首次出现 `Failed to fetch`，没有形成有效查询 trace；独立重试后成功，返回字段和 Wyn 筛选均正确。它说明调用链仍存在瞬时失败，但没有证据表明 LLM 语义理解或 Wyn 查询计划错误。本轮将其记为“重试后通过、稳定性风险”，不能把一次成功重试等同于稳定性已解决。

### 5.4 综合问题总体表现

本轮综合问题覆盖了：

- 多值客户类型的 `containsAny`、`notContainsAny`；
- recurring 的模糊成员包含；
- PSM 到 `is_subcode = 1` 的 Skill 映射；
- x-ssl、财年、产品、客户类型、金额阈值的多条件组合；
- 产品层级分组、金额求和、商机去重计数；
- 聚合结果筛选；
- 多字段明细交付；
- 预期空结果和能力不可用/澄清态；
- Wyn 源数据多行粒度与平台展示边界。

综合问题大部分已恢复，当前主要剩余风险是时间口径物化的守恒仍不够稳定，以及偶发调用链失败。

## 6. 平台问题与场景问题边界

### 平台级问题

1. AY-033 的财年筛选与自然日期范围叠加，必须在通用时间语义、意图规范化和 Canonical 编译层修复。
2. B-001 的 `Failed to fetch` 属于 LLM/调用链稳定性，需要在平台重试、超时、错误分类和 trace 观测层处理。
3. 平台必须对同一时间意图的多个物化结果做守恒校验，阻止重复口径进入 Wyn。

### 数据集或 Skill 层问题

本轮没有发现需要针对当前数据集单点修复的问题。PSM、recurring、客户类型、Level0、财年等映射在大多数综合问题中均能正常工作。B-007 的同一商机多行现象应先视为 Wyn 源数据粒度，不应直接改 Skill 或平台去重。

## 7. 下一步建议

1. 先修复 AY-033 的时间口径守恒，增加“显式财年筛选不得再叠加隐式自然日期范围”的平台回归测试。
2. 使用真实浏览器在 8787 上连续复测 AY-033 至少 3 次，要求每次返回 2 行，且详情只显示 `赢单财年 = 26` 与 `revenue > 10000000`。
3. 同时复测 AY-034，确保仍为合法 0 行，两个聚合后条件都保留。
4. 对 B-001 做调用链稳定性回归，记录首次请求、重试次数、最终状态和 trace，不允许通过静默 fallback 掩盖失败。
5. 修复完成后再更新本报告的最终结论；在修复前不能宣称本轮 32 条全部通过。

## 8. 证据索引

- 当前轮截图：`UAT-AY/historical-uat-browser-2026-09-20/`
- 已有 AY-001～020 复测报告：`UAT-AY/P0_QUERY_EXECUTION_BOUNDARY_UAT_REPORT_2026-09-20.md`
- AY-023/032/033 历史修复验收记录：`UAT-AY/diagnostic-023-032-033-fixed/UAT-AY-023-032-033-查询边界修复验收报告.md`
