# WynAI AY/B/综合回归发布门禁 UAT 报告

## 1. 结论

- 验收入口：`http://127.0.0.1:8787/`
- 数据集：`01测试销售订单-09`（`18b86197-65e3-4682-8501-6e7125afad02`）
- Skill：`sales-opportunity-a53@1.3.0`
- 评测包：`sales-ay-release@1.0.0`
- 验收范围：AY 001–034、B-001–B-010、EXPLAIN-001–004、SEM-002–004、MV-002，共 52 条。
- API 门禁：52/52 通过，`releaseReady=true`。
- 真实浏览器截图门禁：52/52 通过，`releaseReady=true`。
- 浏览器控制台：error/warn 为 0。
- 业务 fallback：0；样本结果：0；截断结果：0；内部字段泄漏：0。

本报告以最终候选版本在同一 8787 进程上的结果为准。历史报告中 AY-033 的“不通过”记录属于修复前证据，不能覆盖本报告的最终验收结论；修复后 AY-033 已通过 API 和真实浏览器截图门禁。

2026-09-21 复验补充：API 门禁和 Codex 内置浏览器门禁均重新执行 52/52 通过。UAT-AY-003 的“截止目前”上界由评测包的动态表达式按 Asia/Shanghai 业务日期统一物化为 `赢单日期 < 2026-09-22`；该变化是跨日后的合法日期更新，不是业务查询回归。门禁运行器已记录本轮 `runtime.businessDate`，不再使用固定自然日断言。52 张截图均由本次稳定 8787 候选版本重新生成；控制台 error/warn、内部字段泄漏和业务 fallback 均为 0。

## 2. 本轮目标与边界

本轮目标是固化发布回归基线，不实施 `queryMode/NONE` 架构清理。验证重点为：

1. Wyn 先执行用户要求的源端筛选、分组、聚合、排序、排名和明细读取；
2. 平台只对完整、非样本、非截断且计数可验证的结果执行已登记二次操作；
3. 不从前 20,000 行明细本地重建业务结果，不使用业务 fallback；
4. 过滤条件、时间口径、字段角色和用户要求在 LLM 规范化后必须守恒；
5. 每条结果均通过真实用户页面完成概述/详情截图验收。

## 3. 结果汇总

| 门禁 | 总数 | 通过 | 不通过 | 结果 |
| --- | ---: | ---: | ---: | --- |
| API release gate | 52 | 52 | 0 | 通过 |
| 浏览器截图 release gate | 52 | 52 | 0 | 通过 |
| 浏览器控制台 error/warn | 0 | 0 | 0 | 通过 |

预期澄清用例 `UAT-AY-002` 与 `UAT-SEM-004` 没有业务查询详情和 Trace，这是正确行为：页面展示“需要确认”，不生成伪结果，也不把澄清态误判为错误。

## 4. 完整 UAT 表

截图目录：[browser-screenshots](release-gate-1.0.0-2026-09-20/browser-screenshots/)。每条截图包含真实页面的用户问题、概述或澄清状态；结果型问题同时展开“详情”，可核对源端筛选、返回字段、执行归属、结果范围、Skill 和 Trace。

| 编号 | 问题内容 | 测试结论 | 不通过原因分析 | 修复方案 | 修复验收情况 | 相关截图 |
| --- | --- | --- | --- | --- | --- | --- |
| UAT-AY-001 | 订单名称15247的商机金额是多少 | 通过 | — | — | API 与浏览器均通过；Wyn 金额聚合；1 行完整结果 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-001.png) |
| UAT-AY-002 | 某个客户的商机金额是多少 | 通过（预期澄清） | 客户值未指定，不能执行业务查询 | 保留 LLM 驱动的实体澄清 | 页面明确要求补充客户具体值，无伪结果、无 fallback | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-002.png) |
| UAT-AY-003 | 截止目前，Manufacturing product的占比是多少，具体金额是多少 | 通过 | — | — | Wyn 执行源筛选和聚合；平台仅执行白名单占比计算 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-003.png) |
| UAT-AY-004 | 我的客户中head_office_location是美国的名单 | 通过 | — | — | 源端筛选和名单结果完整 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-004.png) |
| UAT-AY-005 | 所有财年中，我的客户中head_office_location是美国和法国的名单 | 通过 | — | — | 全财年范围未被隐式收窄，Wyn 返回完整名单 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-005.png) |
| UAT-AY-006 | 所有财年中，我的客户中HQ是美国和法国的名单 | 通过 | — | — | 同义字段映射和双值条件通过 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-006.png) |
| UAT-AY-007 | 我的POE客户名单 | 通过 | — | — | 多值字符串成员筛选，返回客户名单 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-007.png) |
| UAT-AY-008 | 我的POE、MNC客户名单 | 通过 | — | — | `containsAny` 语义由 Wyn 执行，名单粒度正确 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-008.png) |
| UAT-AY-009 | 所有财年中，我的POE客户名单 | 通过 | — | — | 不追加未请求的时间条件 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-009.png) |
| UAT-AY-010 | 我最热卖的product是什么，是哪些客户 | 通过 | — | — | Wyn 完成聚合、排序、Top1 和客户下钻 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-010.png) |
| UAT-AY-011 | 请列举去年Digital Ecosystem Enterprise Alliances 产品的客户名单，及每个客户的订单金额 | 通过 | 修复前出现目标 FY26 与当前锚点 FY27 的说明冲突 | 时间账本允许相对目标与当前锚点同时回显，并拒绝第三个冲突财年 | API 与浏览器通过，FY26 源端条件正确 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-011.png) |
| UAT-AY-012 | x-ssl的项目有哪些 | 通过 | — | — | Wyn 执行 x-ssl 源端筛选 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-012.png) |
| UAT-AY-013 | 去年x-ssl的项目及项目名称、pursuit leader、oppo partner、product、client等信息 | 通过 | — | — | FY26 与用户字段均保留 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-013.png) |
| UAT-AY-014 | 有什么recurring的项目 | 通过 | — | — | recurring 模糊成员包含由 Wyn 执行 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-014.png) |
| UAT-AY-015 | 有哪些商机是PSM的，prime office是哪里 | 通过 | — | — | PSM 映射进入源端条件 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-015.png) |
| UAT-AY-016 | 去年 PSM 商机的 prime office、项目名称、client | 通过 | — | — | FY26、PSM 和字段交付通过 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-016.png) |
| UAT-AY-017 | PSM 商机的项目、client name、客户类型、product | 通过 | — | — | 组合字段完整返回 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-017.png) |
| UAT-AY-018 | MNC、POE客户的商机金额是多少 | 通过 | — | — | 多值筛选与金额聚合由 Wyn 执行 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-018.png) |
| UAT-AY-019 | MNC客户商机金额大于20万的商机有几个 | 通过 | — | — | Wyn 执行金额条件和去重计数 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-019.png) |
| UAT-AY-020 | MNC客户商机金额大于20万的商机分别是哪些客户、product | 通过 | — | — | 源端筛选、分组和结果字段守恒 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-AY-020.png) |
| UAT-AY-021～034 | AY 后续问题集（Food、Consumer Products、排除 MNC/POE、x-ssl、Risk Management、recurring、Level0、财年阈值组合） | 通过 | — | — | 14 条 API 和浏览器结果均通过；AY-033 的财年守恒修复已覆盖 | [截图目录](release-gate-1.0.0-2026-09-20/browser-screenshots/) |
| B-001～B-010 | 多条件 x-ssl、POE/MNC、recurring、PSM、产品、金额和字段组合 | 通过 | — | — | 10 条均通过；源端条件和结果契约通过 | [截图目录](release-gate-1.0.0-2026-09-20/browser-screenshots/) |
| UAT-EXPLAIN-001～004 | recurring、产品、客户类型、PSM 的综合解释型问题 | 通过 | — | — | 4 条均通过；详情中可核对执行归属与 Trace | [截图目录](release-gate-1.0.0-2026-09-20/browser-screenshots/) |
| UAT-SEM-002～003 | 组合条件、多字段明细问题 | 通过 | — | — | 2 条均通过；用户要求字段完整，内部辅助字段未泄漏 | [截图目录](release-gate-1.0.0-2026-09-20/browser-screenshots/) |
| UAT-SEM-004 | 按不存在的业务字段统计商机金额 | 通过（预期澄清） | 当前数据集无法确认该字段 | 返回能力澄清，不生成 fallback | 页面明确要求从可用字段中选择，无 Wyn 伪查询 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/UAT-SEM-004.png) |
| MV-002 | 我的 MNC 客户名单 | 通过 | — | — | 多值字符串成员筛选和客户去重通过 | [截图](release-gate-1.0.0-2026-09-20/browser-screenshots/MV-002.png) |

## 5. 本轮平台修复

### 时间账本边界修复

`lib/conversation/question-planner.mjs` 的财年一致性校验现在区分：

- 请求目标财年，例如“去年”在当前锚点 FY27 下物化为 FY26；
- 当前财年锚点，用于解释相对年份；
- 真正冲突的第三个财年。

因此模型可以合法回显“当前财年 FY27，去年为 FY26”，但出现 FY25 等第三个不一致期间仍会被拒绝并触发有限修复，不能静默执行错误查询。

新增回归测试覆盖该边界，并通过完整 API/浏览器门禁验证。

### 约束与执行边界

本轮没有引入场景特定分支。统一门禁仍要求：Wyn 负责数据范围和基础计算；平台只对完整聚合结果执行已登记操作；内部唯一键、诊断字段不进入用户可见结果；澄清态不伪造 Trace 或业务结果。

## 6. 证据索引

- [API 门禁 JSON](release-gate-1.0.0-2026-09-20/api-release-gate.json)
- [浏览器门禁 JSON](release-gate-1.0.0-2026-09-20/browser-release-gate.json)
- [52 条真实截图](release-gate-1.0.0-2026-09-20/browser-screenshots/)
- [评测包](../evaluation/packs/sales-ay-release.v1.json)
- [时间约束回归报告](TIME_AUTHORITY_REGRESSION_UAT_REPORT_2026-09-20.md)
