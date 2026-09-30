# UAT-AY B 组复杂组合查询专项验收报告

## 1. 验收目标与范围

- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- Skill：`sales-opportunity-a53@1.1.0`、`temporal-semantics@1.1.0`
- 服务：`http://127.0.0.1:8787/`
- 执行日期：2026-09-10（Asia/Shanghai）
- 验收方式：真实 Chromium 浏览器、1440 x 960 视口、每题独立新会话、真实页面截图、页面文本与操作日志复核
- 本轮结果可达性复测原则：先验证客户能否在真实浏览器中获得结果；本轮已包含平台级 LLM 调用链加固，后续仍将结果语义、字段完整性和时间口径单独验收

目标是验证时间、x-ssl、客户类型、recurring、PSM、产品、金额阈值、多字段输出和聚合等条件组合时，平台能否完整保留用户约束并正确交付结果。

## 2. 结论摘要

### 2.1 修复前基线与本轮复测口径

本报告保留修复前的正式 UAT 结论，作为问题发现基线；本轮增加“LLM 调用链加固后的结果可达性复测”。本轮只判断客户是否能在真实浏览器中得到业务结果，不以结果语义正确性替代可达性验收，也不把原有字段映射、财年口径等问题隐含判为通过。

修复前，B-003、B-004、B-006、B-007、B-010 曾出现无业务结果、查询约束校验失败或 LLM 服务不可用。修复后五条均在真实 Chromium 中完成查询并显示结果表格；调用审计均为 `query.executed / success`，未发现新的 provider 失败或熔断事件。

| 结论 | 数量 | 用例 |
| --- | ---: | --- |
| 通过 | 1 | B-009 |
| 不通过 | 9 | B-001、B-002、B-003、B-004、B-005、B-006、B-007、B-008、B-010 |

### 2.2 LLM 调用链加固后结果可达性

| 复测结论 | 数量 | 用例 |
| --- | ---: | --- |
| 结果可达性通过 | 5 | B-003、B-004、B-006、B-007、B-010 |
| 页面错误 | 0 | 五条复测均为 0 个 `pageerror` |
| LLM provider 失败/熔断 | 0 | 五条最终成功链路未产生 provider 失败或熔断事件 |

本轮代码修复覆盖：LLM 标量/数组输出归一化、语义校验失败后的有限修复轮次、纯名单查询的内部执行指标、输出字段引用校验、LLM/平台错误分类、trace ID 返回及每次 LLM 尝试的审计事件。没有加入固定业务规则查询降级。

主要结论：多值客户类型、x-ssl、金额阈值以及按产品聚合的底层查询能力可以工作，但复杂组合查询尚未达到稳定验收标准。最大风险不是“查询报错”，而是查询成功时静默遗漏用户字段或筛选条件，同时仍显示“精确结果”。

## 3. UAT 明细

| 编号 | 问题内容 | 测试结论 | 不通过原因分析 | 修复方案 | 修复验收情况 | 相关截图 |
| --- | --- | --- | --- | --- | --- | --- |
| B-001 | 今年 x-ssl 的项目，而且是 POE 类型的有哪些，返回项目名称、客户名称、销售总监、合作伙伴、创建日期、预计结束日期 | 不通过 | 更新后的问题已重新执行。查询返回 1,048 行；x-ssl、POE、销售总监和合作伙伴进入查询，但 `创建日期`、`预计结束日期` 均被静默遗漏，页面仍标为“精确结果”。另将“今年”落为赢单财年 25，需核对相对时间锚点。 | 将显式返回字段写入不可丢失的约束账本；Canonical 编译前后逐项比对；字段不明确时必须澄清，禁止删字段后成功。修正当前财年物化规则。 | 未修复；新问题已复现并生成新截图。 | [B-001](complex-browser-uat/screenshots/B-001.png) |
| B-002 | 今年 x-ssl 的 MNC 项目有哪些？请列出项目名称、客户名称、产品、销售总监和商机金额 | 不通过 | 查询成功返回 1,837 行，但“销售总监”被映射为 `Opportunity_partner`；B-001 中同一词却映射为 `Opportunity_manager`，跨用例语义不一致。另将“今年”落为赢单财年 25。 | 在字段语义或 Skill 中明确销售总监、合作伙伴与真实字段的绑定；覆盖校验按业务概念而非仅检查有同类字符串字段；修正当前财年物化。 | 未修复；截图已复现。 | [B-002](complex-browser-uat/screenshots/B-002.png) |
| B-003 | 去年 x-ssl 且 recurring 的项目有哪些？请返回项目名称、客户名称、recurring 类型和订单金额 | 修复后结果可达性通过 | 修复前曾因 recurring 语义校验失败而未生成结果。修复后 LLM 输出经过归一化和语义修复，成功编译 `recurring containsAny Yes`，执行返回 839 行。结果正确性、财年 FY25 是否符合最终业务口径另行复核。 | 保留 recurring 专项校验、最多三次意图处理尝试、具体错误分类和 trace 审计。 | 真实 Chromium 完成；trace `trace-16e6adba-24a0-4e14-b88a-212c60b974af`；页面错误 0。 | [B-003](complex-browser-uat/screenshots/B-003.png) |
| B-004 | 今年 POE 客户中 recurring 的项目有哪些？请列出项目名称、客户名称、产品和预计结束日期 | 修复后结果可达性通过 | 修复前曾返回 503，未进入查询执行。修复后 POE + recurring 查询成功返回 456 行。页面结果已交付；`预计结束日期` 是否进入返回字段、当前财年 FY25 是否正确仍属于语义验收项。 | 增加有限重试、错误分类和平台处理错误隔离；不采用固定规则降级。 | 真实 Chromium 完成；trace `trace-a1faec41-3677-4951-a0de-d9e317832b33`；页面错误 0。 | [B-004](complex-browser-uat/screenshots/B-004.png) |
| B-005 | x-ssl 项目中，哪些是 PSM？请列出项目名称、客户名称、客户类型、prime office 和产品 | 不通过 | 页面返回 13,807 行并标为“精确结果”，但筛选条件只有 `xssl = 1`，完全遗漏 PSM，结果实际是全部 x-ssl 项目。这是高风险的静默条件丢失。 | 在新数据集/Skill 中明确 PSM 对应字段和值；将用户实体 PSM 写入必需筛选约束；若无法绑定必须澄清，禁止无 PSM 条件执行并成功。 | 未修复；截图清楚显示仅有 xssl 条件。 | [B-005](complex-browser-uat/screenshots/B-005.png) |
| B-006 | 今年属于 PSM 的 x-ssl 项目有哪些？返回项目名称、客户名称、销售总监、合作伙伴和 prime office | 修复后结果可达性通过 | 修复前曾未通过查询约束校验并出现模型服务不可用。修复后成功返回 1,061 行，页面可见项目、客户、销售总监、合作伙伴和 prime office 结果；但页面摘要显示 FY26，而执行审计筛选为 `赢单财年 = 25`，时间口径存在展示与执行不一致。PSM 到 `is_subcode=1` 的业务正确性仍需单独确认。 | 语义修复与有限重试共用总尝试预算；纯名单自动补充隐藏执行指标，避免因缺少显式指标而阻断。后续统一时间物化与摘要生成，禁止摘要和 Canonical 使用不同财年。 | 结果可达性已通过；trace `trace-891c7287-ae1b-4ea4-95ca-a5afbee03f47`；页面错误 0；时间口径未通过，待修复后复测。 | [B-006](complex-browser-uat/screenshots/B-006.png) |
| B-007 | 今年 x-ssl 项目中，产品是 Safety Production and Risk Control in Manufacturing 的有哪些？请列出项目名称、客户名称、客户类型和商机金额 | 修复后结果可达性通过 | 修复前曾因模型服务不可用没有业务结果。修复后长产品名筛选成功执行，返回 36 行。财年口径和用户要求的完整字段是否全部保留，仍需单独做语义验收。 | 修复 LLM 失败分类与有限重试，并保留长值字段的语义映射校验。 | 真实 Chromium 完成；trace `trace-cdb9e1f5-1042-4324-9fe6-949de3620deb`；页面错误 0。 | [B-007](complex-browser-uat/screenshots/B-007.png) |
| B-008 | 今年 MNC 和 POE 客户的 x-ssl 项目，按产品统计商机金额和项目数量 | 不通过 | 多值客户类型、x-ssl、产品分组、金额求和和商机去重计数均正确，返回 89 个产品；但“今年”落为赢单财年 25。按执行日期 2026-09-10 和 Skill 的 6 月 1 日财年规则，若锚点为系统当前日期，当前财年应为 FY27。平台没有回显其他时间锚点。 | 明确并审计相对时间锚点；按 Skill 的财年开始日和“财年末两位”计算 FY，而不是直接复用模型年份；结果摘要显示锚点日期和最终时间范围。 | 查询组合部分通过，时间口径未通过；待修复后复测。 | [B-008](complex-browser-uat/screenshots/B-008.png) |
| B-009 | x-ssl 项目中，MNC 客户且商机金额大于 20 万的有哪些？请列出客户名称、项目名称、产品、商机金额 | 通过 | 无阻断问题。筛选正确包含 xssl、MNC 多值字符串成员和金额大于 200,000；返回字段完整，共 2,023 行并提供前端分页。摘要声称仅展示前 20 条，而分页实际约为每页 100 条，属于非阻断展示文案问题。 | 核心查询无需修复；后续让摘要从实际分页状态读取展示行数，避免固定“前 20 条”。 | 核心语义和结果验收通过；展示文案待优化。 | [B-009](complex-browser-uat/screenshots/B-009.png) |
| B-010 | 去年 Digital Ecosystem Enterprise Alliances 产品中，POE 客户有哪些？请列出客户名称、项目名称、订单金额和创建日期 | 修复后结果可达性通过 | 修复前在澄清后选择 `code_open_date` 时曾无法交付结果。修复后的真实 Chromium 复测完成查询，返回 29 行；最新成功审计链为 `query.planned → query.compiled → query.executed`。当前结果未带出创建日期，属于字段语义/完整字段交付问题，不影响本轮“是否能返回结果”的结论。 | 保留结构化澄清、有限重试和 trace 审计；后续补齐“创建日期”规范字段绑定并纳入约束守恒校验。 | 真实 Chromium 完成；trace `trace-8bf52178-c41c-425b-aca4-83da11aafd22`；页面错误 0。 | [B-010](complex-browser-uat/screenshots/B-010.png) |

## 4. 跨用例平台问题

### P0：显式约束可被静默遗漏

- B-001 丢失两个日期输出字段。
- B-002 将销售总监绑定到与 B-001 不同的字段。
- B-005 丢失 PSM 筛选，却仍显示“精确结果”。
- 当前结果校验主要验证已生成计划自身，没有完整验证“原问题 -> 意图 -> Canonical -> 结果展示”的约束守恒。

建议：建立 `UserConstraintLedger`，为每个显式筛选、时间、指标、返回字段、排序和数量要求分配稳定 ID；每个阶段只能标记 resolved / clarified / rejected，不能直接消失。存在 required unresolved 时禁止执行或禁止标为精确结果。

### P0：相对财年物化口径不可信

- B-001、B-002、B-008 均把 2026-09-10 的“今年”执行为赢单财年 25。
- Skill 声明财年为 6 月 1 日至次年 5 月 31 日，且字段值为财年末两位；若采用系统当前日期，2026-09-10 应属于 FY27。
- 如果平台实际采用数据集截至日期作为锚点，应在数据集/Skill 中结构化配置并在页面回显，不能隐式采用。

建议：新增结构化 `relativeTimeAnchor`（系统日期、数据集截至日期或用户覆盖）以及统一财政年度计算器，LLM 只识别相对词，不自行决定最终财年值。

### P1：LLM 与网关稳定性（修复前基线及后续监控）

- 修复前完整批次曾出现 502、503；独立重跑也曾出现 `Failed to fetch`。
- 修复前 B-004、B-006、B-007、B-010 因服务不可用无法完成；这属于本轮修复前基线，不代表修复后状态。
- 修复前 B-003 在模型有响应时仍连续两次未通过约束校验。

修复状态：本轮已完成有限重试、失败分类、trace ID 和操作事件审计；五条阻断用例已完成真实浏览器复测，最终成功链路均产生 `query.executed / success`。后续仍需监控真实 provider 传输失败、超时和熔断恢复情况。保持“LLM 负责理解”的原则，不回退为固定业务规则。

### P1：字段语义与简称映射不完整

- PSM 尚未稳定映射到实际筛选字段和值。
- “销售总监”在两个问题中映射不一致。
- “创建日期”“预计结束日期”没有形成稳定字段绑定。

建议：先核对旧描述、新数据集描述和 Skill，补齐字段业务概念、同义词、实际字段、值字典和歧义策略；平台校验器读取这些结构化语义，而不是硬编码某个数据集的字段名。

### P2：摘要与实际分页不一致

- 多条结果摘要写“仅展示前 20 条”，实际分页为约 100 行/页。
- 应由结果契约提供 `returnedRows`、`pageSize`、`totalRows`、`truncated`，摘要直接引用，不让 LLM猜测。

## 5. 建议修复顺序

1. P0 约束守恒：阻止字段/筛选静默遗漏，优先覆盖 B-001、B-002、B-005。
2. P0 时间物化：确认相对时间锚点并修复财年计算，复测所有“今年/去年”。
3. P1 语义补全：补齐 PSM、销售总监、合作伙伴、创建日期、预计结束日期绑定。
4. P1 稳定性：已完成有限重试、错误分类和 trace 可观测性；保留 B-003、B-004、B-006、B-007、B-010 作为回归监控用例。
5. P2 展示契约：摘要展示行数、分页和完整性提示从真实结果契约生成。

## 6. 修复后证据索引

- 修复后浏览器结果汇总：[results.json](complex-browser-uat/results.json)
- 修复后浏览器控制台：[console.json](complex-browser-uat/console.json)
- 修复后页面错误：[page-errors.json](complex-browser-uat/page-errors.json)
- B-003 成功审计：[operation-event-bb91c04b-a8f7-404a-868a-ad4842eebc20.json](../data/operation-events/operation-event-bb91c04b-a8f7-404a-868a-ad4842eebc20.json)
- B-004 成功审计：[operation-event-49921590-c9bb-413a-8ed4-bd9f0debe798.json](../data/operation-events/operation-event-49921590-c9bb-413a-8ed4-bd9f0debe798.json)
- B-006 成功审计：[operation-event-07c4d1b4-19cc-45bd-8d8d-e0b69497ccd7.json](../data/operation-events/operation-event-07c4d1b4-19cc-45bd-8d8d-e0b69497ccd7.json)
- B-007 成功审计：[operation-event-e91f0bd7-b9f0-4cc8-8cd3-2402fe1fd50a.json](../data/operation-events/operation-event-e91f0bd7-b9f0-4cc8-8cd3-2402fe1fd50a.json)
- B-010 成功审计：[operation-event-c4bb789d-1944-4faa-8df0-389f352dc4f1.json](../data/operation-events/operation-event-c4bb789d-1944-4faa-8df0-389f352dc4f1.json)

## 7. 原始证据索引

- 原始结果：[results.json](complex-browser-uat/results.json)
- 完整批次控制台摘要：[full-run-console-observations.json](complex-browser-uat/full-run-console-observations.json)
- 当前浏览器控制台：[console.json](complex-browser-uat/console.json)
- 页面错误：[page-errors.json](complex-browser-uat/page-errors.json)
- 浏览器脚本：[run-complex-browser-uat.mjs](run-complex-browser-uat.mjs)
- 截图目录：[screenshots](complex-browser-uat/screenshots)

说明：脚本中的初步 `status` 仅表示页面是否结束以及问题关键词是否出现在页面全文。正式结论以本报告对 Canonical 筛选、返回字段、时间口径和页面结果的人工复核为准，避免把用户问题本身包含的关键词误认为结果已满足要求。
