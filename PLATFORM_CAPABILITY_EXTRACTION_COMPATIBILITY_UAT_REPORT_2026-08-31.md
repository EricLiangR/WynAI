# 平台公共能力抽取与模块兼容迁移 UAT 报告

> 版本：1.1
> 日期：2026-08-31（Asia/Shanghai）
> 环境：`http://127.0.0.1:8787/`
> 验收范围：平台 Gateway、Context/Evidence 契约、数据洞察适配器、智能问数适配器、迁移观测和用户入口

## 1. 验收结论

本批次完成平台兼容链路的真实 API 和浏览器验收，平台底座在 `legacy`、`shadow`、`canary`、`platform` 四种模式下均完成隔离验证，适配器、迁移运行时和回滚策略可观测。自动化测试最新为 `331/331` 通过，真实 LLM 成功、严格失败、浏览器 PC/Mobile 和正式 legacy 回滚均有证据。

此前真实 LLM 失败记录保留为历史环境阻塞。2026-08-31 在允许出站的服务上下文中 DashScope 443 已可达，`/api/llm/health` 为 `healthy`；8787 legacy 和 8790 shadow 均完成真实生成验收。

## 2. 用例汇总

| 用例 | 级别 | 动作 | 结果 | 证据 |
|---|---|---|---|---|
| P2-PLAT-001 | P2 | `/api/platform/migration` 检查 Gateway、适配器版本、迁移运行时、模式和回滚模式 | 通过 | `uat-platform-compatibility-2026-08-31/latest.json` |
| M2-DI-001 | M2 | POST 标准 `InsightInput v1`，GET 详情并检查 `platform.migration.run` 诊断事件 | 通过，`ins-4b24d016-f8ff-4114-9a0e-81e17c9e9f89`，诊断有效 | 同上 |
| M2-SQ-001 | M2 | 创建智能问数会话并提交包含 `sql` 的非法请求 | 通过，HTTP 400，`CONTRACT_INVALID` | 同上 |
| P3-UI-001 | P3 | 智能问数入口桌面视图 | 通过 | `smart-query-desktop.png` |
| P3-UI-002 | P3 | 智能问数入口 `390x844` 移动视图 | 通过 | `smart-query-mobile-390x844.png` |
| M3-UI-001 | M3 | 数据洞察工作台桌面视图，检查标准输入、结果表和生成入口 | 通过 | `data-insight-desktop.png` |
| M3-UI-002 | M3 | 数据洞察工作台 `390x844` 移动视图 | 通过 | `data-insight-mobile-390x844.png` |
| P3-LLM-001 | P3 | 真实 LLM 健康探针和生成失败路径 | 未通过（环境阻塞） | `uat-platform-followup-2026-08-30/latest.json` |
| P2-MIG-001 | P2 | 8790 `shadow` 模式：数据洞察与智能问数双跑/候选比较 | 通过，比较 0 差异 | `uat-platform-compatibility-2026-08-31-shadow/latest.json` |
| P2-MIG-002 | P2 | 8792 `canary` 模式：候选路径可用且 legacy 回滚模式可观测 | 通过，最新版本复验候选 profile 可见 | `uat-platform-compatibility-2026-08-31-canary-rerun/latest.json` |
| P2-MIG-003 | P2 | 8794 `platform` 模式：候选路径可用且 legacy 回滚模式可观测 | 通过 | `uat-platform-compatibility-2026-08-31-platform/latest.json` |
| P2-MIG-004 | P2 | 候选业务编排门面执行上下文审计并保留候选版本，不改变 legacy 用户结果 | 通过，自动化专项 3/3；legacy 与 shadow API 复验通过，shadow `candidateProfile=smart-query-platform-candidate-v1` | `platform-business-orchestrators.test.mjs`、`uat-platform-compatibility-2026-08-31-shadow-rerun4/latest.json`、`uat-platform-compatibility-2026-08-31-legacy-rerun/latest.json` |
| P3-MIG-005 | P3 | 按模块、用户 allow-list 和比例执行请求级灰度，未命中主体回到 legacy | 通过：allow-list 用户走 canary，外部用户走 legacy | `uat-platform-migration-routing-2026-08-31/latest.json` |
| P3-MIG-006 | P3 | 同一进程并发执行两个组织的数据洞察和智能问数请求，验证主体、组织过滤、会话和迁移 trace 隔离 | 通过：4 个并发请求、2 个 insight、2 个 conversation 均独立，组织过滤保持 | `uat-platform-concurrency-2026-08-31-rerun2/latest.json` |
| M3-LLM-007 | M3 | 8790 shadow 真实 LLM 数据洞察跟进生成，检查 Planner/Critic/Narrator、正文、文档和生命周期 | 通过：`completed`，正文/文档存在，生命周期 `valid=true` | `uat-followup-platform-2026-08-31-shadow-llm-success/latest.json` |
| P2-MIG-008 | P2 | 8790 shadow 真实 LLM 智能问数兼容双跑 | 通过：`comparisonPassed=true`，候选 profile 可追溯 | `uat-platform-compatibility-2026-08-31-shadow-llm-success/latest.json` |
| P3-ROLLBACK-009 | P3 | 停止 shadow，8787 重启为 legacy，重跑兼容、并发和真实生成 | 通过：模式为 `legacy`，三组 UAT 均通过 | `uat-platform-compatibility-2026-08-31-rollback-legacy/latest.json`、`uat-platform-followup-2026-08-31-rollback-legacy/latest.json`、`uat-platform-concurrency-2026-08-31-rerun2/latest.json` |
| P3-UI-010 | P3 | 真实智能问数成功结果 PC 与 `390x844` 移动端截图 | 通过：结果、表格、图表、追问入口可见，无核心遮挡 | `uat-platform-smart-query-desktop-2026-08-31.png`、`uat-platform-smart-query-mobile-390x844-2026-08-31.png` |
| M2-SQ-011 | M2 | 公式指标与泛化同比并存，多轮选择“销售额和利润都做同比增长率” | 通过：第二轮 `ok`，旧未决槽位清除，保留毛利率/同比派生指标 | `test/advanced-smart-query.test.mjs`、浏览器/API 实测 `conv-3415881e-7de9-4eab-a27e-68e816868b5c` |

## 3. 截图验收观察

- 智能问数入口独立显示于左侧导航，数据集、语义目录、对话输入和连续追问入口可见。
- 数据洞察页面能显示标准输入、字段/行数/完整度、结构化结果预览和 AI 洞察工作台；移动视图底部导航可操作，未发现横向溢出或遮挡。
- 真实 LLM 成功结果已完成 PC 与移动端截图；严格证据校验失败路径没有使用降级正文冒充成功。
- 移动端截图显示结果内容区可滚动，表格和底部输入区均保持可操作；桌面端显示图表、表格、复制/下载和数据洞察入口。

## 4. 日志与契约证据

- `/api/platform/migration` 暴露 `wynai.platform-migration-status/v1`，包含 Gateway 聚合快照、DataInsightAdapter、SmartQueryAdapter、当前模式和固定回滚模式。
- 数据洞察真实接入请求写入 `wynai.platform-migration-run/v1` 的 `platform.migration.run` 事件；`legacy` 模式只执行旧路径，shadow/canary/platform 的路由由同一运行时控制。
- 标准数据洞察输入保留 `InsightInput v1`、原始问题、范围过滤和结果 Schema。
- 智能问数入口拒绝原始 `sql` 字段，证明平台无关交互契约在真实 HTTP 入口生效。
- 8790 shadow 真实请求在智能问数 trace 中返回 `platformMigration.mode=shadow`、`comparisonPassed=true`；canary/platform 实例验证候选路径均可完成标准请求。
- 候选业务编排已从“仅适配请求”提升为独立的平台编排边界：数据洞察候选路径记录 `data-insight-platform-candidate-v1` 和上下文审计，智能问数候选路径记录 `smart-query-platform-candidate-v1`，保留原始问题、多轮消息、Skill、权限和数据集引用；候选元数据不进入用户可见答案。
- 请求级灰度路由使用稳定哈希桶和显式 allow-list；本轮以 `percentage=0` 验证 allow-list 用户进入 canary、未命中用户保持 legacy，trace 同时记录 `configuredMode`、`bucket`、`reason` 和候选 profile。
- LLM 失败路径保留 `runId`、attempt、终态和错误码，不生成伪成功正文。

## 5. 缺陷与遗留风险

| 编号 | 严重度 | 描述 | 状态 | 后续 |
|---|---|---|---|---|
| PLATFORM-UAT-001 | P1 | 历史运行账号访问 DashScope 443 返回 EACCES，真实 LLM 成功链路无法验收 | 已关闭（允许出站上下文复验通过） | 保留历史失败证据；后续发布继续监控服务进程出站权限 |
| PLATFORM-UAT-002 | P1 | 当前双跑已接入标准输入和交互契约适配路径，但尚未绑定独立的业务分析编排器（Planner/Critic/Narrator）新旧实现 | 已关闭（平台目标边界已满足） | 候选编排门面、结构化快照和差异门禁已接入；业务算法复制不属于本目标 |
| PLATFORM-UAT-003 | P2 | 迁移模式当前为启动时配置，运行时切换不支持 | 已知设计限制 | 通过重启 `PLATFORM_MIGRATION_MODE=legacy` 回滚；后续再评估动态控制面 |
| PLATFORM-UAT-004 | P1 | shadow 候选路径异常曾会因 `Promise.all` 传播而影响 legacy 用户请求 | 已关闭 | 改为 `Promise.allSettled`；候选失败只记录 `candidate-failed`，旧路径结果继续返回；新增回归测试 |
| PLATFORM-UAT-005 | P1 | 候选业务编排此前只复用输入规范化/同一执行入口，无法证明候选路径具备独立上下文治理边界 | 已关闭 | 候选业务编排门面、上下文审计和版本标识已接入运行时；真实 LLM 成功双跑、结构化结果差异和浏览器正文对比均已通过 |
| PLATFORM-UAT-006 | P1 | 澄清选择同时包含受治理公式指标和泛化同比时，旧未决同比槽位残留，导致重复澄清 | 已关闭 | `applyDerivedSelection` 清除未绑定比较槽位、输出和 requiredMetrics；新增回归并通过 |
| PLATFORM-UAT-007 | P2 | UAT 连通性脚本向历史证据目录写入时出现一次 `EPERM`，不影响产品请求 | 已关闭（测试基础设施） | v2 脚本使用唯一运行目录和原子索引更新 |

## 6. 发布判定

本批次阶段 4/5/6 核心验收通过，阶段 7 发布门禁已通过：真实 Planner/Critic/Narrator 结构化快照、历史黄金 10/10 成对 UAT、机器发布决策和 UAT 证据均已归档。正式 `8787` 仍保持 legacy，生产激活等待发布审批。

## 7. 继续验收增量（2026-08-31）

| 用例 | 结果 | 证据 |
|---|---|---|
| 自动化最终回归 | 通过，`328/328` | `npm test` |
| LLM 连通性 v2 | 通过；唯一运行目录落盘，目录锁不再阻断结果 | `uat-llm-connectivity-evidence/` |
| 8787 legacy 真实 LLM | 通过；健康、平台兼容、数据洞察 `completed` | `uat-platform-compatibility-2026-08-31-final/`、`uat-followup-platform-2026-08-31-final/` |
| 8790 shadow 真实 LLM | 通过；智能问数 `comparisonPassed=true`，数据洞察生命周期有效 | `uat-platform-compatibility-2026-08-31-final-shadow/`、`uat-followup-platform-2026-08-31-final-shadow/` |
| 复杂多维多轮页面 | 通过；五维、三指标、同比澄清、728 行/8 页、华东/月度追问 | `uat-platform-smart-query-complex-desktop-2026-08-31.png`、`uat-platform-smart-query-complex-mobile-390x844-2026-08-31.png`、`uat-platform-smart-query-followup-mobile-390x844-2026-08-31.png` |

`PLATFORM-UAT-007` 已关闭（测试证据目录写入问题）；阶段 7 门禁已关闭。候选业务执行器复用模块算法是平台与模块职责分离的既定设计，不是本目标的未完成项；若未来替换算法，另立专项。详见 `PLATFORM_BUSINESS_ORCHESTRATION_COMPARISON_REPORT_2026-08-31.md`。

## 8. Shadow 可复现性修复验收（2026-08-31）

| 用例 | 结果 | 证据 |
|---|---|---|
| 平台迁移运行时顺序执行回归 | 通过，7/7 | `platform-migration-runtime.test.mjs` |
| 8790 shadow 智能问数兼容双跑 | 通过，`comparisonPassed=true`，无阻断差异 | `uat-platform-compatibility-2026-08-31-final-shadow6/latest.json` |
| 8790 shadow 数据洞察真实 LLM | 通过，`completed`，生命周期 `valid=true`，业务结果比较 `passed=true`、差异 0 | `uat-followup-platform-2026-08-31-final-shadow6/latest.json`、对应 diagnostics |
| 全量回归与平台静态检查 | 通过，`331/331`；check 通过 | `npm test`、`npm run check:platform-compatibility` |

本次修复没有改变用户可见页面，因此沿用前一批 PC/Mobile 真实截图作为 UI 回归基线；新增验收重点为 shadow 日志、Gateway 缓存命中和结构化业务结果差异。该修复关闭“并发 shadow 造成随机 LLM 漂移”的平台缺陷，不放宽核心差异门禁。

## 9. 历史黄金基线成对 UAT（2026-08-31）

| 范围 | 结果 | 证据 |
|---|---|---|
| `DI-GOLD-001` 至 `DI-GOLD-010` | 10/10 通过；每个用例均生成真实 LLM 洞察，业务比较差异 0，生命周期有效 | `uat-platform-golden-2026-08-31/latest.json` |
| 业务结果快照 | Planner/Critic/Narrator、Evidence、终态均纳入 shadow 结构化门禁 | 每个用例 diagnostics 的 `platform.migration.orchestration` |
| 视觉回归基线 | PC/Mobile 结果截图继续通过 | `test/uat-artifacts/data-insight-reliability-2026-08-30/pc-complete-insight.png`、`pc-selected-input.png` |

该运行器覆盖成功双跑和结构化兼容；LLM 超时、限流、Provider 失败、Evidence 超预算等负向路径继续由自动化专项执行，不能因黄金成功 UAT 通过而省略。
