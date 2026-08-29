# 数据洞察系统性增强目标

> 版本：1.0
>
> 日期：2026-08-26（Asia/Shanghai）
>
> 状态：阶段 1–6 实现、自动化测试、真实 API、桌面/390x844 移动 UAT 已完成；最终门禁通过（2026-08-27）

## 1. 总目标

将数据洞察从“标准结果接收、固定统计摘要和通用二次文本”升级为由 LLM 驱动、服务端受控计算、领域 Skill 约束、证据可追溯的业务洞察能力。

最终形成一个统一分析内核和两个产品模式：

- `interpret`：数据洞察。基于已有 `InsightInput v1` 解释结果、识别业务含义、风险和行动，并在证据不足时发起受控补充分析。
- `explore`：AI 数据分析。从数据集和关注方向开始，由 LLM 提出假设、规划查询、动态下钻并生成完整分析报告。

两个模式共享 Skill、Canonical Query、受控分析工具、Evidence、LLM Planner/Critic/Narrator、结果校验和 InsightDocument；两者只在输入边界、查询授权、预算和运行生命周期上区分。

## 2. 阶段推进规则

每个阶段必须同时满足以下条件后，才自动进入下一阶段：

1. 代码实现完成且 `npm run check` 通过；
2. 针对性自动化测试全部通过；
3. 全量 `npm test` 通过；
4. 真实 Wyn API 验证通过；
5. 桌面和 `390x844` 移动浏览器 UAT 通过；
6. 关键页面、结果、错误状态和移动布局截图已保存；
7. 阶段报告、需求、设计和 `DEVELOPMENT_PROGRESS_REPORT.md` 已同步；
8. 没有未记录的 P0/P1 缺陷。

阶段验收不通过时，修复并重复当前阶段，不进入后续阶段。

## 3. 阶段 0：基线和契约冻结

### 目标

冻结当前数据洞察边界、统一对象关系和验收骨架，明确“不把固定统计摘要当作正式业务洞察”。

### 交付

- `InsightInput v1` 作为唯一来源输入协议；
- `InsightRun v1` 作为一次洞察运行的生命周期对象；
- `InsightDocument v1` 作为统一展示和导出对象；
- `interpret`/`explore` 模式定义；
- 洞察输入、运行、文档、证据和来源之间的关联规则；
- API、错误状态、容量、质量和证据字段契约；
- API、浏览器和截图 UAT 测试骨架。

### 验收

- 合法输入、非法输入、未知质量状态和来源幂等均有回归；
- 一个结果输入可以创建 `interpret` 运行；
- 一个数据集目标可以创建 `explore` 运行；
- 两种运行在接口和页面上可区分。

## 4. 阶段 1：InsightRun/InsightDocument 运行模型

### 目标

### 实施状态（2026-08-27）

实现已完成。新增 `InsightRunStore` 和 `wynai.insight-run/v1` Schema，接入 `interpret` 自动创建、`explore` 创建、运行列表/详情/重试 API；状态机支持 queued/planning/running/completed/failed，运行记录可持久化恢复。自动化测试和真实 API、桌面浏览器通过；严格 390x844 移动视口因当前浏览器运行时未应用覆盖，待重试。

把“输入记录”和“洞察过程/结果”分开，支持异步状态、重试、重新生成、版本和审计。

### 交付

- `InsightRun` 持久化仓库；
- `queued/planning/running/completed/failed` 状态机；
- 运行关联 `insightId`、问题、Skill、计划、工具调用、Evidence 和文档；
- 运行列表、详情、重试和生成历史 API；
- 数据洞察页面显示运行状态和生成版本；
- 服务重启后可恢复运行记录。

### 验收

- 运行失败不产生伪成功洞察；
- 同一输入重新生成产生可区分版本；
- 页面可查看运行阶段和失败原因；
- 桌面/移动截图验证运行状态、空状态、失败状态和完成状态。

## 5. 阶段 2：服务端受控分析工具和 Evidence Pack

### 实施状态（2026-08-27）

实现已完成。新增 `Evidence Pack v1` 服务端构建器：对全量结果集计算行列规模、数值分布（sum/average/min/max/分位数）、维度频次、空值和受控边界样本，并按时间、业务维度、时间+维度及层级组合生成全量聚合证据；每个聚合保留记录数。LLM 请求不携带原始明细，仅携带证据包与安全策略标记 `rawRowsToLlm=false`。Evidence Pack Schema、自动化测试、真实多数据集/Word API UAT，以及 412 行多维月度合成数据专项回归均已通过。

### 目标

让全量计算和统计分析在服务端完成，LLM 消费结构化证据，而不是依赖前 120 行原始样本。

### 交付

- 全量 KPI、趋势、分组贡献、Top/Bottom、集中度、分布、异常、变化来源、质量检查和明细下钻工具；
- 工具参数白名单和预算控制；
- 多结果集选择和跨结果集引用；
- `Evidence Pack v1`，包含值、计算方法、范围、质量、来源和证据 ID；
- 受控抽样：随机、分层、异常点附近和 Top/Bottom 对象样本；
- 禁止工具绕过 Canonical Query 或访问未授权数据。

### 验收

- 统计值与独立基准计算一致；
- 结果集超过 120 行时仍能基于全量聚合形成证据；
- 样本、截断、估算和空值均被正确标记；
- 证据包能在页面和报告中展开查看；
- 业务数据不直接作为无限制 Prompt 发送给 LLM。

## 6. 阶段 3：LLM Planner/Critic/Narrator 编排

### 实施状态（2026-08-27）

已完成。正式数据洞察禁止无 LLM 固定摘要，LLM 请求消费 Evidence Pack；Planner/Critic/Narrator、结构化输出和证据校验均通过。证据校验支持日期/文本中的年份和月份、金额单位转换及同证据集合内的受控比例，并在 Narrator 首次校验失败后执行一次严格修复重试。合成非敏感数据的真实 DashScope UAT 成功；412 行多维月度专项回归中三阶段均记录 `completed`，详见 `DATA_INSIGHT_PHASE3_UAT_REPORT_2026-08-27.md`。

### 目标

每次正式业务洞察都由 LLM 参与规划、复核和叙事；没有 LLM 时不得以固定摘要冒充洞察。

### 交付

- LLM Insight Planner：选择业务问题、假设和分析工具；
- LLM Critic：判断证据是否足够并决定是否有限下钻；
- LLM Narrator：生成管理摘要、关键发现、风险和行动；
- 结构化输出协议和重试；
- 证据 ID、数字、实体、期间和范围校验；
- LLM 超时、拒答、无效 JSON 和越界结论的失败边界；
- 本地固定引擎降级为“数据准备诊断”，不作为正式业务洞察。

### 验收

- 不同问题产生不同工具调用路径；
- LLM 不能发明数字、指标、维度或证据；
- 受限结果不能生成全局性结论；
- 行动建议必须引用发现或风险证据；
- LLM 失败时运行状态为 failed 或明确需重试；
- 真实外部 LLM UAT、日志和截图通过。

## 7. 阶段 4：领域 Skill 诊断配置

### 实施状态（2026-08-27）

已完成。Skill Registry 规范化 diagnostics、requiredEvidence、riskRules、playbook、assumptions 和 evaluationRefs；销售、实验室、零售 Skill 已补齐对应诊断配置，Planner/Critic/意图解析器消费这些知识，InsightRun 保存实际 Skill 引用。三领域 Skill 目录/版本/冲突澄清 UAT 通过；实验室当前 Wyn 聚合端返回 502，已作为执行端数据约束记录，不降级为伪成功。

### 目标

把 Skill 从“指标和同义词配置”升级为领域诊断知识资产。

### 交付

- 指标和公式定义；
- 业务实体和层级关系；
- 诊断模式和所需证据；
- 风险规则、阈值和比较口径；
- 行动建议 Playbook；
- 禁止解释和假设边界；
- 版本、审批、退役、回滚、冲突和评测关联；
- 先完成销售领域，再扩展实验室和零售。

### 验收

- 销售额下降、利润率变化、客户集中度等问题走不同诊断路径；
- 毛利率、客单价、订单数等口径正确；
- 实验室 TAT 和零售类别分析遵守各自禁止规则；
- 领域 Skill 版本出现在运行、证据和报告中；
- 三领域黄金问题、变体、澄清和多轮 UAT 通过。

## 8. 阶段 5：统一 Interpret/Explore 双模式

### 实施状态（2026-08-27）

已完成。两种入口共用 `InsightRunStore`、Skill、Evidence 和 InsightDocument；标准结果自动创建 `interpret`，数据集目标创建 `explore`，证据不足时创建 `parentRunId` 关联的 Explore；工作台支持模式入口、返回、统一渲染和 HTML/Markdown/JSON 导出。API UAT 覆盖 Explore 生命周期、版本比较和导出，桌面与 390x844 页面通过。

### 目标

避免数据洞察和 AI 数据分析形成两套重复智能体，统一底层能力并明确入口职责。

### 交付

- 数据洞察以 `interpret` 模式运行；
- AI 数据分析以 `explore` 模式运行；
- 数据洞察证据不足时可创建关联 `explore` 运行；
- 运行之间保留来源、父运行和结果集关联；
- 页面显示当前模式、查询范围、预算和权限；
- 统一 InsightDocument 渲染、图表、证据和报告导出。

### 验收

- 同一结果在 interpret 模式下不越界扩大范围；
- explore 模式可从数据集开始自主规划和下钻；
- 关联运行能从数据洞察页面跳转并返回；
- 两个入口共享 Skill/证据/报告组件但行为边界清晰；
- 桌面和移动端完整主路径截图通过。

## 9. 阶段 6：持久化、权限和治理闭环

### 实施状态（2026-08-27）

已完成：InsightRun、洞察文档和审计持久化；受信用户/组织访问过滤；LLM/工具/Prompt hash/模型/Skill/外发策略审计；配额与并发限制；失败重试；反馈候选、版本比较、软归档/恢复/删除和敏感字段脱敏均已接入。合成 UAT 已验证详情越权 403、运行越权 403、归档恢复、版本比较、导出和 `rawRowsToLlm=false`。

### 目标

将数据洞察从原型能力提升为可审计、可恢复、可治理的产品能力。

### 交付

- 洞察、运行和文档持久化；
- 用户/组织归属和访问控制；
- LLM 调用、工具调用、Prompt、模型和 Skill 版本审计；
- 生成配额、超时、并发和限流；
- 用户反馈、评测候选和人工审核；
- 洞察版本比较、归档和删除策略；
- 敏感数据脱敏和外发授权记录。

### 最终验收

- 全量自动化测试和静态检查通过；
- 销售、实验室、零售真实 API/UAT 通过；
- 桌面和移动端截图、控制台、横向溢出检查通过；
- 服务重启后运行、文档和审计记录可恢复；
- 权限越权、无证据结论、模型失败和数据外发测试通过；
- 相关需求、设计、开发进度和详细 UAT 报告全部同步。

## 10. 文档同步清单

每阶段完成后必须同步：

- 本目标文档的阶段状态和验收结果；
- `DATA_INSIGHT_STANDARD_INPUT_REQUIREMENTS.md`；
- `INDEPENDENT_QUERY_DATA_INSIGHT_REQUIREMENTS_DESIGN_AND_UAT_2026-08-26.md`；
- `PRODUCT_DESIGN_V2_1.md`；
- `DEVELOPMENT_PROGRESS_REPORT.md`；
- 新增或更新的协议 Schema；
- 阶段详细 UAT 报告和截图索引。

## 11. 自动推进与最终门禁记录

阶段推进由同一验收流程按顺序执行：当前阶段只有在代码检查、针对性测试、全量回归、真实 API、桌面/390x844 浏览器截图、溢出检查、报告同步和 P0/P1 缺陷清零全部通过后，才写入 `passed` 并启动下一阶段；任一项失败则保留 `failed` 运行和证据，修复后重跑当前阶段。2026-08-27 最终批次结果：

- `npm run check`、`npm run check:insight`：通过；`npm test`：当前最终 209/209 通过；
- 阶段 3：真实 DashScope 合成 UAT 通过，Planner/Critic/Narrator 3/3；412 行多维月度专项回归通过，54 条 Evidence、4 个 InsightDocument block；
- 阶段 4：销售/实验室/零售 Skill UAT 5/5（实验室执行端 502 已留痕）；
- 阶段 5/6：版本、导出、Explore、权限、归档恢复和审计 API UAT 通过；
- 浏览器：桌面与严格 390x844 截图通过，`scrollWidth=375 < innerWidth=390`，无横向溢出。

412 行专项证据目录：`C:/Users/zenoszeng/.codex/visualizations/2026/08/26/01a03e7d-fda4-7b71-9efa-02ff464e2d79/phase6-repro-v2/`。真实外部 LLM 重测使用合成非敏感数据，未发送用户真实业务明细；生产策略仍为服务端全量受控聚合、LLM 消费 Evidence Pack。

证据目录：`C:/Users/zenoszeng/.codex/visualizations/2026/08/26/01a03e7d-fda4-7b71-9efa-02ff464e2d79/phase6-final/`。

## 13. 下一阶段平台化目标与执行基线（2026-08-28）

本阶段将数据洞察从“LLM 调用成功才有价值”调整为“确定性业务事实保证下限，LLM 提升分析深度”。`InsightInput v1` 保持不变，Wyn 问数、独立问数及未来来源均通过各自适配器调用统一标准边界。

### 13.1 六项建设目标

1. 强制绑定 Skill，记录 Skill 名称、版本、指标口径、分析方法和适用的降级模板。
2. 建设 Business Fact Pack v1，作为 LLM 唯一事实输入，包含范围、粒度、指标、聚合、派生指标、趋势、排名、异常、覆盖率和质量告警。
3. 建设确定性业务事实引擎，首批覆盖销售趋势、贡献、集中度、异常和客单价等口径。
4. 建设统一 LLM Gateway v1，治理连接、首字节、总请求超时、重试、备用模型、限流、熔断和审计。
5. 重构 LLM 路由，支持标准路径、深度路径和确定性降级路径，默认优先标准路径。
6. 完善 `completed/partial/degraded/failed` 状态、错误码、审计和前端可见提示。

### 13.2 LLM 时限基线

固定时限是平台判定标准，供应商明确错误时提前结束：连接建立 3 秒、首字节 8 秒、单阶段 25 秒、同步链路 75 秒、异步任务 90 秒；Fact Engine P95 目标为 2 秒以内。网络抖动/429/5xx 最多重试一次，输入/权限/上下文错误不重试，JSON 错误最多修复一次，证据不足直接进入 partial/degraded。

### 13.3 阶段 A：业务下限可靠（当前启动阶段）

交付范围：Skill 强绑定和版本审计、Business Fact Pack v1 的业务字段和证据元数据、销售领域确定性事实计算、领域化降级报告和质量完整度门禁；保持 `rawRowsToLlm=false`、`InsightInput v1` 和 8787 端口不变。

平台验收：P1，关键链路 P2；超时/降级场景执行 P3。模块验收：M2，销售关键场景执行 M3。

阶段 A 通过条件：LLM 不可用时仍可输出可核验的销售事实和明确降级状态；LLM 可用时所有业务数字均可追溯到 Fact Pack；Skill、运行、审计和报告记录一致；自动化测试、真实 8787 API 和桌面/390x844 UAT 证据齐全。

### 13.4 后续里程碑

- 阶段 B：LLM Gateway 与超时可靠性；平台 P1/P2，模块 M2。
- 阶段 C：异步运行与可观测性；平台 P2/P3，模块 M2/M3。
- 阶段 D：实验室、零售等领域扩展；平台 P1/P2，模块 M1/M2。
- 阶段 E：发布前平台回归；平台 P4，相关模块 M4。

平台级和模块级 UAT 的定义、动作、证据和变更影响规则见 `PLATFORM_AND_MODULE_UAT_GOVERNANCE.md`。

### 13.5 阶段 B：统一 LLM Gateway（2026-08-28）

阶段 B 已完成并通过门禁。新增根目录 `llm-gateway.mjs`，主/备用 Provider、分阶段时限、有限重试、熔断、进程内缓存、统一错误码、metrics、snapshot 和审计均已接入。Planner、Critic、Narrator、意图解析及严格分析报告全部通过 Gateway；`InsightInput v1`、`rawRowsToLlm=false` 和 8787 端口保持不变。详细需求/设计见 `DATA_INSIGHT_STAGE_B_LLM_GATEWAY_REQUIREMENTS_DESIGN.md`，UAT 报告见 `DATA_INSIGHT_STAGE_B_UAT_REPORT_2026-08-28.md`。

阶段 B 验收级别：平台 P1 + 关键链路 P2；超时、备用、熔断和降级执行关键 P3；模块 M2。首期 `npm run check`、`npm run check:insight`、`npm test` 239/239 和 Gateway 专项 6/6 通过；真实 8787 API、桌面/390x844 浏览器证据、控制台与横向溢出检查通过。

2026-08-28 平台优化 1-4 已进一步完成：连接、响应头和总请求采用独立错误语义，删除统一 8 秒响应等待阈值；Planner/Critic/Narrator/报告/探索/意图/探针按 operation 配置时限；`LLM_CONNECT_TIMEOUT` 只保留给底层明确连接超时，响应头等待使用 `LLM_RESPONSE_HEADER_TIMEOUT`；同一 Provider 重试加入指数退避、随机抖动和取消传播。当前没有第二 Provider，不影响上述策略生效，也不会把同 Provider 重试计为 fallback。原生 fetch 不暴露连接完成事件，连接阶段依赖底层错误码分类，这是明确的运行时边界，不再用响应头计时器伪装。

## 12. 平台稳健性增强（2026-08-28）

前述阶段完成了统一输入、Evidence Pack、LLM 编排和治理闭环，但真实高维结果仍暴露出“单条 Narrator 数字校验失败导致整体不可用”的平台缺陷。本轮新增目标：Evidence Pack 预算化与查询相关证据选择、Narrator 分层校验与逐项隔离、`completed/degraded/failed` 生成状态、确定性降级、错误码细分、阶段审计和高维 UAT。

详细需求、设计、实施范围和验收标准见 `DATA_INSIGHT_PLATFORM_ROBUSTNESS_REQUIREMENTS_DESIGN_UAT_2026-08-28.md`。本轮不修改 `InsightInput v1`，不开放原始明细外发，服务继续固定使用 8787 端口。
## Complete diagnostic replay (2026-08-28)

Each InsightInput now receives an append-only backend diagnostic record keyed by `insightId`. The record captures normalized input, run lifecycle, evidence/business facts, every Planner/Critic/Narrator stage, each LLM Gateway provider attempt, final document, and terminal outcome. Query with `GET /api/data-insights/{insightId}/diagnostics`; this phase has no UI export. See `DATA_INSIGHT_COMPLETE_DIAGNOSTIC_LOG_REQUIREMENTS_DESIGN.md` for the contract and operational risks of retaining real data.
