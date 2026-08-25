# 跨行业评测包

评测包使用 wynai.evaluation-pack/v1。一个数据集可以有多个按场景拆分的评测包，不使用单个销售问题集代表所有行业。

- sales.v1.json：已审批销售基础包。
- laboratory.v1.json：实验室草稿包，待业务负责人确认。
- retail.v1.json：零售草稿包，待业务负责人确认。

运行器位于 lib/evaluation/evaluation-suite.mjs。普通用户反馈会形成待审核候选；只有行业负责人确认的黄金答案才能合并到 approved 评测包。

