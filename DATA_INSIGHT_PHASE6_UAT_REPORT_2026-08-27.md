# 数据洞察阶段 6 UAT 报告

日期：2026-08-27

阶段 6 已通过。InsightRun、InsightDocument 和审计均持久化；访问以受信 `x-wyn-user-id`/`x-wyn-organization-id` 为边界；生成配额、并发限制、失败重试、敏感字段脱敏、软归档/恢复/删除和版本比较已实现。

API 证据：`phase5-6-api-uat.json`。用户 `uat-user-2/other-org` 读取他人洞察返回 403；Explore 运行越权返回 403；同一洞察生成两个版本并成功比较、导出、归档和恢复；审计包含 Planner/Critic/Narrator stageAudit、模型、Prompt hash、Skill 引用和 `rawRowsToLlm=false`。配额/并发和脱敏边界由 `test/insight-governance.test.mjs` 覆盖。

浏览器证据：`phase3-desktop.png`、`phase3-mobile-390x844.png`；控制台无阻断错误，严格 390x844 无横向溢出。

结论：阶段 6 治理闭环和最终 UAT 门禁通过。
