# 独立问数风险分级、反馈学习与跨行业治理需求设计

> 版本：1.0
>
> 日期：2026-08-25（Asia/Shanghai）
>
> 状态：已完成（实验室/零售评测包业务审批和双账号权限验证作为后续依赖保留）
>
> 适用范围：左侧“独立问数”入口、会话规划、Skill、日志、反馈学习和 UAT 体系

## 1. 背景与目标

独立问数已经具备版本化业务意图、受控 Canonical 查询、多轮上下文、结果校验和组合可视化。现有确定性快路径在销售数据集上性能稳定，但跨行业准确性不能只依赖已编码销售规则，也不能把所有请求无差别交给大模型。

本版本以“风险分级路由 + 受控反馈学习 + 跨行业治理”为核心。系统在用户正常使用中收集可审核的纠正与评测资产，但任何用户反馈都不得直接修改生产 Skill、指标口径、查询编译器或模型策略。

## 2. 七项需求

| 编号 | 能力 | 核心需求 | 验收结果 |
| --- | --- | --- | --- |
| R1 | 统一风险模型 | 根据 Skill 覆盖、未决约束、派生指标、多个指标/维度、开放推理、高影响领域和槽位置信度输出版本化风险评估 | 每轮响应与日志可见 level、score、reasons、policy |
| R2 | 风险分级 LLM 路由 | 低风险完整意图可跳过 LLM；中风险优先 LLM；高风险必须 LLM 与确定性规则联合校验 | 自动化覆盖三类路由与故障策略 |
| R3 | 双重校验与失败边界 | LLM 只生成 BusinessQueryIntent；字段白名单、约束覆盖、编译和结果校验由程序执行；高风险失败必须澄清或拒绝 | 不允许 LLM 返回 SQL/WAX/Payload；高风险不得静默降级执行 |
| R4 | 全链路可观测与回放 | 用同一 traceId 串联请求、会话轮次、Skill、风险、Planner、查询、结果验证、回答和反馈 | 按 sequence 可完整回放；敏感键脱敏；日志持久化 |
| R5 | 受控反馈学习闭环 | 普通用户可反馈正确、数据错误、理解错误、口径错误和展示错误；系统形成候选评测或候选 Skill 规则 | 候选初始为 pending_review；未经审批不影响生产 |
| R6 | 跨行业 Skill 治理 | 多 Skill、多版本、system/dataset/organization/user 作用域；草稿、审批、退役、回滚和冲突管理 | 仅 approved Skill 参与生产解析；销售、实验室、零售分别建 Skill |
| R7 | 跨行业评测体系 | 每个领域使用版本化评测包，覆盖黄金问题、口语变体、风险、标准意图、澄清和多轮 | 评测运行输出逐槽位差异；变更前必须回归 |

## 3. 风险分级与路由

### 3.1 风险输入

风险评估不得只依赖问题长度或固定行业关键词，至少综合：

- 是否命中已审批领域 Skill；
- 是否存在必需但未解析的指标、维度、时间、筛选或结果形状；
- 是否存在 Skill 口径冲突；
- 是否包含同比、环比、增长率、占比等派生计算；
- 是否包含多个指标、多个维度或复杂排名；
- 是否要求原因、归因、异常诊断、预测或建议；
- 是否涉及财务、审计、税务、医疗、法律、授信等高影响场景；
- BusinessQueryIntent 槽位置信度；
- 当前确定性计划是否可执行。

### 3.2 路由策略

| 风险 | LLM 策略 | 执行策略 | LLM 故障 |
| --- | --- | --- | --- |
| low | 可跳过 | 完整意图通过约束覆盖后执行 | 使用已验证确定性结果 |
| medium | 可用时必须调用 | LLM 输出与确定性约束、编译结果一致后执行 | 只允许回退到完整且已验证的确定性意图，并标记 warning |
| high | 必须调用 | LLM、Skill、字段白名单、覆盖校验和结果校验全部通过后执行 | 澄清或安全拒绝，不执行查询 |

中风险派生指标包括同比、环比、增长率、占比、贡献率、转化率和达成率。原“过去五年销售收入和同比增长率直接跳过 LLM”的性能规则由本版本替代：准确性优先时，该问题进入中风险 LLM 复核；只有 LLM 故障且确定性意图完整通过覆盖校验时才受控回退。

## 4. 日志与回放

### 4.1 事件协议

协议：wynai.operation-event/v1。

必需字段：traceId、sequence、at、event、phase、outcome、durationMs、conversationId、turnId、datasetId、actor、organizationId、userId、versions、details。

标准事件顺序：

1. request.accepted
2. turn.received
3. skill.resolved
4. planning.completed（含 riskAssessment、Planner 路径、LLM 耗时）
5. query.executed（含 Canonical 请求、结果集和行数）
6. result.validated
7. response.composed
8. turn.completed
9. request.completed
10. feedback.received（用户反馈时追加）

日志必须记录协议、模型、Prompt、编译器、语义目录、数据集 revision 和 Skill 引用等版本；当前无法取得的版本必须显式为空，不能伪造。token、Authorization、API Key、密码和 Secret 按键名自动脱敏。

### 4.2 回放 API

- GET /api/smart-query/operation-events
- GET /api/smart-query/operation-events/{traceId}
- 支持按 conversationId、event、limit 筛选；
- 管理接口受 WYN_AI_SKILL_ADMIN_TOKEN 保护；
- 日志用于问题复现和评测沉淀，不作为绕过 Wyn 权限读取数据的接口。

## 5. 用户反馈与学习

### 5.1 普通用户操作

每次成功回答提供：

- 有帮助；
- 理解有误；
- 口径有误。

错误反馈可以补充自然语言纠正。系统保存原问题、回答摘要、BusinessQueryIntent、CanonicalQueryRequest、SkillRefs、traceId 和用户纠正。

### 5.2 候选资产

- correct、wrong_data、wrong_understanding、wrong_display、other：生成 evaluation-case；
- wrong_metric：生成 skill-rule；
- 初始状态统一为 pending_review；
- 数据负责人可将候选标记为 approved_for_authoring 或 rejected；
- approved_for_authoring 只表示允许进入 Skill/评测编写流程，不代表已自动发布；
- 正式 Skill 仍必须创建新版本、审批并通过领域回归后发布。

API：

- POST /api/smart-query/conversations/{id}/feedback
- GET /api/smart-query/feedback
- GET /api/smart-query/learning-candidates
- POST /api/smart-query/learning-candidates/{id}/approve
- POST /api/smart-query/learning-candidates/{id}/reject

## 6. Skill 治理

项目支持多个业务 Skill，不建设单一万能 Skill。当前正式基线：

| Skill | 领域 | 作用域 | 状态 |
| --- | --- | --- | --- |
| sales-baseline@1.0.0 | 销售 | 指定销售数据集 | approved |
| laboratory-baseline@1.0.0 | 实验室运营 | 指定实验室数据集 | approved |
| retail-baseline@1.0.0 | 零售 | 指定零售数据集 | approved |
| sales-policy-conflict@0.1.0 | UAT 冲突夹具 | uat-org-conflict | approved，仅测试组织命中 |

生产解析只允许 status=approved。draft 和 retired 可以被治理 API 查看和编辑，但不能参与问数 Planner 或 LLM 上下文。

业务负责人参与指标定义、同义词、默认时间、禁止规则、适用范围和版本审批；普通用户不编辑 Skill，只通过问答纠正形成候选。

## 7. 跨行业评测

评测包协议：wynai.evaluation-pack/v1。每个包至少包含：

- domain、datasetId、owner、version、status；
- 黄金问题及口语变体；
- 风险等级；
- 标准状态、指标、维度、时间粒度和是否必须澄清；
- 反例、高影响问题和多轮场景；
- 可选精确数值或结果不变量；
- 页面截图验收引用。

当前建立 sales-core@1.0.0、laboratory-core@1.0.0、retail-core@1.0.0。销售包为 approved；实验室和零售包为 draft，需对应业务负责人确认标准答案后才能作为发布阻断门槛。

评测使用阶段：

1. 开发回归：协议、Prompt、模型、Skill、编译器变更时自动运行；
2. Shadow：新旧路由同时规划，只执行当前生产链路并比较差异；
3. 灰度：按低、中、高风险逐级启用；
4. 生产：将低评分、澄清失败和用户纠正匿名化为候选用例；
5. 发布门槛：高风险自信误答为零，P0 显式约束丢失为零。

## 8. 用户参与与责任边界

| 角色 | 必须参与 | 不需要参与 |
| --- | --- | --- |
| 普通用户 | 正常提问、歧义确认、结果反馈、自然语言纠正 | 写 Skill、维护 JSON、执行回归 |
| 行业专家/数据负责人 | 指标口径、黄金答案、高风险问题、Skill 和评测包审批 | 编写程序和查询 Payload |
| 平台管理员 | 权限、发布、回滚、日志保留和脱敏策略 | 定义业务正确答案 |
| 开发与测试 | 实现、自动化回归、截图与日志交叉验收 | 单方面决定行业指标口径 |

平台可以自动生成问题变体和执行回归，但不能自行定义全部业务正确答案。

## 9. 验收标准

- 风险路由单元测试覆盖 low/medium/high、LLM 超时、熔断和取消；
- 生产 Skill 解析不返回 draft/retired；
- 一次成功 UAT 的 trace 至少包含 request.accepted、turn.received、skill.resolved、planning.completed、query.executed、result.validated、response.composed、turn.completed、request.completed；
- 用户反馈后产生 feedback.received 和 pending_review 候选；
- 日志中任何 token、Authorization、API Key、密码和 Secret 均不可明文出现；
- 三个领域评测包能被规范化和运行；
- 浏览器 UAT 同时保存截图、API 摘要、trace 回放和反馈候选证据；
- 需求、设计、实现、测试和 DEVELOPMENT_PROGRESS_REPORT.md 保持同步。


## 10. 实施与验收结果（2026-08-25）

- 代码实现：risk-router、operational-event-log、feedback-learning、evaluation-suite 已接入会话与服务 API。
- 协议实现：风险评估、运行事件、用户反馈、学习候选和评测包均有 v1 JSON Schema。
- 自动化：npm test 153/153；npm run check 与 npm run check:risk-learning 通过。
- 真实 Wyn API：风险学习专项 6/6 通过；低风险不调用 LLM，中风险同比由 LLM 复核后执行。
- 浏览器：7 张 1280×720 截图通过；组合图 Canvas 515×300；页面无横向溢出；干净页面控制台 error/warn 为 0。
- 日志回放：三条浏览器 trace 均包含 10 个有序事件并关联 feedback.received，可复原用户操作和软件实际运行过程。
- 反馈 UX：负向反馈已改为回答区内联纠错编辑器，不使用 window.prompt。
- 详细证据：SMART_QUERY_RISK_ROUTING_LEARNING_UAT_REPORT_2026-08-25.md 和 test/uat-artifacts/risk-learning-2026-08-25/。

## 11. LLM 语义非扩张约束（2026-08-25 增补）

风险分级决定是否调用 LLM，不代表 LLM 可以改变用户问题边界。对于确定性计划已经 supported 且原问题覆盖完整的中风险问题，混合规划增加以下约束：

1. LLM 输出必须覆盖原问题的指标、维度、时间、排名和派生指标；
2. LLM 不得增加确定性基线之外的用户可见指标、维度或筛选；
3. 同比、环比所需时间粒度可以作为内部计算维度，但不得自动变成结果分组；
4. 语义扩张使用 INTENT_SCOPE_EXPANSION_INVALID 拒绝，不计入模型供应商熔断；
5. 已校验确定性计划可继续执行，运行说明必须区分模型建议被拒绝、超时和服务不可用；
6. 日志记录规划路由、风险、拒绝原因和受控回退，支持事后复原。

该约束解决“模型输出看似更丰富但改变了用户要求结果形状”的平台级风险。专项和真实 UAT 见 SMART_QUERY_SYSTEMIC_SEMANTIC_FIX_UAT_REPORT_2026-08-25.md。
## 2026-08-25 公式指标 Skill 治理扩展

公式派生指标纳入中风险路由：有已审批 Skill 时，确定性规划器生成完整候选，LLM 在可用时复核语义；模型不可发明公式，输出仍须通过覆盖、非扩张和公式版本校验。用户提出未配置的率类指标时，系统生成未解析槽位并澄清，不把模型建议自动发布为生产口径。

`sales-baseline@1.2.0` 是首个验收版本。其毛利率使用稳定指标 ID 依赖和白名单 `ratio` 算子。运行日志保存 `skillRef`、规划路由、查询请求、结果行数和验证状态，可复原用户问题到结果的执行过程。详细协议与 UAT 见 `SMART_QUERY_FORMULA_DERIVED_METRICS_REQUIREMENTS_DESIGN_AND_UAT_2026-08-25.md`。

## 2026-08-26 复杂语义评测纳入风险学习闭环

复杂多维、多指标、派生指标问题统一按风险路由执行：低风险完整时间粒度问题可走已校验确定性快路径；中风险公式/同比问题在 LLM 可用时复核，超时后只能使用已校验回退；高风险且存在未决同比对象时必须澄清。UAT 记录规划路由、LLM 尝试、耗时、Skill 版本、查询结果和截图，日志可复原用户操作。新增 10 组真实 Wyn 复杂 UAT（`CSE-001` 至 `CSE-010`）作为跨行业评测扩展模板，未绑定同比对象的澄清候选将进入反馈学习而不直接改生产 Skill。