# 独立问数通用公式派生指标需求、设计与 UAT 报告

> 状态：已实现并验收
>
> 日期：2026-08-25（Asia/Shanghai）
>
> 基线数据集：`2b445034-38fe-4350-9cab-b7684c28b5f8`
>
> 服务地址：`http://127.0.0.1:8787`

## 1. 目标与范围

本专项把“毛利率未识别”从单一用例问题提升为通用公式派生指标能力。毛利率是第一个由 Skill 治理并完成真实数据验收的公式指标，不在代码中写死业务口径。

本轮目标：

1. LLM 负责理解用户是否需要已治理的派生指标，不负责发明生产公式。
2. Skill 保存指标 ID、同义词、依赖、白名单算子、聚合顺序、单位、除零策略和版本。
3. Wyn 只执行基础字段聚合；平台在聚合结果上受控计算公式。
4. 用户只问派生指标时，依赖列参与查询但不出现在最终结果。
5. 原问题要求的派生指标不得静默遗漏；无审批口径时必须澄清。
6. LLM 遗漏、增加或修改公式、依赖和 Skill 版本时必须被校验拒绝。
7. 多轮追加、分组、时间序列、百分比格式和组合图继续使用统一协议。

非目标：

- 不允许 LLM 返回 SQL、WAX、任意查询 Payload 或自由公式字符串。
- 不允许自动执行未经审批的模型建议公式。
- 本轮不引入向量库。
- 本轮不把行级比例平均后当作汇总毛利率。

## 2. 业务口径

销售 Skill `sales-baseline@1.2.0` 新增 `grossMarginRate`：

```json
{
  "id": "grossMarginRate",
  "concept": "grossMarginRate",
  "name": "毛利率",
  "synonyms": ["销售毛利率"],
  "unitFamily": "percentage",
  "outputAlias": "gross_margin_rate",
  "formula": {
    "schema": "wynai.metric-formula/v1",
    "operator": "ratio",
    "inputs": ["profit", "revenue"],
    "aggregationOrder": "aggregate-then-calculate",
    "zeroDivision": "null"
  }
}
```

执行口径：

```text
毛利率 = SUM(订单利润) / SUM(订单金额)
```

禁止口径：

```text
AVG(订单利润 / 订单金额)
```

分母为零时返回 `null`，不得产生 `Infinity` 或 `NaN`，并在结果质量信息中记录提示。

## 3. 协议设计

### 3.1 Skill 指标公式

`wynai.metric-formula/v1` 只允许白名单算子：

- `ratio`：聚合后的分子除以聚合后的分母；
- `difference`：聚合后的首个输入依次减去后续输入；
- `percentage`：以小数比例保存并按百分比展示。

公式引用稳定的 Skill 基础指标 ID，不直接引用任意表达式。基础指标自身继续声明 Wyn 字段与聚合方式。

### 3.2 QuestionSemanticFrame v2

问题语义帧增加公式派生指标信息：

```json
{
  "type": "formula",
  "operator": "ratio",
  "metricId": "grossMarginRate",
  "concept": "grossMarginRate",
  "source": "毛利率",
  "alias": "gross_margin_rate",
  "dependencyMetricIds": ["profit", "revenue"],
  "aggregationOrder": "aggregate-then-calculate",
  "zeroDivision": "null",
  "skillRef": "sales-baseline@1.2.0"
}
```

未命中审批 Skill 的“率/占比/比例”类指标进入未解析公式状态，阻止查询执行并触发澄清。

### 3.3 BusinessQueryIntent v2

`derivedMetrics` 对公式指标保存：

- `metricId`、`concept` 和稳定 `alias`；
- 白名单 `operator`；
- `dependencies[{metricId, sourceAlias}]`；
- `aggregationOrder`；
- `zeroDivision`；
- `resultType`、`unitFamily`；
- 精确 `skillRef`。

基础依赖位于 `metrics`，并可使用 `internal: true` 标记为计算专用。最终 `expectedResult.requiredMetrics` 只要求用户可见基础指标与派生指标。

### 3.4 QueryProgram v1

查询程序增加两个受控步骤：

1. `derive-formula`：在 Wyn 分组聚合结果上执行白名单公式；
2. `drop-internal-metrics`：公式完成后删除计算专用依赖列。

顺序固定为：

```text
Canonical 基础聚合 -> Wyn -> derive-formula -> 时间投影/排名 -> 删除内部列 -> 结果校验
```

### 3.5 LLM 边界

中风险公式问题进入 LLM 复核。模型只能逐字保留确定性候选和已审批 Skill 中存在的公式指标，不得：

- 新增用户未要求的公式指标；
- 修改公式算子；
- 修改依赖指标及其结果别名；
- 修改 Skill 引用；
- 用自由文本公式替代结构化协议；
- 去掉原问题明确要求的派生指标。

LLM 输出之后仍执行字段白名单、原问题覆盖、语义非扩张、公式治理和 Canonical 编译校验。模型丢失中文名称、单位或内部标记时，由确定性 Skill 基线恢复展示元数据；安全相关公式字段仍须严格一致。

## 4. 用户体验

- “分析每年的销售额、利润和毛利率”展示 9 年明细和双轴组合图。
- 订单金额、订单利润使用左轴柱形；毛利率使用右轴折线。
- “每年毛利率”只展示订购日期和毛利率，不展示利润、销售额依赖。
- “统计每年销售额”后追问“同时增加毛利率”，继承年度粒度并在第二轮增加毛利率。
- 详情中显示“毛利率（聚合后比值）”，不显示内部协议名 `ratio`。
- 未配置的“净利率”等指标返回口径澄清，不退化成利润或其他基础指标。

## 5. 自动化验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 公式指标专项 | `node --test test/formula-derived-metrics.test.mjs` | 11/11 |
| 全量回归 | `npm test` | 175/175 |
| 静态检查 | `npm run check` | 通过 |
| 真实 Wyn UAT | `npm run uat:formula-metrics` | 7/7 |

专项自动化覆盖：

1. Skill 版本和公式持久化；
2. 年度多指标聚合后比值；
3. 仅派生指标的内部依赖隐藏；
4. 地区分组；
5. 多轮追加；
6. 分母为零；
7. 未审批 Skill；
8. LLM 遗漏与发明公式；
9. LLM 丢失展示元数据/internal 标记；
10. 同义词与标量百分比；`r`n11. 派生指标在公式计算后的 Top/Bottom 排名。

## 6. 真实 Wyn UAT

| 用例 | 用户问题/场景 | 验证重点 | 结果 |
| --- | --- | --- | --- |
| UAT-FDM-01 | 分析每年的销售额、利润和毛利率 | 9 行；逐行利润/收入；combo；右轴百分比；LLM 中风险复核 | 通过 |
| UAT-FDM-02 | 每年毛利率 | 最终 Schema 仅 period、gross_margin_rate | 通过 |
| UAT-FDM-03 | 按地区分析毛利率 | 6 个地区；各组返回百分比 | 通过 |
| UAT-FDM-04 | 每年销售额 -> 同时增加毛利率 | 继承年粒度；第二轮仅增加指标 | 通过 |
| UAT-FDM-05 | 销售毛利率是多少 | 同义词；标量；KPI 48.16% | 通过 |
| UAT-FDM-06 | 每年净利率 | 无审批口径时澄清；0 个查询请求 | 通过 |`r`n| UAT-FDM-07 | 毛利率最高的地区 | 先计算各地区比率，再按派生指标 Top1 | 通过 |

真实 Wyn 年度结果范围为 2017-2025，共 9 行。示例：

| 年份 | 销售额 | 利润 | 毛利率 |
| --- | ---: | ---: | ---: |
| 2017 | 2,924,399.79 | 1,412,553.79 | 48.30% |
| 2023 | 3,113,839.42 | 1,484,876.42 | 47.69% |
| 2025 | 858,563.79 | 406,337.79 | 47.33% |

API 证据：`test/uat-artifacts/formula-derived-metrics-2026-08-25/latest.json`

## 7. 浏览器截图验收

| 截图 | 场景 | 用户视角结论 | 结果 |
| --- | --- | --- | --- |
| UAT-FDM-UI-01 | 年度销售额、利润、毛利率 | 回答与详情名称正确；组合图非空；两组柱和右轴折线清晰；无遮挡 | 通过 |
| UAT-FDM-UI-02 | 仅毛利率 | 表格只有订购日期、毛利率；百分比格式正确；依赖未泄露 | 通过 |
| UAT-FDM-UI-03 | 多轮追加 | 两轮消息均可见；上下文为 2 轮；第二轮表格包含销售额和毛利率 | 通过 |

截图目录：`test/uat-artifacts/formula-derived-metrics-2026-08-25/screenshots/`

浏览器控制台错误/警告：0。

## 8. 缺陷闭环

| 编号 | 严重度 | 问题 | 修复 | 状态 |
| --- | --- | --- | --- | --- |
| FDM-001 | P1 | 仅毛利率时内部利润和收入仍留在结果 | 增加 `drop-internal-metrics` | 已关闭 |
| FDM-002 | P1 | 未审批率指标可能退化为基础利润 | 未知率指标进入未解析公式状态并澄清 | 已关闭 |
| FDM-003 | P1 | “销售毛利率”中的“销售”误识别为销售额 | 长语义短语优先并排除公式词内子串 | 已关闭 |
| FDM-004 | P2 | 混合 LLM 丢失中文名称，显示 grossMarginRate | 从确定性 Skill 基线恢复展示元数据 | 已关闭 |
| FDM-005 | P3 | 详情显示英文 ratio | 前端映射为“聚合后比值” | 已关闭 |
| FDM-006 | P3 | 内部滚动页面的 fullPage 截图可能空白 | 改为目标控件滚入视口后截取可见视窗 | 已关闭（测试设施） |

## 9. 后续扩展规则

新增同类公式指标时，若使用已支持白名单算子，只需新增或升级审批 Skill，并补充领域评测，不需要修改查询执行代码。任何新算子、窗口函数、跨粒度分母或跨数据集公式仍须经过协议设计、安全实现和专项 UAT，不能只改 Skill 配置后直接上线。
## 10. sales-baseline@1.3.0 客单价扩展

本次验证了同类公式指标可通过审批 Skill 扩展，无需修改运行时代码。新增受治理指标 `averageOrderValue`，业务名称为“客单价”，同义词包括“平均客单价、平均订单金额、每单金额、订单均价”。

口径为 `SUM(订单金额) / DISTINCTCOUNT(订单编号)`，在当前分组和筛选粒度聚合后计算；订单数作为内部依赖参与 Wyn 查询，最终结果不展示内部依赖列。禁止按客户数计算，也禁止直接平均订单明细金额。

验证结果：

| 验证项 | 结果 |
| --- | --- |
| Skill 版本 | `sales-baseline@1.3.0` |
| 公式专项 | 12/12 |
| 全量自动化回归 | 176/176 |
| 静态检查 | 通过 |
| 真实 Wyn 增量 UAT | 1/1 |
| 用户问题 | `2024年，统计每个地区的销售额、利润和客单价` |
| 返回结果 | 6 个地区，包含 `revenue`、`profit`、`average_order_value` |
| 语义与质量校验 | 通过；非样本、未截断、无质量警告 |

真实结果中，西南地区客单价约为 4,101.75，华东约为 3,716.45；运行意图记录的公式依赖为 `revenue` 和 `order_count`，Skill 引用为 `sales-baseline@1.3.0`。
