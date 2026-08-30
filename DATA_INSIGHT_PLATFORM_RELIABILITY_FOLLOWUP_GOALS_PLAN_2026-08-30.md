# 数据洞察平台可靠性后续目标与详细计划

> 版本：1.1
> 日期：2026-08-30（Asia/Shanghai）  
> 状态：已获用户确认，进入实施；平台公共能力兼容迁移要求已补充
> 前置基线：阶段 0-4 提交 `2368f54`，已推送 `origin/main`

## 1. 计划目的

本计划承接阶段 0-4 的复盘结果，处理当前仍存在的平台级边界问题。目标不是为某一个问数问题增加特例，而是把以下职责固定为可复用的平台能力：

- 完整聚合结果如何成为权威证据；
- 大模型如何在上下文受限时获取可追溯信息；
- Skill 如何定义核心、扩展和证据依赖；
- 运行中断、超时和重试如何形成完整终态；
- 平台级和模块级 UAT 如何验证真实用户链路。

阶段 5（流式响应）继续保持决策门状态，本计划不直接实施流式改造。

本版本新增公共能力上收的保护性约束：F1-F4 的平台化实现不得直接替换数据洞察现有链路，必须先冻结契约、建立黄金基线，并通过 `DataInsightAdapter`、双跑差异、灰度和回滚完成迁移。平台能力变更默认执行平台 P1/P2/P3 与数据洞察 M2/M3 验收；正式发布执行 P4/M4。详细阶段计划见 `PLATFORM_CAPABILITY_EXTRACTION_COMPATIBILITY_GOALS_PLAN_2026-08-30.md`。

## 2. P1 问题与计划阶段映射

| P1 问题 | 计划阶段 | 说明 |
|---|---|---|
| 全量证据与 LLM 实际看到内容不等价 | F1 | 明确“完整事实源”和“单次 Prompt 传输”的边界，建立按需多轮分块分析 |
| 高基数派生证据仍有固定 500 条窗口 | F1 | 移除隐藏窗口，所有限制都必须显式、可解释、可追溯 |
| Skill 尚未完全驱动编排 | F2 | 把 Skill 从 Prompt 配置升级为可执行契约，移除通用编排器中的销售硬编码 |
| Node 重启/请求中断没有完整终态 | F3 | 引入 attempt、interrupted、进程生命周期和诊断终态约束 |
| 响应体超时配置未完全接通 | F4 | 接通配置、统一状态语义、记录用户可感知的总预算 |

## 3. 目标架构

```text
InsightInput v1
      |
      v
SkillPlan 编译器（核心/扩展/字段/证据/阻断规则）
      |
      v
Evidence Compiler（全量事实、统计证据、按需分块）
      |
      +--> LLM Planner（仅在允许的方法内选择）
      +--> LLM Critic（按核心/扩展边界核验）
      +--> LLM Narrator（只表达已核验结论）
      |
      v
InsightDocument + 完整诊断事件 + 可复盘运行状态
```

平台负责契约、证据、状态和安全边界；Skill 负责行业语义、方法适用性和业务规则；LLM 负责理解、选择和表达，不负责修改平台契约。

## 4. 需要用户先确认的决策

### D1：证据传输模式

**推荐：分层混合模式。**

- `InsightInput v1` 和 Evidence Pack 保留调用方提供的完整聚合结果；
- 确定性引擎计算总额、趋势、分组、占比和覆盖信息；
- 普通洞察向 LLM 提供完整统计与证据目录；
- 只有 Skill 明确需要逐块识别交叉关系时，才启动多轮分块分析；
- 任何分块都必须记录范围、块序号、覆盖度和最终汇总关系，禁止静默采样。

不推荐把全部行一次性放入单个 Prompt，也不把分块统计摘要宣称为 LLM 已逐行理解全部数据。

### D2：Skill 执行模式

**推荐：可执行 Skill 契约。**

Skill 至少定义：

- `coreMethods`、`optionalMethods`；
- 方法对应的字段和证据依赖；
- `requiredFacts`；
- `blockingRules`、`partialCompletionRules`；
- 稀疏数据语义；
- 指标绑定和业务口径。

平台先编译受控 `SkillPlan`，LLM 只能在允许的方法和证据范围内规划与表达。这样新增行业只需增加 Skill 和评测，不需要修改 `server.mjs` 的行业判断。

### D3：运行生命周期与超时拆分

拆成两个独立工作流：

- **D3A 运行诊断**：attempt、重试、进程重启、请求断开、`interrupted` 状态和终态完整性；
- **D3B Gateway 语义**：响应头、响应体、总截止、取消、重试和健康状态。

## 5. 分阶段实施计划

### F0：方案冻结与契约设计

**目标**：在写代码前把 D1-D3 和运行边界冻结。

**任务**：

- 补充 Evidence Transmission Contract v1；
- 补充 Skill Executable Contract v1；
- 定义 `attemptId`、`interrupted`、进程生命周期事件和终态不变量；
- 定义 Gateway 错误码、超时层级、总耗时和健康状态枚举；
- 明确开发、UAT、生产环境对运行数据目录 fallback 的策略。

**验收级别**：平台级 P1，文档评审 + 契约测试设计评审。

### F1：证据编译与分层传输

**目标**：让“完整来源”和“上下文传输”都可解释，消除隐藏截断。

**任务**：

- 移除时间派生证据的固定 500 条窗口；
- 统一 `sourceCompleteness`、`evidenceCoverage`、`businessSparsity`；
- 为每个证据记录 `transmission`、`sourceRowCount`、`representedRowCount`、`chunkCount`；
- 证据目录按 Skill 核心依赖优先，不因 32/16/8/4 窗口丢失核心证据；
- 对需要行级关系的 Skill 增加多轮分块分析和最终汇总；
- 证明 `omittedGroups=0` 与“LLM已看到全部行”不是同一个指标。

**验收级别**：平台级 P1 + 模块级 M2。

**验收动作**：245 行、1,581 行、超过 500 个期间、高基数交叉数据；检查核心结论、覆盖字段和诊断事件。

### F2：Skill 可执行编排

**目标**：实现平台能力与行业 Skill 的组合，移除行业硬编码。

**任务**：

- 建立 SkillPlan 编译器和方法注册表；
- 将核心/扩展、证据依赖、字段绑定和阻断规则转换为确定性计划；
- LLM Planner 只能在允许的方法集合内选择；
- Critic 按 SkillPlan 判断核心和扩展，不接受 LLM 自行改变阻断级别；
- 删除或替换 `server.mjs` 中销售字段和中文关键词驱动的判断；
- 补充销售、零售、实验室、运营等跨行业 Skill 评测包。

**验收级别**：平台级 P1 + 模块级 M1/M2。

**验收动作**：同一平台运行两个以上行业 Skill，验证无收入/利润字段的行业不会被销售规则误判。

### F3：运行生命周期与诊断闭环

**目标**：任何运行都能按 `insightId` 还原到唯一终态。

**任务**：

- 每次生成和重试创建独立 attempt；
- 运行状态增加 `interrupted`，并记录中断原因；
- 记录进程启动、优雅关闭、强制终止和请求断开事件；
- 服务启动时扫描未完成运行并按策略标记为 interrupted；
- 诊断事件增加终态校验，禁止只有 started 没有 finished/failed/interrupted；
- 明确浏览器断开后服务端是否继续完成 LLM 调用。

**验收级别**：平台级 P1 + 模块级 M2。

**验收动作**：正常成功、用户重试、Node 重启、HTTP 断开、Provider 失败、恢复后复盘。

### F4：Gateway 配置与健康语义

**目标**：让超时配置真实生效且可被正确解释。

**任务**：

- 接通 `LLM_RESPONSE_BODY_TIMEOUT_MS` 到服务端配置和各 operation policy；
- 区分响应体总读取超时与流式空闲超时，暂不引入流式协议；
- 统一 Planner、Critic、Narrator、Repair 的阶段预算和用户总预算；
- `/api/health` 和 `/api/llm/health` 统一使用 `not_configured/not_checked/healthy/unhealthy/circuit_open`；
- 记录每次 attempt 的阶段、状态、耗时、错误码和重试关系。

**验收级别**：平台级 P1 + 模块级 M2。

**验收动作**：响应头慢、响应体慢、总截止、429、5xx、取消、重试耗尽和主动健康探针。

### F5：平台与模块真实 UAT 及阶段 5 决策

**目标**：用真实用户链路验证 F1-F4，再决定是否启动流式响应。

**平台级 P1**：协议、证据覆盖、诊断终态、Gateway 状态、运行目录和权限。

**模块级 M1**：正常真实 LLM 洞察，输出有业务意义的正文。

**模块级 M2**：慢响应、非法 JSON、核心证据不足、扩展失败、重试、中断恢复。

**浏览器验收要求**：截图必须同时包含实际洞察正文、状态和错误/部分完成原因；不能只截空页面或模块入口。

**阶段 5 决策门**：只有 F1-F4 通过真实 UAT，且仍存在长响应头、用户进度或流式空闲判断需求时，才提交流式响应实施方案。

## 6. 交付物

- 本计划及决策记录；
- Evidence Transmission Contract v1；
- Skill Executable Contract v1；
- Gateway Timeout and Health Contract v1；
- Insight Run Lifecycle and Diagnostic Contract v1；
- 更新 Skill 文档和跨行业评测包；
- 平台 P1、模块 M1/M2 UAT 报告；
- PC 成功和失败链路截图；
- `DEVELOPMENT_PROGRESS_REPORT.md` 进度和缺陷闭环记录。

## 7. 完成标准

1. 核心证据没有隐藏 Top-N、固定组数或固定期间窗口；
2. 每个 LLM 分块都有明确范围和覆盖关系；
3. 核心/扩展完全由 SkillPlan 和平台规则决定；
4. 不同业务领域不依赖销售字段硬编码；
5. 所有运行都有成功、失败或中断终态；
6. 超时配置和健康状态与实际 Gateway 行为一致；
7. LLM 失败不会生成伪成功或模板化洞察；
8. 平台级和模块级 UAT 均包含真实失败链路；
9. 阶段 5 是否启动有真实 UAT 数据支撑。

## 8. 当前状态与下一步

- 阶段 0-4：已提交并推送，作为当前基线；
- D1-D3：用户已确认按推荐方案实施；
- F0：契约和决策已冻结并落地；
- F1：全量事实源、证据覆盖元数据和无损分块已落地；
- F2：SkillPlan 可执行契约已落地，通用编排器不再依赖销售字段硬编码；
- F3：attempt/interrupted、启动恢复和诊断终态校验已落地；
- F4：Gateway 分层超时、健康状态和总预算记录已落地；
- F5：等待 F1-F4 的真实成功 UAT 门禁，不提前实施流式响应；
- 阶段 5：继续暂缓；
- 当前剩余工作是用允许访问 DashScope `443` 的受控 `8787` 进程复跑成功链路，并完成平台 P1 + 模块 M1/M2 的最终签署。

### 8.1 本次实施确认（2026-08-30）

| 方案 | 当前状态 | 可核验证据 |
|---|---|---|
| 1. 全量事实源 + 按需无损分块 | 已完成 | `test/evidence-pack.test.mjs`、Evidence Transmission Contract v1、全量/高基数证据测试 |
| 2. SkillPlan 可执行契约 | 已完成 | `skill-plan.mjs`、Skill Executable Contract v1、跨领域 Skill 回归 |
| 3. 生命周期/诊断/Gateway 治理 | 已完成 | `insight-diagnostic-store.mjs`、`llm-gateway.mjs`、Lifecycle/Gateway Contract v1、诊断回归 |

代码和自动化门禁均通过；真实运行可用性仍以当前 `8787` 进程的 LLM 健康探针和真实洞察 UAT 为准。
