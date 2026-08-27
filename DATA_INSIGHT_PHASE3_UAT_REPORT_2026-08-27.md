# 数据洞察阶段 3 UAT 报告

日期：2026-08-27

## 当前状态

阶段 3 已验收通过（合成非敏感数据真实外部 LLM UAT）。

- 代码侧已有 Planner/Critic/Narrator 编排、结构化输出和证据校验；固定引擎已从正式 `/generate` 降级路径移除，未配置 LLM 时返回 `INSIGHT_LLM_REQUIRED`。
- Evidence Pack 已接入 LLM 请求。服务端先基于全量结果生成时间、维度、时间+维度和层级组合聚合证据，再交给 LLM；原始明细不会直接进入 Prompt。
- `npm run check`、`npm run check:insight` 和 `npm test` 均通过，当前最终全量回归为 209/209。
- 真实 DashScope `deepseek-v4-flash-0731` 生成成功，Planner/Critic/Narrator 均为 `completed`。
- 生成结果持久化为 `InsightDocument v1`，所有管理摘要、发现、风险和行动均引用 Evidence ID。
- 外发策略审计为 `rawRowsToLlm=false`，Prompt 仅含 Evidence Pack；本次使用合成 UAT 数据，未发送真实业务明细。
- 桌面与严格 `390x844` 移动截图通过，移动 `scrollWidth=375`、`innerWidth=390`，无横向溢出。

## 412 行多维月度场景专项回归

用户场景：问数“统计近三年各个大区、省份、城市每个月的销售额、利润、订单数量”返回 412 行后生成数据洞察。修复前 Narrator 使用证据日期中的年份 `2023` 时，数字校验器只读取 JSON 数值，错误返回“Narrator 使用了证据中不存在的数字：2023”。

本次修复同时处理了证据覆盖和叙事校验两层问题：

- Evidence Pack 从全部 412 行构建月度、单维度、月度+维度以及大区/省份/城市层级组合聚合；每个聚合保留 `recordCount`，不再只依赖少量边界样本判断趋势和区域差异。
- Narrator 校验递归读取对象和数组中的数值，并识别日期/文本中的年份、月份。
- 支持受控验证 `万`、`亿`、百分比等表达，包括金额单位换算及同一引用证据集合内的派生比例。
- 首次 Narrator 输出因数字越界未通过时，使用原证据执行一次严格修复重试；第二次仍不合法则保持失败，不产生伪成功洞察。
- 聚合目录按“一个聚合组一个 Evidence ID”提供给 LLM，控制 Prompt 体积并避免结构化 JSON 被截断。

专项 UAT 使用 412 行合成、非敏感的月度多维数据调用真实 DashScope `deepseek-v4-flash-0731`。结果：Insight `ins-abe090f6-0811-4e45-b847-02a30af9263b`，Planner/Critic/Narrator 全部 `completed`，54 条 Evidence，4 个 InsightDocument block；页面不再出现 `2023` 数字校验错误，并生成了趋势、区域差异和风险结论。该外部模型重测未使用用户的真实业务数据。

专项自动化覆盖日期文本年份、`61.6万元` 对应 `616000`、同证据集合利润率和无证据数字拒绝；当前全量测试 209/209 通过。

## 验收证据

- Insight：`ins-cdb06f8b-8ded-47cb-a826-0544176f3ef8`。
- 阶段审计：`C:/Users/zenoszeng/.codex/visualizations/2026/08/26/01a03e7d-fda4-7b71-9efa-02ff464e2d79/phase6-final/phase3-final-api.json`。
- 桌面截图：`.../phase3-desktop.png`；移动截图：`.../phase3-mobile-390x844.png`。
- 412 行专项桌面截图：`C:/Users/zenoszeng/.codex/visualizations/2026/08/26/01a03e7d-fda4-7b71-9efa-02ff464e2d79/phase6-repro-v2/repro-412-desktop.png`。
- 412 行专项移动截图：`C:/Users/zenoszeng/.codex/visualizations/2026/08/26/01a03e7d-fda4-7b71-9efa-02ff464e2d79/phase6-repro-v2/repro-412-mobile-390x844.png`；`scrollWidth=375`、`bodyScrollWidth=375`，无横向溢出。

## 重试条件

1. 如生产环境更换 LLM 端点，按同一流程重跑真实结构化生成。
2. 使用当前 Skill 目录重新生成销售、实验室、零售 UAT 夹具，确认版本和数据集 ID。
3. 通过桌面/390x844 浏览器截图、数字/证据校验后，自动进入下一阶段。
