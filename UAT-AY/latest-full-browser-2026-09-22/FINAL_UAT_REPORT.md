# AY/B 全量真实浏览器 UAT 验收报告（2026-09-22）

## 1. 验收结论

本轮基于最新工作区代码完成 `sales-ay-release@1.0.0` 全量 52 条 API 与 Codex 内置浏览器验收。API 门禁 `52/52` 通过，真实浏览器 `52/52` 通过，52 张截图齐全，浏览器控制台 warning/error 均为 0。

本结论覆盖数据集 `01测试销售订单-09`（`18b86197-65e3-4682-8501-6e7125afad02`）和 Skill `sales-opportunity-a53@1.3.0`。Smart Query 结果均由 Wyn/WAX 执行，没有样本结果、业务替代结果、平台 `queryMode`、平台 NONE 或 fallback 泄漏。

## 2. 环境与证据

| 项目 | 结果 |
|---|---|
| 最新代码实例 | `http://127.0.0.1:8791/`；与 8787 使用同一最新工作区源码和 `.env.local`，运行数据目录隔离 |
| API 门禁 | `api-isolated-final/api-release-gate.json`：52/52，`releaseReady=true` |
| 浏览器门禁 | `browser-release-gate.json`：52/52，`releaseReady=true` |
| 截图 | `screenshots/`：52 张，缺失 0，异常小文件 0 |
| 控制台 | warning 0，error 0 |
| 数据契约 | Wyn 执行；样本：否；替代结果：未使用；完整结果行数与 API 门禁一致 |

说明：原 8787 进程在长批量 API 验证中发生过进程退出，失败证据保留在本目录的 `api-release-gate.json` 和 `api-final/api-release-gate.json`。本轮为避免历史运行数据量影响语义结论，使用隔离运行目录完成 8791 的 API 和浏览器验收。该现象单独归类为 8787 长批次运行稳定性问题，不改变本轮 52 条语义与 UI 验收结论，也不能据此宣称 8787 已通过长时间稳定性门禁。

## 3. 验收规则

每个非澄清用例均从新会话提交，并核对：问题显示正确、页面进入完成状态、详情可展开、执行归属包含 Wyn、样本为否、替代结果未使用、数据集 ID 和 Skill 正确、Trace 存在、页面结果行数与同轮 API 证据一致，且不显示 `queryMode`、平台 NONE 或 fallback。澄清用例核对“需要确认/等待补充”状态和可选项，不要求生成业务结果。

## 4. 逐条结果

| ID | 问题 | 预期/实际 | 行数 | 结论 | 截图 |
|---|---|---|---:|---|---|
| UAT-AY-001 | 订单名称15247的商机金额是多少 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-001.png) |
| UAT-AY-002 | 某个客户的商机金额是多少 | 需要澄清 / 需要澄清 | - | 通过 | [截图](screenshots/UAT-AY-002.png) |
| UAT-AY-003 | 截止目前，Manufacturing product的占比是多少，具体金额是多少 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-003.png) |
| UAT-AY-004 | 我的客户中head_office_location是美国的名单 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-AY-004.png) |
| UAT-AY-005 | 所有财年中，我的客户中head_office_location是美国和法国的名单 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-AY-005.png) |
| UAT-AY-006 | 所有财年中，我的客户中HQ是美国和法国的名单 | 完成 / 完成 | 7 | 通过；首次全页截图瞬时失败，重试成功 | [截图](screenshots/UAT-AY-006.png) |
| UAT-AY-007 | 我的POE客户名单 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-AY-007.png) |
| UAT-AY-008 | 我的POE、MNC客户名单 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-AY-008.png) |
| UAT-AY-009 | 所有财年中，我的POE客户名单 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-AY-009.png) |
| UAT-AY-010 | 我最热卖的product是什么，是哪些客户 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-AY-010.png) |
| UAT-AY-011 | 请列举去年Digital Ecosystem Enterprise Alliances 产品的客户名单，及每个客户的订单金额 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-011.png) |
| UAT-AY-012 | x-ssl的项目有哪些 | 完成 / 完成 | 13802 | 通过 | [截图](screenshots/UAT-AY-012.png) |
| UAT-AY-013 | 去年x-ssl的项目有哪些，请列出项目的名称，pursuit leader、oppo partner、product、client等信息 | 完成 / 完成 | 48 | 通过 | [截图](screenshots/UAT-AY-013.png) |
| UAT-AY-014 | 有什么recurring的项目 | 完成 / 完成 | 11830 | 通过 | [截图](screenshots/UAT-AY-014.png) |
| UAT-AY-015 | 有哪些商机是 PSM的，prime office 是哪里 | 完成 / 完成 | 7659 | 通过 | [截图](screenshots/UAT-AY-015.png) |
| UAT-AY-016 | 去年，有哪些商机是 PSM的，prime office 是哪里，请列出项目名称、client等信息 | 完成 / 完成 | 6 | 通过 | [截图](screenshots/UAT-AY-016.png) |
| UAT-AY-017 | 有哪些商机是 PSM的，prime office 是哪里，请列出项目名称、client name、客户类型、product等信息 | 完成 / 完成 | 7655 | 通过 | [截图](screenshots/UAT-AY-017.png) |
| UAT-AY-018 | MNC、POE客户的商机金额是多少 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-018.png) |
| UAT-AY-019 | MNC 客户的商机金额 大于20万的商机有几个 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-019.png) |
| UAT-AY-020 | MNC 客户的商机金额 大于20万的商机，分别是哪些客户、product | 完成 / 完成 | 516 | 通过 | [截图](screenshots/UAT-AY-020.png) |
| UAT-AY-021 | MNC 客户 且 subsector是Food 的商机有多少个 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-021.png) |
| UAT-AY-022 | MNC 客户 是Consumer Products 行业 的商机有多少个 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-022.png) |
| UAT-AY-023 | 不是 MNC 和 POE 客户的商机金额是多少 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-023.png) |
| UAT-AY-024 | x-ssl的项目有哪些 | 完成 / 完成 | 13802 | 通过 | [截图](screenshots/UAT-AY-024.png) |
| UAT-AY-025 | x-ssl的项目有哪些 | 完成 / 完成 | 13802 | 通过 | [截图](screenshots/UAT-AY-025.png) |
| UAT-AY-026 | 去年x-ssl的项目有哪些 | 完成 / 完成 | 9 | 通过 | [截图](screenshots/UAT-AY-026.png) |
| UAT-AY-027 | Risk Management product的占比是多少，具体金额是多少 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-027.png) |
| UAT-AY-028 | 我的POE客户名单 | 完成 / 完成 | 7 | 通过；截图第 3 次重试成功 | [截图](screenshots/UAT-AY-028.png) |
| UAT-AY-029 | 我最热卖的product是什么，是哪些客户 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-AY-029.png) |
| UAT-AY-030 | 请列举去年Risk Management 产品的客户名单，及每个客户的订单金额 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-AY-030.png) |
| UAT-AY-031 | recurring的商机，产品是 Safety Production and Risk Control in Manufacturing 的有哪些 | 完成 / 完成 | 137 | 通过 | [截图](screenshots/UAT-AY-031.png) |
| UAT-AY-032 | 按产品level0 统计去年的总商机金额和商机数量 | 完成 / 完成 | 5 | 通过 | [截图](screenshots/UAT-AY-032.png) |
| UAT-AY-033 | 按产品大类统计财年26的总商机金额，并筛选总金额大于1000万 | 完成 / 完成 | 2 | 通过 | [截图](screenshots/UAT-AY-033.png) |
| UAT-AY-034 | 按产品大类统计财年26的总商机金额和商机数量，并筛选总金额大于1000万且商机数量大于3 | 完成 / 完成 | 0 | 通过 | [截图](screenshots/UAT-AY-034.png) |
| B-001 | 去年 x-ssl 的项目，而且是 POE 类型的有哪些，返回项目名称、客户名称、销售总监、合作伙伴、创建日期、预计结束日期 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/B-001.png) |
| B-002 | 去年 x-ssl 的 MNC 项目有哪些，列出项目、客户、产品、销售总监和商机金额 | 完成 / 完成 | 36 | 通过 | [截图](screenshots/B-002.png) |
| B-003 | 去年 x-ssl 且 recurring 的项目，返回项目、客户、recurring 类型和订单金额 | 完成 / 完成 | 6 | 通过 | [截图](screenshots/B-003.png) |
| B-004 | 去年 POE 客户中 recurring 的项目，列出项目、客户、产品和预计结束日期 | 完成 / 完成 | 18 | 通过 | [截图](screenshots/B-004.png) |
| B-005 | x-ssl 项目中哪些是 PSM，列出项目、客户、客户类型、prime office 和产品 | 完成 / 完成 | 3744 | 通过 | [截图](screenshots/B-005.png) |
| B-006 | 去年 PSM 且 x-ssl 的项目，列出项目名称和客户等信息 | 完成 / 完成 | 5 | 通过 | [截图](screenshots/B-006.png) |
| B-007 | 去年 x-ssl 且产品是 Safety Production and Risk Control in Manufacturing 的项目，列出项目、客户和产品 | 完成 / 完成 | 1 | 通过 | [截图](screenshots/B-007.png) |
| B-008 | 去年 MNC 和 POE 客户的 x-ssl 项目，按产品统计商机金额和项目数量 | 完成 / 完成 | 9 | 通过 | [截图](screenshots/B-008.png) |
| B-009 | x-ssl 项目中 MNC 且商机金额大于 20 万的商机，列出客户、项目、产品和金额 | 完成 / 完成 | 2043 | 通过 | [截图](screenshots/B-009.png) |
| B-010 | 去年 Digital Ecosystem Enterprise Alliances 产品中 POE 客户有哪些，列出客户、项目、订单金额和创建日期 | 完成 / 完成 | 0 | 通过 | [截图](screenshots/B-010.png) |
| UAT-EXPLAIN-001 | 去年 recurring 的商机中，产品是 Safety Production and Risk Control in Manufacturing 的有哪些，返回项目名称、客户名称、商机金额、recurring 类型 | 完成 / 完成 | 12 | 通过 | [截图](screenshots/UAT-EXPLAIN-001.png) |
| UAT-EXPLAIN-002 | MNC 或 POE 客户中，Consumer Products 行业的商机数量和商机金额是多少？ | 完成 / 完成 | 1 | 通过 | [截图](screenshots/UAT-EXPLAIN-002.png) |
| UAT-EXPLAIN-003 | Risk Management 产品中，MNC 或 POE 客户的商机有哪些？返回客户名称、商机金额和项目名称。 | 完成 / 完成 | 2286 | 通过 | [截图](screenshots/UAT-EXPLAIN-003.png) |
| UAT-EXPLAIN-004 | 有哪些商机是 PSM 的？请返回项目名称、客户名称、客户类型、产品和主要办公室。 | 完成 / 完成 | 7655 | 通过 | [截图](screenshots/UAT-EXPLAIN-004.png) |
| UAT-SEM-002 | 去年 x-ssl 的项目，而且是 POE 类型的有哪些，返回项目名称、客户名称、销售总监、合作伙伴、创建日期、预计结束日期 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/UAT-SEM-002.png) |
| UAT-SEM-003 | 去年 x-ssl 的项目有哪些，返回项目名称、客户名称、销售总监、合作伙伴、创建日期、预计结束日期 | 完成 / 完成 | 48 | 通过 | [截图](screenshots/UAT-SEM-003.png) |
| UAT-SEM-004 | 按不存在的业务字段统计商机金额 | 需要澄清 / 需要澄清 | - | 通过；浏览器轮次澄清措辞与 API 轮次不逐字相同；按澄清状态和可选项契约验收 | [截图](screenshots/UAT-SEM-004.png) |
| MV-002 | 我的 MNC 客户名单 | 完成 / 完成 | 7 | 通过 | [截图](screenshots/MV-002.png) |

## 5. 关键回归点

- `UAT-AY-032`：去年、产品 level0、总商机金额与去重商机数量返回 5 行，执行归属为 Wyn。
- `UAT-AY-033`：FY26 按产品大类聚合并进行聚合后金额筛选，返回 2 行；未出现平台先截取 20,000 行再过滤。
- `UAT-AY-034`：双聚合后条件返回合法完整 0 行，未误报为错误。
- `B-001`：去年 + x-ssl + POE + 六个明确返回字段，返回 7 行且字段完整。
- `B-010`：无匹配数据时返回合法完整 0 行，空结果页面正常。
- `UAT-SEM-004`：不存在字段正确进入澄清。浏览器轮次的自然语言措辞与 API 轮次略有变化，按“澄清状态 + 选项”契约通过。

## 6. 问题与后续

本轮没有发现 52 条业务语义、结果行数或页面交付回归。唯一新增观察是 8787 在连续长批 API 调用下发生进程退出；这属于运行稳定性问题，建议单独建立压力/内存治理任务，调查诊断日志增长、会话数据增长与进程峰值内存，不能用隔离实例通过来掩盖。

## 7. 最终判定

- AY/B/解释型/语义边界发布门禁：通过。
- 最新代码真实浏览器截图门禁：通过。
- 8787 长批次稳定性门禁：未验收通过，作为独立问题保留。
