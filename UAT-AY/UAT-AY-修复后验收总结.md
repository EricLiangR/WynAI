# UAT-AY 修复后验收总结

## 验收范围

- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- 服务地址：[http://127.0.0.1:8787/](http://127.0.0.1:8787/)
- Skill：`sales-opportunity-a53@1.1.0`
- 浏览器视口：1440 x 960；每条问题使用独立会话。

## 修复后专项结果

| 用例 | 问题 | 结论 | 关键验收证据 |
| --- | --- | --- | --- |
| PF-001 | head_office_location 是美国的客户名单 | 通过 | 7 个客户；截图 `screenshots/PF-001-postfix.png` |
| PF-002 | POE 客户名单 | 通过 | Markdown 客户类型字典生效；截图 `screenshots/PF-002-postfix.png` |
| PF-003 | MNC 客户商机金额 | 通过 | null 按 `—` 展示；截图 `screenshots/PF-003-postfix.png` |
| PF-004 | GPS 行业客户名单 | 通过 | 行业简称映射到 Government & Public Sector；截图 `screenshots/PF-004-postfix.png` |
| PF-005 | 有什么 recurring 项目 | 通过 | `recurring in (Yes - Continuous, Yes - New Win)`；11,830 行，119 页；截图 `screenshots/PF-005-postfix.png` |
| PF-006 | 列出所有 recurring 项目名称 | 通过 | 使用 `pipelineName`；11,830 行；截图 `screenshots/PF-006-postfix.png` |
| PF-007 | 商机来源为 Recurring 的项目 | 通过 | 用户明确指定商机来源时保留来源字段；3,042 行，31 页；截图 `screenshots/PF-007-postfix.png` |
| PF-008 | 今年 x-ssl 项目 | 通过 | 默认按赢单财年，不重复澄清；截图 `screenshots/PF-008-postfix.png` |
| PF-009 | 2025 自然年销售额 | 通过 | 用户覆盖为赢单日期 2025-01-01 至 2026-01-01；截图 `screenshots/PF-009-postfix.png` |
| PF-010 | 今年销售额 | 通过 | 默认按赢单财年 FY25；截图 `screenshots/PF-010-postfix.png` |
| PF-011 | recurring 且产品为 Safety Production... | 通过 | 136 行完整交付，2 页；意图层与请求层均为 20,000；截图 `screenshots/PF-011-postfix.png` |

## 已完成修复

1. 将旧描述中的 recurring 字典和规则迁移到 Markdown Skill，并加入字段优先、模糊/精确映射、项目名单维度和非法映射校验。
2. Skill 运行时保留 `defaultCalendar=fiscal` 与自然年覆盖策略，并将策略注入语义目录和 LLM 上下文。
3. 默认查询统一使用 20,000 行上限；只有用户明确 TopN/limit 时保留较小范围。
4. 修复意图层 `expectedResult.maximumRows` 与 Canonical request 脱节导致的 `isPartial=true` 误判。

## 待继续讨论的增强

- 财年值、FY 显示标签和数据集财年边界应由一个共享解析器维护，避免筛选值与回答文案出现标签不一致。
- 超过 20,000 行的真实边界测试、导出能力和超限提示仍需专项验证。
- 平台公共字典、数据集绑定、版本审计和管理员确认流程属于后续治理能力，不在本轮直接扩展。
- 当前运行目录因工作区权限回退到系统 Temp；生产环境应配置可持久化、可审计的运行目录。

## 证据位置

- 详细 UAT 表格：[outputs/01a076f3-14b4-7f02-9ef6-c4dec148ce59/uat-ay/UAT-AY-销售订单智能问数-UAT报告.xlsx](../outputs/01a076f3-14b4-7f02-9ef6-c4dec148ce59/uat-ay/UAT-AY-销售订单智能问数-UAT报告.xlsx)
- 浏览器结果：[postfix-browser-uat/results.json](postfix-browser-uat/results.json)
- 浏览器控制台日志：[postfix-browser-uat/console.json](postfix-browser-uat/console.json)
- 页面错误：[postfix-browser-uat/page-errors.json](postfix-browser-uat/page-errors.json)
- 运行时审计快照：[runtime-data-8787](runtime-data-8787)
