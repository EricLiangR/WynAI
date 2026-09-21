# UAT-AY 时间约束权威与 AY-033 防回归验收报告

## 1. 验收范围

- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- Skill：`sales-opportunity-a53@1.3.0`、`temporal-semantics@1.1.0`
- 服务：`http://127.0.0.1:8787/`
- 日期：2026-09-20（Asia/Shanghai）
- 验收方式：Codex 内置浏览器真实页面输入、每轮独立新会话、概述与详情截图、页面条件和 trace 交叉核对
- 固定边界：无数据集 ID/销售字段硬编码；无业务 fallback；筛选、分组、基础聚合和排序由 Wyn 执行

## 2. 结论

本轮通过。AY-033 原回归已在当前版本关闭：连续 5 次均稳定返回相同 2 行，源端条件只包含 `赢单财年 = 26`，聚合后条件为 `revenue > 10000000`，不再叠加 `赢单日期` 范围。

AY-034 连续 3 次稳定返回合法 0 行，源端同样只包含 `赢单财年 = 26`，两个聚合后条件均存在。页面明确显示“未找到匹配数据”，没有把空结果包装为查询失败或替代答案。

邻近时间场景 AY-032、AY-003、明确自然年和 B-008 均通过，证明修复没有把合法自然日期范围、相对财年或复杂组合筛选误删。最后边界补丁完成后再次复测 AY-003、明确自然年和 AY-033，三项均通过，8787 服务进程在复测期间未发生重启。

## 3. 自动化门禁

| 门禁 | 结果 |
|---|---|
| 时间权威与语义约束专项 | 24/24 通过 |
| 规划器、财年一致性、BusinessQueryIntent、平台治理、服务端完整性 | 全部通过 |
| 全量 `npm test` | 487/487 通过 |
| `npm run check` | 通过 |
| 浏览器控制台 error/warn | 0 |

## 4. UAT 明细

| 用例 | 问题内容 | 结论 | 关键验收结果 | Trace | 截图 |
|---|---|---|---|---|---|
| AY-033 第 1 次 | 按产品大类统计财年26的总商机金额，并筛选总金额大于1000万 | 通过 | 2 行完整结果；Digital Technology `1,897,687,040`；Manufacturing `66,184,542.28`；源端仅 `赢单财年 = 26`；聚合后 `revenue > 10000000` | `trace-c70f4419-7ec1-40cb-8a13-888ea368a13d` | [概述](time-authority-2026-09-20/AY-033-run1-overview.png) / [详情](time-authority-2026-09-20/AY-033-run1-detail.png) |
| AY-033 第 2 次 | 同上 | 通过 | 与第 1 次结果和条件一致 | `trace-50bdfda6-26ac-4303-a6c1-0a8acdfa84d4` | [概述](time-authority-2026-09-20/AY-033-run2-overview.png) / [详情](time-authority-2026-09-20/AY-033-run2-detail.png) |
| AY-033 第 3 次 | 同上 | 通过 | 与第 1 次结果和条件一致 | `trace-b29a89e1-26e1-4cf9-ade2-be86efbc12fe` | [概述](time-authority-2026-09-20/AY-033-run3-overview.png) / [详情](time-authority-2026-09-20/AY-033-run3-detail.png) |
| AY-033 第 4 次 | 同上 | 通过 | 与第 1 次结果和条件一致 | `trace-25d56cc3-c633-4b88-adf4-01632ae96ba6` | [概述](time-authority-2026-09-20/AY-033-run4-overview.png) / [详情](time-authority-2026-09-20/AY-033-run4-detail.png) |
| AY-033 第 5 次 | 同上 | 通过 | 与第 1 次结果和条件一致 | `trace-f0e8ade8-29aa-45e0-8c15-0d2df761e3b8` | [概述](time-authority-2026-09-20/AY-033-run5-overview.png) / [详情](time-authority-2026-09-20/AY-033-run5-detail.png) |
| AY-033 最终边界复测 | 同上 | 通过 | 2 行完整结果；源端仅 `赢单财年 = 26`；聚合后 `revenue > 10000000`；最后边界补丁后结果未回归 | `trace-578eb28d-0e3e-495f-b7cd-aae4f4fe3a0a` | [详情与结果](time-authority-2026-09-20/AY-033-final-fiscal-authority.png) |
| AY-034 第 1 次 | 按产品大类统计财年26的总商机金额和商机数量，并筛选总金额大于1000万且商机数量大于3 | 通过 | 0 行完整结果；源端仅 `赢单财年 = 26`；金额和数量两个聚合后条件均存在；空结果提示正确 | `trace-df46f0b7-16dd-4132-a05e-b2370c35d698` | [概述](time-authority-2026-09-20/AY-034-run1-overview.png) / [详情](time-authority-2026-09-20/AY-034-run1-detail.png) |
| AY-034 第 2 次 | 同上 | 通过 | 与第 1 次条件和空结果一致 | `trace-5f6a8136-1f02-4609-859d-953766e3e105` | [概述](time-authority-2026-09-20/AY-034-run2-overview.png) / [详情](time-authority-2026-09-20/AY-034-run2-detail.png) |
| AY-034 第 3 次 | 同上 | 通过 | 与第 1 次条件和空结果一致 | `trace-5b78e3ee-2fdd-4cbc-9e62-b83ef1a28f21` | [概述](time-authority-2026-09-20/AY-034-run3-overview.png) / [详情](time-authority-2026-09-20/AY-034-run3-detail.png) |
| AY-032 | 按产品level0统计去年的总商机金额和商机数量 | 通过 | `去年`物化为 FY26；源端仅 `赢单财年 = 26`；5 行完整结果 | `trace-e07a07c6-ab68-4437-b8ab-30e67bb12f8d` | [概述](time-authority-2026-09-20/AY-032-last-year-overview.png) / [详情](time-authority-2026-09-20/AY-032-last-year-detail.png) |
| AY-003 最终边界复测 | 截止目前，Manufacturing product的占比是多少，具体金额是多少 | 通过 | 只保留开放日期上界：`赢单日期 < 2026-09-21`；没有财年条件；1 行完整结果；占比和金额均返回 | `trace-7494115f-9b80-4ba1-b244-a98275e36201` | [详情与结果](time-authority-2026-09-20/AY-003-final-cutoff-current.png) |
| 明确自然年边界复测 | 按产品大类统计自然年2025年的总商机金额 | 通过 | 只保留 `赢单日期 >= 2025-01-01` 和 `< 2026-01-01`；没有财年条件；5 行完整结果 | `trace-7dc32547-ab8c-49f8-ae93-c7f6ab5b3cab` | [详情与结果](time-authority-2026-09-20/natural-year-2025-final.png) |
| B-008 去年版 | 去年 MNC 和 POE 客户的 x-ssl 项目，按产品统计商机金额和项目数量 | 通过 | 同时保留客户类型包含任一 MNC/POE、`xssl = 1`、`赢单财年 = 26`；9 行完整结果 | `trace-7215d717-1af9-4c38-8afc-4c747c03c8d2` | [概述](time-authority-2026-09-20/B-008-last-year-composite-overview.png) / [详情](time-authority-2026-09-20/B-008-last-year-composite-detail.png) |

## 5. 平台修复说明

根因不是旧修复被删除，而是旧规则只覆盖“财年字段自身携带日期范围”，没有覆盖“财年字段筛选 + 另一个合法日期字段范围”。当前修复依据 approved Skill 的 `calendarPolicy`、用户显式时间表达和元数据字段类型建立时间权威：

1. 用户未明确日期范围时，Skill 声明的财年 `eq/in` 是唯一范围权威，删除 LLM 推断的重复日期范围。
2. 用户明确自然年、日期区间或截止日期时保留日期范围。
3. 用户明确财年和日期范围同时生效时，标记 `user-explicit-composite` 并保留两个条件。
4. 财年内按月等时间分组时，财年字段负责范围，日期字段负责分组，不重复限定范围。
5. 覆盖校验把权威财年 `eq/in` 视为已物化时间范围，不再机械要求同一 `time.field` 上必须另有日期过滤。

## 6. 运行环境说明

初次邻近回归时，PowerShell 中的 `npm run dev` 使用 Node `--watch` 子进程；AY-032 在服务端完成规划、Wyn 查询和结果校验后，watch 子进程重启，浏览器显示 `Failed to fetch`。同一代码在非 watch 诊断实例完整成功。为避免把开发热重启误判为产品失败，最终指定端口 8787 使用 `node server.mjs` 非 watch 模式完成全部截图验收，当前 8787 也保持该稳定实例。

该环境事件不改变本轮语义修复结论，但后续批量 UAT 应继续使用稳定非 watch 启动方式，或单独调查 Node watch 在 Windows 工作区中的重启触发源。
