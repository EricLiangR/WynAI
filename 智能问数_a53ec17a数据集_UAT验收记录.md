# a53ec17a 数据集 Skill 治理后 UAT 验收记录

## 验收信息

- 数据集：`a53ec17a-a8e7-43ce-8552-ec4805071efa`
- Skill：`sales-opportunity-a53@1.0.0`
- 平台：PC 端
- 目标：验证字段语义与 Skill 治理后，LLM 对时间、产品、占比、多值筛选和商机数量的理解是否提升。

## 用例清单

| 编号 | 问题 | 预期检查点 | 实际结果 | 截图 |
| --- | --- | --- | --- | --- |
| UAT-01 | 去年最热卖的 product 是什么 | 产品名称排名，销售额聚合，时间口径明确 | 通过澄清后执行：按自然年 2025，Top1 为 `Safety Production and Risk Control in Manufacturing`，下钻客户 5 家；修复了排名对象序列化和先排名后下钻 | `uat-a53-01-ranking-drilldown-fixed.png` |
| UAT-02 | 去年最热卖的 product 是什么，是哪些客户 | 先产品 Top1，再固定产品下钻客户，不改变 Top1 | 通过：先固定产品 Top1，再返回 5 个客户；未再出现组合维度直接参与排名 | `uat-a53-01-ranking-drilldown-fixed.png` |
| UAT-03 | 去年 Risk Management product 的具体金额是多少 | 产品小类规范值映射，金额使用 CNY 求和 | 通过：明确 2025 自然年后，产品小类映射正确，金额为 `151,552,302.23` 元 | `uat-a53-03-risk-management-amount.png` |
| UAT-04 | 去年 Risk Management product 的占比是多少，具体金额是多少 | 分子/分母独立查询；自然年/财年歧义澄清 | 通过：自然年/财年先交互确认；明确自然年 2025 后，分子 `151,552,302.23` 元，占全部产品销售额 `15.12%`。修复了全量分母、切片回筛和 `divide→ratio` 归一化 | `uat-a53-04-risk-management-share.png` |
| UAT-05 | 客户类型为 MNC 且客户所属行业为 Consumer Products 的记录 | 不同字段默认 AND；MNC 多值成员映射 | 通过语义编译：两个字段按 AND，MNC 使用多值成员匹配；当前数据返回 0 条 | `uat-a53-05-mnc-industry-count.png` |
| UAT-06 | MNC 客户且 Consumer Products 行业的商机有多少个 | `pipelineCode` distinctCount，不是金额求和 | 通过：使用 `pipelineCode` 去重计数，结果为 `0` 个；不是金额求和或明细行数 | `uat-a53-05-mnc-industry-count.png` |
| UAT-07 | 客户类型为 MNC 或 POE | 同字段多个值使用 OR/IN | 待执行 | 待补充 |
| UAT-08 | 同时包含 MNC 和 POE 的客户 | 用户明确“同时包含”时使用 containsAll | 待执行 | 待补充 |
| UAT-09 | FY25 与 FY26 的销售额对比 | 使用赢单财年，不与自然年混淆 | 待执行 | 待补充 |
| UAT-10 | 2025 年销售额按月查看 | 使用赢单日期自然年，不能混入财年月份 | 待执行 | 待补充 |

## 验收结论

### 本轮平台级修复

- `query-program` 对 LLM 输出的排序对象做别名归一化，并实现“先排名、后下钻”的通用执行步骤。
- 对 Skill 声明存在自然年/财年冲突的相对年份，统一转为按钮式多轮澄清；用户选择后重新走 LLM 规划。
- 禁止无分组表达被旧数据集描述隐式污染为时间序列，避免标量问题因错误粒度校验失败。
- 占比统一使用全量分母：移除切片过滤、补充切片维度、聚合全量后回筛用户切片；兼容 LLM 偶发输出的 `divide` 算子。
- 未注册的临时公式不再静默执行；后续需要将“切片占比”正式纳入 Skill 派生指标契约，或保留为平台内置能力。

### 当前剩余项

- UAT-07～UAT-10（同字段 OR/IN、containsAll、FY25/FY26 对比、2025 按月）尚未在本轮截图回归中完成，下一轮继续执行。
- 目标数据集的原始业务描述仍包含大量执行规则，建议按已交付的字段语义下沉文档和最终数据集描述逐步清理，避免继续干扰 LLM。

本轮已在 8787 真实服务、目标数据集和 `sales-opportunity-a53@1.0.0` Skill 上完成 PC 端回归。UAT-01～UAT-06 已取得真实 LLM 规划、Skill 引用、Canonical Query、查询结果和截图证据；其中排名下钻、自然年/财年交互澄清、Risk Management 金额与占比、复合筛选和商机去重计数均符合预期。后续用例继续沿用同一验收记录，若失败按“字段语义、Skill、Prompt、查询编译、结果表达”分类修复，不针对单个问题写一次性规则。
