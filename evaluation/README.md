# 跨行业评测包

评测包使用 wynai.evaluation-pack/v1。一个数据集可以有多个按场景拆分的评测包，不使用单个销售问题集代表所有行业。

- sales.v1.json：已审批销售基础包。
- laboratory.v1.json：实验室草稿包，待业务负责人确认。
- retail.v1.json：零售草稿包，待业务负责人确认。

## Smart Query AY/B 发布门禁

`packs/sales-ay-release.v1.json` 是当前智能问数平台的版本化回归门禁，固定使用新数据集 `18b86197-65e3-4682-8501-6e7125afad02`，覆盖 52 条 AY、B、解释型、语义边界和多值筛选用例。

运行：

```powershell
npm run uat:ay-release
```

该命令要求 8787 已启动，执行 Wyn 先查询的 API 门禁并写入 `UAT-AY/release-gate-1.0.0-2026-09-20/api-release-gate.json`。发布前还必须在同一候选版本使用真实内置浏览器重跑并保存 52 条截图，证据位于 `UAT-AY/release-gate-1.0.0-2026-09-20/`。预期澄清用例必须保持澄清，不得被当作失败或用业务 fallback 替代。

时间期望不得写死为某个自然日。对“截止目前”这类相对时间，评测包使用 `{"$relativeDate":"businessDate","offsetDays":1}` 表示排他上界；运行器在同一轮 52 条用例开始时固定 Asia/Shanghai 业务日期并解析该表达式。这样跨日只会改变统一的运行时锚点，不会把正常的日期物化误报为回归。

发布阻断条件包括：任一 API/浏览器用例失败、时间/筛选/字段约束遗漏、结果为样本或截断、内部字段泄漏、业务 fallback、Trace/执行归属缺失（澄清态除外）或浏览器控制台出现 error/warn。

运行器位于 lib/evaluation/evaluation-suite.mjs。普通用户反馈会形成待审核候选；只有行业负责人确认的黄金答案才能合并到 approved 评测包。

