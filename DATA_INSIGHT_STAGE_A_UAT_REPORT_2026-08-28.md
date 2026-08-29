# 数据洞察平台化阶段 A UAT 报告

> 日期：2026-08-28（Asia/Shanghai）
>
> 阶段：A 业务下限可靠
>
> 验收基线：平台 P1 + 关键链路 P2；异常关键 P3；模块 M2；销售关键场景 M3
>
> 环境：`http://127.0.0.1:8787/`

## 1. 验收范围

本阶段验证确定性 Business Fact Pack、销售领域事实计算、Skill 绑定、LLM 上下文接入、LLM 降级结果、审计诊断和标准输入链路。`InsightInput v1`、原始明细外发策略和 8787 端口保持不变。

## 2. 自动化验收

| 检查 | 结果 |
|---|---|
| `node --check server.mjs` | 通过 |
| `node --check business-fact-engine.mjs` | 通过 |
| `node --check lib/data-insights/llm-orchestrator.mjs` | 通过 |
| `npm run check:insight` | 通过 |
| `npm test` | 233/233 通过 |

## 3. 平台级验收

| 用例 | 验收动作 | 结果 |
|---|---|---|
| P1-01 Skill 绑定 | 标准输入注册后检查运行 Skill refs 和业务事实 Skill 选择 | 通过：包含 `sales-baseline@1.3.0`；系统时间 Skill 不再遮蔽领域 Skill |
| P1-02 事实质量门禁 | 校验必需事实、范围、截断和完整度 | 通过：`evidenceCoverage=100`、`requiredFactsSatisfied=true`、`noTruncation=true` |
| P2-01 标准输入链路 | `POST /api/data-insights/inputs` → `POST /api/data-insights/{id}/generate` | 通过：返回 `insightId`、`runId` 和标准文档 |
| P3-01 LLM 异常 | 真实 Narrator 数字校验失败时检查结果状态和业务事实保留 | 通过：`status=degraded`，文档仍可用，原因码为 `NARRATOR_UNSUPPORTED_CLAIM` |
| P2-02 外发策略 | 检查编排审计外发策略 | 通过：`rawRowsToLlm=false` |

## 4. 模块级验收

| 用例 | 验收动作 | 结果 |
|---|---|---|
| M2-01 销售事实 | 使用 4 行、3 月、3 订单的合成销售数据生成事实 | 通过：销售额 3600、利润 550、订单数 3、客单价 1200 |
| M2-02 客单价口径 | 重复订单编号验证去重计数和聚合后计算 | 通过：金额合计 / 订单编号去重数，不按明细行平均 |
| M2-03 时间趋势 | 检查月度归并、趋势和高低点事实 | 通过：生成 `time-trend` 和 `time-anomaly` |
| M2-04 贡献与集中度 | 检查维度贡献和头部集中度事实 | 通过：生成 `dimension-contribution` 和 `concentration` |
| M3-01 用户结果状态 | 检查 LLM 降级后文档和状态 | 通过：保留管理摘要、关键发现、风险判断和行动建议区块，并显示降级状态 |

## 4.1 浏览器截图验收

| 视口 | 结果 | 证据 |
|---|---|---|
| 桌面默认视口 | 通过：数据集选择、语义目录、主工作区和输入区布局正常 | `stage-a-platform-desktop.png` |
| 严格 390x844 | 通过：底部导航、分析上下文和输入区可见；`scrollWidth=390`，无横向溢出 | `stage-a-platform-mobile-390x844.png` |

## 5. 关键 API 结果

本批最终测试输入：`ins-2f97ad77-3222-46f4-9931-30a2464b51ba`，运行：`ir-03583ec1-23d3-463f-bd27-032e6f4905ab`。

```text
status: degraded
provider: llm-orchestrated
skillRefs: temporal-semantics@1.0.0, sales-baseline@1.3.0
facts: data-quality, revenue-total, profit-total, orderCount-total,
       grossMarginRate-derived, average-order-value, time-trend,
       time-anomaly, dimension-contribution, concentration
qualityGates: completeness=100, evidenceCoverage=100,
              requiredFactsSatisfied=true, rangeKnown=true, noTruncation=true
diagnostics: NARRATOR_UNSUPPORTED_CLAIM
```

## 6. 结论与遗留项

阶段 A 的确定性业务下限已通过自动化和 8787 API 验证。LLM 叙事仍可能因供应商产生无法核验的数字而进入 `degraded`，但不会阻断业务事实和结果文档，这是本阶段预期的降级边界。

本阶段未直接修改 `skills/sales/skill.json` 和 `lib/skills/skill-registry.mjs`，原因是当前工作区对这些嵌套路径返回 reparse-point 写入限制；销售领域扩展字段由运行时画像提供，后续应在文件系统限制解除后回写正式 Skill 配置并执行 P1/P2 回归。该遗留项不影响本批运行结果，但必须在阶段 B 前关闭。

截图因当前工作区的 UAT 子目录写入限制暂保存于仓库根目录；后续目录权限恢复后移动到 `test/uat-artifacts/data-insight-stage-a-2026-08-28/`，不改变截图结论。
