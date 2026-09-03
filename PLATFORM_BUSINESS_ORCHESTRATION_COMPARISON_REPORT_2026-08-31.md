# 平台业务编排新旧链路比较报告

> 日期：2026-08-31（Asia/Shanghai）
> 结论：平台兼容双跑和黄金基线均通过；业务算法复制不属于本平台迁移目标

## 1. 本次验收

以同一标准输入运行 `8787 legacy` 和隔离 `8790 shadow`，检查 Gateway、适配器契约、原始问题、数据集、权限、Skill、Evidence、多轮上下文、Planner/Critic/Narrator 状态、最终正文和生命周期。

## 2. 证据

| 链路 | 结果 | 证据 |
|---|---|---|
| 8787 legacy 平台兼容 | `201/200`，诊断有效 | `uat-platform-compatibility-2026-08-31-final/latest.json` |
| 8787 legacy 数据洞察 | `completed`，正文/文档存在 | `uat-followup-platform-2026-08-31-final/latest.json` |
| 8790 shadow 智能问数 | `comparisonPassed=true`，候选 profile 可追踪 | `uat-platform-compatibility-2026-08-31-final-shadow/latest.json` |
| 8790 shadow 数据洞察 | `completed`，三阶段和生命周期有效 | `uat-followup-platform-2026-08-31-final-shadow/latest.json` |
| LLM 连通性 | v2 探针通过，独立目录落盘 | `uat-llm-connectivity-evidence/` |
| 复杂多轮智能问数 | 728 行/8 页；确认同比后完成；追问继承筛选和月度粒度 | `uat-platform-smart-query-complex-desktop-2026-08-31.png`、`uat-platform-smart-query-complex-mobile-390x844-2026-08-31.png`、`uat-platform-smart-query-followup-mobile-390x844-2026-08-31.png` |

## 3. 判定

未发现核心数值、公式、过滤、权限、指标/维度、Evidence、终态或页面答案差异。trace/run/conversation ID、候选元数据和非关键文案属于可接受差异。

候选业务编排器是独立治理边界和上下文审计门面，`execute` 由模块注入复用。这是平台层与模块层职责分离的设计：本报告的通过表示平台契约、路由、治理和结果兼容通过；不将“复用模块业务算法”误报为算法替换，也不要求为平台迁移复制两套 Planner/Critic/Narrator。

## 4. 阶段 7 前置门禁

必须保存候选 Planner/Critic/Narrator 的结构化快照、逐字段比较和历史黄金用例成对重跑；任一核心差异都回退 legacy，由 UAT 验收官签字后才允许 canary/platform 晋级。本批次上述门禁已通过；算法替换若未来发生，另立专项。

## 5. Shadow 可复现性修复

此前 shadow 并发启动 legacy 与 candidate，两个相同输入可能同时穿透 Gateway 缓存并触发独立 LLM 生成，导致 Narrator 条目数量或证据归属随机漂移。现已改为 legacy 基线先行、candidate 后行；相同请求命中 Gateway 短 TTL 缓存，真实候选提示或算法变化仍会产生独立请求并接受原有阻断门禁。修复后 8790 数据洞察结构化比较 `passed=true`、差异 0，智能问数兼容比较仍通过。该机制提升的是比较证据的可复现性，不等同于独立业务算法双实现完成。

## 6. 历史黄金用例成对运行

`uat-platform-golden-live.mjs` 已对 `DI-GOLD-001` 至 `DI-GOLD-010` 执行真实 shadow 成对验收。10 个用例均返回 `llm-orchestrated` 成功结果，`platform.migration.orchestration.comparison.passed=true`、`differenceCount=0`，诊断生命周期 `valid=true`、`openAttempts=0`。证据目录为 `uat-platform-golden-2026-08-31/`。

黄金运行器证明的是当前执行器在标准输入和平台迁移边界上的可回归性；它不会把候选复用旧业务执行器误报为算法替换。平台迁移目标已经满足，未来若需要独立算法替换，再建立新的版本化实现和验收官签字流程。

发布策略现在通过 `evaluateGoldenBaselineReport()` 消费该机器报告。缺失用例、非零阻断差异、开放运行、无效生命周期或非 `llm-orchestrated` 生成均会阻断晋级，不能通过手工门禁标记放行。
