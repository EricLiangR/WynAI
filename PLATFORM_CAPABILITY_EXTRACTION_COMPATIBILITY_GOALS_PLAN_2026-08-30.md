# 平台公共能力抽取与模块兼容迁移目标计划

> 版本：1.0
> 日期：2026-08-30（Asia/Shanghai）
> 状态：平台目标已完成（阶段 0-7 门禁通过；正式 `8787` 保持 legacy，生产激活等待发布审批）
> 适用范围：数据洞察、智能问数及后续智能分析模块

## 1. 背景与目标

数据洞察已经验证了 LLM Gateway、上下文治理、Evidence Pack、Skill、运行生命周期和审计等能力。下一步将这些能力提升为系统平台能力，供数据洞察、智能问数和后续模块复用。

本计划不是替换数据洞察链路，也不是新增一条平行业务链路，而是采用“平台公共能力 + 模块适配器 + 兼容迁移”的方式完成能力上收。

总目标：

1. 建立统一的平台智能分析运行底座；
2. 保持数据洞察历史正确结果、业务口径、权限和失败语义兼容；
3. 让智能问数接入同一套平台治理能力；
4. 通过黄金基线、双跑、灰度和回滚控制公共能力重构风险；
5. 使每次代码、需求、设计和 UAT 证据能够同步追踪。

## 2. 非目标与边界

- 本计划不改变 `InsightInput v1`、`InsightDocument` 的业务含义；
- 不把数据洞察的 Planner/Critic/Narrator 编排强行统一为智能问数的流程；
- 不要求复制两套业务算法。候选业务编排边界、结构化快照和兼容门禁用于保护迁移；算法策略仍由模块拥有，未来算法替换另立专项。
- 不把所有模块统一为相同超时、预算或失败策略；
- 不允许通过压缩元数据、Skill、权限或核心证据换取性能；
- 不在没有双跑和回滚能力时直接切换生产链路。

## 3. 目标架构

```text
平台智能分析底座
├─ LLM Gateway Manager
├─ Context Governance
├─ Evidence Compiler
├─ Skill Registry / SkillPlan
├─ Run Lifecycle
├─ Audit / Trace
├─ Health / Timeout Governance
└─ Compatibility Contract
        ↓
Data Insight Adapter
Smart Query Adapter
Future Module Adapters
```

平台层统一 Provider、协议、错误码、审计、健康和可靠性治理；模块适配器保留输入边界、业务编排、结果结构、展示规划和部分完成规则。

## 4. 上下文与证据保护规则

### 4.1 必须无损传递

- 原始用户问题和当前有效多轮上下文；
- confirmed、corrected、removed、pending 约束；
- 数据集 ID、版本、字段类型、角色、语义、层级、同义词和业务描述；
- Skill 名称、版本、作用域、依赖、指标定义和禁止事项；
- 派生指标公式、分子、分母和聚合顺序；
- 权限、租户和实际数据范围；
- `InsightInput`、Canonical Query、Evidence ID 和来源。

### 4.2 允许压缩但必须可追溯

- 无关历史消息；
- 重复证据明细；
- 已结构化表达的结果；
- 大结果的展示性摘要。

上下文预算不足时不得静默截断核心语义，应进入澄清或失败状态。Evidence Pack 不得默认使用 Top-N、头尾采样或无声明丢弃。

## 5. 分阶段实施计划

### 阶段 0：基线冻结与影响评估

状态：已完成（自动化基线，真实双跑待阶段 4）

交付：平台能力清单、数据洞察黄金用例集、旧链路输入/输出快照、兼容性风险矩阵、允许差异清单。

验收：平台 P0/P1，数据洞察 M1。已完成普通、高基数、稀疏、超时、部分完成、权限和移动端场景的基线盘点；`npm run check` 通过，`npm test` 为 293/293。真实新旧双跑和截图对比安排在阶段 4/6。详见 `PLATFORM_MIGRATION_BASELINE_INVENTORY_2026-08-31.md`。

### 阶段 1：公共契约版本化

状态：已完成（契约与校验门禁）

交付：Gateway、Context Manifest、Evidence、Skill、Run Lifecycle、错误码和状态枚举的版本化契约；旧输入可通过适配器转换。

验收：平台 P1/P2，数据洞察 M2。已新增版本化兼容校验器、数据洞察/智能问数契约清单和 5 个专项测试；`npm run check:platform-compatibility` 通过，`npm test` 为 298/298。真实适配器转换和双跑安排在阶段 4/5。

### 阶段 2：Gateway Manager 与统一治理

状态：已完成（治理门面与聚合健康）

交付：统一 Gateway Manager；公共 Provider、重试、熔断、缓存、诊断和审计；真正的绝对总截止时间；聚合 exploration/intent 健康状态。

验收：平台 P1/P2/P3，数据洞察 M2/M3。已新增并接入 `PlatformGatewayManager`，保留 exploration/intent 独立预算和失败语义；增加绝对总预算包装、平台事件标记、聚合快照和健康接口；专项及全量回归 `301/301` 通过。真实 Provider 异常和浏览器 UAT留待阶段 6。

### 阶段 3：上下文、Evidence 和 Skill 平台化

状态：已完成（上下文 Manifest 与 Evidence 传输校验首版）

交付：Context Governance、Evidence Compiler、可追溯分块、Skill Registry、版本/作用域/冲突治理；现有数据洞察 Skill 通过适配器接入。

验收：平台 P2，数据洞察 M3。已新增平台 Context Manifest 与 Evidence 传输校验，并接入数据洞察生成前诊断；原始明细外发、完整标记矛盾和显式限制均有专项测试；全量回归 `304/304`。Skill Registry 的跨模块适配和双跑留待阶段 5。

### 阶段 4：数据洞察兼容适配与双跑

状态：已完成首轮真实验收（适配器、比较器、候选业务编排和真实 LLM shadow 双跑均通过；宽泛提示词严格证据拒绝路径保留为负向证据）

交付：`DataInsightAdapter`、旧结果格式转换、新旧链路影子运行、结构化差异报告和阻断规则。当前已完成适配器、通用双跑比较器和 `platform-migration-runtime`；`platform-business-orchestrators.mjs` 为数据洞察候选路径提供独立编排门面、上下文完整性审计和候选版本标识，标准数据洞察输入已接入运行时并记录 `platform.migration.run`。真实 LLM shadow 双跑已完成并通过。

验收：平台 P2，数据洞察 M3/M4。真实 shadow 跟进生成通过，Planner/Critic/Narrator 全部 completed，Evidence 覆盖完整；宽泛业务提示词因证据不足返回 `INSIGHT_CLAIM_VALIDATION_FAILED`，未生成伪成功正文。

### 阶段 5：智能问数适配与跨模块隔离

状态：已完成首轮真实验收（适配器、候选交互编排、跨模块并发和多轮澄清回归通过）

交付：`SmartQueryAdapter`；复用平台 Gateway、Context、Skill、审计；保留多轮澄清、Canonical Query 和展示规划；验证两个模块并发和故障隔离。当前已完成适配器、请求入口校验、候选智能问数交互编排边界和迁移运行时共用机制，候选路径保留多轮上下文/Skill/权限审计；跨模块并发、真实双跑和用户流程验收均已通过。

验收：平台 P2/P3，智能问数 M2/M3，数据洞察 M3 回归。真实 LLM 下智能问数 shadow 比较通过；公式指标与泛化同比并存的澄清选择可完成查询，不再重复澄清。

### 阶段 6：灰度、监控和回滚

状态：已完成首轮验收（观测、请求级灰度、shadow/canary/platform 隔离和正式 legacy 回滚均通过）

交付：`legacy/shadow/canary/platform` 模式；按模块、组织、用户和比例进行确定性请求级灰度；路由决策写入 trace/运行事件；候选异常可回退 legacy；通过重启 `PLATFORM_MIGRATION_MODE=legacy` 完成显式回滚；差异和质量指标监控。

验收：平台 P3。8787 回滚到 legacy 后平台兼容、跨组织并发、真实 LLM 跟进生成均通过；日志可按 `runId`/`insightId`/`traceId` 复盘。动态运行时切换仍为已知限制。

### 阶段 7：正式发布与持续治理

状态：已完成（发布门禁通过；正式激活等待审批）

交付：平台 P4、数据洞察 M4、智能问数 M4 报告；黄金用例集持续扩展；UAT 验收官审核变更影响和发布门禁。

验收：P0/P1 缺陷关闭，关键场景 100% 通过，PC/Mobile 截图、API、trace、审计和缺陷闭环完整；黄金报告机器门禁通过，canary 晋级决策可复算。

## 6. 新旧链路对比门禁

### 阻断差异

- 核心数值、公式、过滤条件或权限范围变化；
- 核心维度/指标遗漏；
- Evidence ID 或结论证据关系丢失；
- `completed` 变为失败，或失败伪装成成功；
- Skill、时间语义或派生指标口径变化；
- 页面核心答案不可见；
- LLM 失败原因不可定位。

### 可接受差异

- Prompt 内部排版；
- 非关键自然语言措辞；
- trace ID；
- 已通过性能基线验证的耗时改善。

## 7. UAT 与证据要求

每个公共能力变更必须同时执行平台级和模块级验收：

1. 平台 P1/P2，涉及超时、权限、降级或恢复时增加 P3；
2. 数据洞察至少 M2，核心业务场景 M3，正式发布 M4；
3. 保存旧链路、新链路、结构化差异、trace、审计和日志；
4. 涉及用户体验时保存 PC 和 `390x844` 移动端截图；
5. 失败、超时、部分完成和恢复路径必须有截图和机器可读结果；
6. 缺陷修复后必须重跑原用例，不得只补充新用例。

## 8. 代码与文档同步规则

每个阶段完成时必须同步更新：

- 本计划的状态、实际变更和剩余风险；
- 对应需求文档和设计文档的版本、契约和边界；
- `PLATFORM_AND_MODULE_UAT_GOVERNANCE.md` 的验收级别或证据要求；
- 阶段 UAT 报告、测试用例集和 `DEVELOPMENT_PROGRESS_REPORT.md`；
- 代码中的契约版本、适配器版本和 Feature Flag 默认值。

## 9. 当前进度

| 阶段 | 状态 | 代码 | 自动化测试 | UAT | 文档 |
|---|---|---|---|---|---|
| 0 | 已完成（自动化基线） | 已完成 | 293/293 | 双跑待阶段 4 | 基线记录已建立 |
| 1 | 已完成（契约与校验门禁） | 已完成 | 298/298 | 适配器双跑待阶段 4/5 | 契约清单已建立 |
| 2 | 已完成（治理门面与聚合健康） | 已完成 | 301/301 | 真实 Provider/浏览器待阶段 6 | 设计已同步 |
| 3 | 已完成（Context/Evidence 首版） | 已完成 | 304/304 | 真实高基数双跑待阶段 4/5 | 设计已同步 |
| 4 | 已完成首轮真实验收（适配器、比较器与候选编排） | 候选编排专项 3/3；全量回归 326/326 | 真实 LLM shadow 跟进生成通过；证据不足负向路径按设计阻断 | 真实成功与失败证据已归档 |
| 5 | 已完成首轮真实验收（适配器、候选交互编排与隔离） | 澄清回归、跨模块并发；全量回归 326/326 | 真实 shadow 智能问数比较通过；多轮派生澄清缺陷已修复 | PC/Mobile 成功页面截图已归档 |
| 6 | 已完成首轮验收（观测/请求级灰度/回滚） | 请求级灰度、并发、回滚专项通过 | legacy、shadow、canary、platform、allow-list/比例灰度和正式 rollback 均有证据；运行时动态切换仍不支持 | 回滚证据已归档 |
| 7 | 已完成（发布门禁通过，激活待审批） | 候选业务编排边界、黄金报告机器门禁和持续治理已接入 | 331/331 回归通过；黄金 10/10 | legacy/shadow 真实 UAT、复杂多轮 PC/Mobile、黄金成对 UAT 已通过 | 无平台阻断缺陷；生产激活由发布审批决定 |

## 10. 发布前置条件

- 黄金用例全部完成并可自动重跑；
- 平台与数据洞察差异门禁通过；
- 真实 LLM 成功、失败和超时路径均有证据；
- 权限、审计、日志和回滚验证通过；
- 无未记录的 P0/P1 缺陷；
- 用户可见结果、PC/Mobile 布局和错误提示通过 UAT。

## 11. 本轮增量验收（2026-08-31）

- 请求级灰度路由已实现：按模块、组织、用户 allow-list 和稳定哈希比例分流；trace/运行事件保留路由理由，未命中主体回到 legacy。
- 跨模块并发隔离已验证：两个组织并发提交数据洞察标准输入和智能问数请求，insightId、conversationId、组织过滤和主体审计均保持独立。
- 自动化全量回归：`324/324`；平台兼容静态检查通过。
- 真实 API：8787 legacy 基线、8790 shadow、8792 canary 和请求级灰度 UAT 均通过；证据见 `uat-platform-compatibility-2026-08-31-legacy-final/`、`uat-platform-compatibility-2026-08-31-shadow-rerun4/`、`uat-platform-compatibility-2026-08-31-canary-rerun/`、`uat-platform-migration-routing-2026-08-31/`、`uat-platform-concurrency-2026-08-31-rerun2/`。
- 历史门禁已关闭：允许出站的服务上下文已验证 DashScope 443 可达，8787 legacy 与 8790 shadow 的真实 LLM 成功、正文截图、结构化比较和正式阶段 7 发布门禁均已通过；8787 当前按发布策略保持 legacy，生产激活仍需独立审批。

## 12. 真实 LLM 与回滚验收增量（2026-08-31）

- 在允许出站的服务上下文验证 DashScope 443 返回远端 `401`（无效密钥），随后 8787/8790 服务真实探针均为 `healthy`；原 `EACCES` 已确认为服务进程网络权限问题，而非调用协议问题。
- 8790 `shadow` 真实兼容 UAT 通过：`comparisonPassed=true`、候选 profile 为 `smart-query-platform-candidate-v1`；真实数据洞察跟进生成 `completed`，provider 为 `llm-orchestrated`，正文和文档均存在，生命周期 `valid=true`。
- 8787 正式 rollback 重启为 `legacy` 后，平台兼容、跨模块并发和真实数据洞察跟进生成均通过；回滚不影响权限/组织隔离或用户结果。
- 浏览器成功页面已保存：`uat-platform-smart-query-desktop-2026-08-31.png`、`uat-platform-smart-query-mobile-390x844-2026-08-31.png`。
- 修复澄清状态机缺陷：公式指标与泛化同比并存时，选择同比对象会清除旧未决槽位；澄清期间完整新问题会清空旧语义上下文。全量回归现为 `326/326`。
- 阶段 7 门禁已关闭：真实 Planner/Critic/Narrator 结构化结果快照、黄金 10/10 成对 UAT、机器发布决策和 UAT 证据均已归档；业务算法复制不是本平台目标。UAT 连通性脚本证据路径已改为唯一运行目录并通过 v2 探针复验。

## 13. 继续推进记录（2026-08-31）

- `npm test` 最终回归：`326/326`；`npm run check` 与 `npm run check:platform-compatibility` 均通过。
- 8787 legacy 真实 LLM 健康、平台兼容和数据洞察生成均通过；8790 shadow 真实智能问数比较和数据洞察生成均通过。
- 复杂多维多指标智能问数完成 PC/Mobile 截图及连续追问验收：728 行、8 页，确认同比对象后完成，华东/月度追问保持上下文。
- 新增 `PLATFORM_BUSINESS_ORCHESTRATION_COMPARISON_REPORT_2026-08-31.md`，明确治理兼容通过与独立业务算法双实现的边界；本目标不要求复制业务算法，未来替换算法需另立专项。

## 14. Shadow 可复现性修复（2026-08-31）

### 目标

消除 shadow 双跑因并发 LLM 生成造成的随机叙述漂移和重复出站调用，保证兼容门禁只反映真实平台或业务算法差异。

### 实施

- `platform-migration-runtime.mjs` 的 shadow 模式改为 legacy 完成后再执行 candidate；候选失败仍只记录 `candidate-failed`，不影响 legacy 用户结果。
- 相同请求继续使用 Gateway 短 TTL 进程内缓存；当候选提示、模型或算法变化导致缓存键变化时，完整 Planner/Critic/Narrator、Evidence 和答案快照比较仍然生效。
- 新增顺序执行回归测试，保留核心差异阻断测试和候选失败隔离测试。

### 验收

- `node --test platform-migration-runtime.test.mjs`：7/7 通过。
- `npm run check:platform-compatibility`：通过。
- `npm test`：329/329 通过。
- 8790 shadow 真实兼容 UAT：智能问数 `comparisonPassed=true`；数据洞察 `platform.migration.orchestration.comparison.passed=true`、差异 0、LLM 生成 `completed`、生命周期有效。证据：`uat-platform-compatibility-2026-08-31-final-shadow6/`、`uat-followup-platform-2026-08-31-final-shadow6/`。

### 状态

本次缺陷关闭。平台阶段 7 发布门禁已通过；正式 `8787` 继续保持 legacy，生产激活需要独立的发布审批。业务算法双实现不属于本平台目标，若未来替换算法需新建专项并复用本套差异门禁。

## 15. 历史黄金基线成对 UAT（2026-08-31）

- 新增 `uat-platform-golden-live.mjs` 和 `npm run uat:platform-golden`，逐用例提交标准 `InsightInput v1`，在 shadow 模式下读取 legacy/candidate 结果、业务结果快照、迁移比较和生命周期诊断。
- 首批 10 个 `DI-GOLD-001` 至 `DI-GOLD-010` 全部通过：生成状态为 `completed`/`completed-partial`，LLM provider 为 `llm-orchestrated`，业务比较差异数为 0，生命周期无开放运行和孤立终态。
- 机器证据：`uat-platform-golden-2026-08-31/latest.json`。PC/Mobile 视觉基线继续引用 `test/uat-artifacts/data-insight-reliability-2026-08-30/` 截图；失败、超时和超预算由 Gateway/Evidence 专项负向测试覆盖。

本项关闭“历史黄金用例只有静态清单、没有逐用例 shadow 证据”的质量缺口。阶段 7 的平台发布门禁已通过；候选业务边界和结构化快照已满足本目标，业务算法复制另列未来专项。

同时新增 `evaluateGoldenBaselineReport()` 发布门禁：阶段 7/后续灰度不得以手工 `goldenBaseline=true` 绕过报告校验，必须逐用例满足零阻断差异、有效生命周期和真实 LLM 生成条件。
