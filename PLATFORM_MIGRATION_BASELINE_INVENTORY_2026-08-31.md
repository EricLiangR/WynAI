# 平台能力抽取阶段 0：基线与影响评估记录

> 版本：1.0
> 日期：2026-08-31（Asia/Shanghai）
> 状态：阶段 0 自动化基线完成，真实双跑待阶段 4
> 关联计划：[PLATFORM_CAPABILITY_EXTRACTION_COMPATIBILITY_GOALS_PLAN_2026-08-30.md](PLATFORM_CAPABILITY_EXTRACTION_COMPATIBILITY_GOALS_PLAN_2026-08-30.md)

## 1. 本阶段结论

已完成当前代码、测试和历史 UAT 产物的基线盘点。`npm run check` 通过，`npm test` 通过 `293/293`。当前基线可以作为平台公共能力抽取前的自动化保护门禁。

本阶段不宣称新旧平台链路已经完成双跑，也不宣称当前运行环境的真实 LLM 出站门禁已经关闭。真实 LLM、浏览器截图和新旧结果差异验证安排在阶段 4/6。

## 2. 已确认的模块边界

| 边界 | 当前约束 | 迁移要求 |
|---|---|---|
| 数据洞察输入 | `InsightInput v1` | 保留字段语义、来源、权限和幂等 |
| 数据洞察编排 | Planner/Critic/Narrator | 通过适配器接入，不与智能问数流程强行合并 |
| LLM 调用 | `llm-gateway.mjs`，exploration/intent 操作策略不同 | 平台统一治理机制，保留操作级预算和失败语义 |
| Evidence | 聚合结果优先、原始明细不外发 | 平台化后禁止静默采样，分块必须可追溯 |
| Skill | 版本化、审批和作用域 | Registry 平台化，模块保留业务口径和编排依赖 |
| 生命周期 | queued/planning/running/completed/failed 及部分完成 | 状态枚举兼容，失败不得伪装成功 |
| UAT | 平台 P1/P2/P3 与模块 M2/M3/M4 | 公共能力变更执行组合验收和新旧对比 |

## 3. 黄金基线

机器可读清单：`PLATFORM_MIGRATION_GOLDEN_BASELINE_V1.json`。阶段 1 契约声明：`PLATFORM_DATA_INSIGHT_COMPATIBILITY_CONTRACT_V1.json`、`PLATFORM_SMART_QUERY_COMPATIBILITY_CONTRACT_V1.json`。

首批 10 个保护性用例覆盖：普通洞察、高基数、稀疏数据、部分完成、LLM 异常、Evidence 超预算、Skill 口径、权限、PC/移动端和重启恢复。

每个用例的不可变断言包括：核心数值、过滤和权限范围、Evidence 关系、终态、用户可见答案以及失败真实性。模型措辞、Prompt 排版和 trace ID 不作为数值基线。

## 4. 影响分级

| 变更对象 | 平台级 | 数据洞察级 | 说明 |
|---|---|---|---|
| Gateway/错误码/超时/重试 | P1/P2，异常 P3 | M2/M3 | 可能影响所有 LLM 阶段 |
| Context/Evidence | P2 | M2/M3 | 重点比较输入覆盖和证据关系 |
| Skill Registry/SkillPlan | P2 | M3 | 重点比较指标口径和编排依赖 |
| 生命周期/审计 | P1/P2，恢复 P3 | M2 | 重点比较状态和日志可复盘性 |
| 适配器/结果结构 | P2/P3 | M3/M4 | 重点比较用户可见正文和页面截图 |

## 5. 阶段 0 验收记录

| 门禁 | 结果 | 证据 |
|---|---|---|
| 静态检查 | 通过 | `npm run check` |
| 全量自动化测试 | 通过，293/293 | `npm test` |
| 黄金用例清单 | 已建立 | `PLATFORM_MIGRATION_GOLDEN_BASELINE_V1.json` |
| 模块兼容契约清单 | 已建立 | `PLATFORM_DATA_INSIGHT_COMPATIBILITY_CONTRACT_V1.json`、`PLATFORM_SMART_QUERY_COMPATIBILITY_CONTRACT_V1.json` |
| 调用链和边界盘点 | 已完成 | 本文第 2-4 节 |
| 真实 LLM 双跑 | 未执行 | 阶段 4 交付 |
| PC/Mobile 新旧截图对比 | 未执行 | 阶段 4/6 交付 |

## 6. 未决风险

- 当前 `explorationGateway` 和 `intentGateway` 仍是两个独立实例，尚未迁移到 Manager；
- Gateway 的绝对总预算和聚合健康探针仍需在阶段 2 完成；
- 当前运行环境的 DashScope `443` 出站限制仍需单独作为环境门禁处理；
- 黄金用例中的真实新链路快照需要在适配器完成后生成，不能用旧结果冒充双跑结果。

## 7. 下一步

进入阶段 1：版本化公共契约和兼容校验。完成后必须更新本记录、目标计划、相关设计文档和 UAT 报告，再进入 Gateway Manager 实施。
