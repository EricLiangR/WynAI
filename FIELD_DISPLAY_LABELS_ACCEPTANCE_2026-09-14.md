# 字段展示语义优化验收记录

日期：2026-09-14

## 验收结果

| 用例 | 预期 | 结果 |
| --- | --- | --- |
| `pipelineCode` 按 `distinctCount` 聚合 | 显示“项目数量（去重）”，源字段仍为 `pipelineCode` | 通过 |
| `Opportunity_amount_CNY` 求和且无业务别名 | 显示“收入（人民币）” | 通过 |
| `Opportunity_amount_USD` 求和且无业务别名 | 显示“收入（美元）” | 通过 |
| 金额字段已有数据集/Skill 业务名 | 优先显示业务名，不强制替换为平台默认名 | 通过 |
| `pipelineCode` 作为明细字段 | 按维度业务语义展示，不套用“项目数量” | 通过 |
| 原始字段与展示名同时保留 | 可审计、可执行、可定位 | 通过 |

## 自动化证据

- `node --test field-display-labels.test.mjs`：3/3 通过。
- `node --check field-display-labels.mjs`：通过。
- `node --check lib/query/result-normalizer.mjs`：通过。

## 验收结论

平台级字段展示标签能力已完成。当前仍需重启 8787 进程后，浏览器才会加载新的结果 Schema 展示标签。
