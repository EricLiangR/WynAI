# 数据洞察自适应上下文与证据传输目标计划

> 版本：1.0  
> 日期：2026-08-30（Asia/Shanghai）  
> 状态：待用户 Review，尚未授权实施  
> 适用范围：InsightInput v1、Evidence Pack、SkillPlan、LLM Gateway、Planner/Critic/Narrator  
> 前置共识：采用“平台自动判断、Skill 提供能力边界、用户无需选择模式”的设计

## 1. 背景与问题

当前平台已经具备完整事实源、Evidence Pack、SkillPlan、分层超时和严格失败门禁，但上下文管理仍有一个平台级缺口：平台主要按“证据条目数量”控制 Planner 输入，没有对单个证据条目的大小建立独立门禁。

典型案例 `ins-38d0d6ba-199`：

- 输入 418 行、6 个字段；
- `isSample=false`、`isTruncated=false`，数据本身有效；
- Planner 预检估算 `21,475/20,000 tokens`；
- LLM 实际调用次数为 0；
- 失败码为 `LLM_CONTEXT_LIMIT`。

这说明当前错误是平台传输预算超限，不是客户模型真实上下文能力不足。当前实现还存在一个反直觉行为：大于 500 行的数据会转成摘要/分块结构，而 500 行以内可能被完整展开，导致较小结果集反而更容易撑大 Planner 请求。

## 2. 核心决策

### 2.1 模式选择由平台负责

平台新增统一的 `transportMode=auto` 决策入口。用户不需要选择“摘要模式”或“分块模式”，Skill 也不负责配置具体分块大小、块序号或 token 数。

平台根据以下事实自动决策：

- 用户问题和核心分析方法；
- SkillPlan 的证据能力边界；
- 输入结果的行数、维度、字段语义和基数；
- 已编译证据是否足以支持核心假设；
- 当前 Provider/Model 的上下文窗口和输出预算；
- 当前 operation 的阶段预算和安全余量。

### 2.2 Skill 负责“能力”，不负责“传输实现”

Skill 只声明较高层次的业务能力，例如：

- 某方法是否聚合证据足够；
- 某方法是否需要实体之间的行级关系；
- 某方法是否允许平台使用无损分块；
- 核心方法、扩展方法和部分完成规则。

Skill 不声明：

- 每块多少行；
- 每块多少 token；
- 使用 4/8/16/32 条目录窗口；
- 何时重试或如何拼接 Prompt。

### 2.3 强上下文模型可以被利用，但仍受平台安全预算约束

模型能力不通过“直接放宽固定阈值”使用，而是通过模型能力档案参与预算计算：

```text
有效输入预算 =
min(
  模型上下文窗口 - 输出预留 - 协议开销 - 安全余量,
  平台最大输入预算,
  当前 operation 预算
)
```

平台始终保留硬门禁，避免模型配置错误导致请求超过真实上下文限制。

## 3. 总体目标

### G1：消除由平台打包缺陷导致的上下文失败

- 单个证据条目必须有独立大小门禁；
- 证据目录窗口递减不能作为唯一压缩手段；
- 418 行、1,581 行及其他高基数输入不会因为重复展开而误触发 `LLM_CONTEXT_LIMIT`；
- 上下文超限时不得静默采样、删掉核心证据或伪装成功。

### G2：自动选择最适合的证据传输模式

- 聚合证据足够时，优先使用摘要/目录模式；
- 核心方法需要行级关系且聚合证据不足时，平台自动升级为无损分块；
- 只有扩展方法需要分块时，核心洞察仍可独立完成；
- 分块失败时按核心/扩展规则处理，不拖垮已验证核心结果。

### G3：适配不同上下文能力的模型

- 支持 16K、32K、128K 等不同模型能力档案；
- 不同模型可以使用不同的输入预算、输出预留和分块大小；
- 模型能力配置错误或缺失时采用保守默认值；
- 不能因模型能力更强而取消证据追溯和失败门禁。

### G4：保持完整事实源和可复盘性

- `InsightInput v1` 的完整输入始终保留；
- 传输压缩只改变 Prompt 表示，不改变事实源；
- 每次自动决策记录模式、原因、预算、证据范围、块范围和覆盖度；
- 诊断日志能够解释“为什么采用该模式”和“为什么没有采用另一模式”。

### G5：用户体验不暴露上下文工程复杂度

- 用户继续只提交业务问题；
- 前端不增加模式选择控件；
- 正常情况下只看到洞察结果；
- 只有无法安全完成时，才显示真实失败或部分完成原因。

## 4. 术语和模式定义

### 4.1 聚合证据模式（`aggregate-catalog`）

技术流程：

```text
完整结果集
  -> 确定性统计、趋势、分组、贡献、质量证据
  -> Planner 接收摘要、证据目录和可追溯 ID
  -> Critic/Narrator 使用同一证据边界
```

适用场景：总额、利润、毛利率、趋势、贡献、排名、集中度和其他可由统计证据直接验证的方法。

优点：调用次数少、延迟低、成本低、全局结论稳定。

限制：如果问题需要多个实体之间的细粒度组合关系，而现有聚合证据没有表达该关系，则不能强行生成结论。

### 4.2 无损行级分块模式（`lossless-row-chunk`）

技术流程：

```text
完整结果集
  -> 平台按范围无损分块
  -> 每块生成可追溯事实
  -> 平台汇总块事实并校验覆盖度
  -> Critic/Narrator 生成最终洞察
```

适用场景：需要供应商-产品-期间等组合关系、异常组合或其他无法由现有聚合证据直接表达的核心方法。

优点：保留细粒度关系，能够支持更复杂的组合分析。

限制：调用次数、延迟和成本更高；必须处理跨块重复、冲突和汇总一致性。

### 4.3 自动混合模式（`adaptive-hybrid`）

这是平台默认的实际策略：

```text
先用 aggregate-catalog 完成核心分析
        |
        | 核心证据足够
        v
直接进入 Critic/Narrator

        |
        | 核心方法需要行级关系，且证据不足
        v
自动升级为 lossless-row-chunk
```

该模式不是用户可见配置，而是平台决策结果。诊断中必须记录初始模式、升级原因和最终模式。

## 5. 目标架构

```text
InsightInput v1
      |
      v
SkillPlan 编译器
  - 核心/扩展方法
  - 证据能力边界
  - 行级关系是否允许
      |
      v
Model Capability Profile
  - contextWindowTokens
  - maxInputTokens
  - maxOutputTokens
  - tokenizer/估算器
      |
      v
Evidence Profile
  - sourceCompleteness
  - evidenceCoverage
  - businessSparsity
  - row/field/cardinality profile
      |
      v
Adaptive Evidence Transport Planner
  - 预算计算
  - 单条证据压缩
  - aggregate-catalog
  - lossless-row-chunk
  - 核心/扩展升级策略
      |
      +--> LLM Planner
      +--> LLM Critic
      +--> LLM Narrator
      +--> 诊断与完整回放
```

## 6. 职责边界

| 能力 | 平台 | Skill | LLM | 用户 |
|---|---|---|---|---|
| 判断上下文预算 | 负责 | 提供业务约束 | 不负责 | 不负责 |
| 选择传输模式 | 负责 | 提供允许能力 | 不负责 | 不负责 |
| 定义核心/扩展方法 | 执行和校验 | 负责 | 可提出候选 | 不负责 |
| 业务指标口径 | 校验 | 负责 | 理解和表达 | 提问 |
| 分块大小和块序号 | 负责 | 不负责 | 不负责 | 不负责 |
| 结论表达 | 校验 | 提供语义 | 负责 | 消费结果 |
| 失败/部分完成边界 | 负责强制 | 提供规则 | 不得自行放宽 | 接收真实状态 |

## 7. 契约设计

### 7.1 SkillPlan 增量字段

建议在现有 `wynai.skill-plan/v1` 中增加高层能力字段：

```json
{
  "transportPolicy": {
    "mode": "auto",
    "allowLosslessChunking": true,
    "defaultEvidenceLevel": "aggregate"
  },
  "methods": [
    {
      "id": "quarterly-trend",
      "evidenceLevel": "aggregate-sufficient",
      "rowRelationship": "not-required"
    },
    {
      "id": "supplier-product-period-anomaly",
      "evidenceLevel": "row-relationship-allowed",
      "rowRelationship": "use-when-aggregate-insufficient"
    }
  ]
}
```

兼容规则：

- 未声明时默认 `mode=auto`、`defaultEvidenceLevel=aggregate`；
- `allowLosslessChunking=false` 时平台不得对该 Skill 方法启动行级分块；
- Skill 不能把扩展方法提升为核心，也不能取消平台预算门禁；
- 技术字段如 `chunkSize`、`maxChunks` 由平台和模型能力档案决定，不写入行业 Skill。

### 7.2 Model Capability Profile

建议新增平台级模型能力配置：

```json
{
  "provider": "dashscope",
  "model": "deepseek-v4-flash-0731",
  "contextWindowTokens": 32768,
  "maxInputTokens": 24576,
  "maxOutputTokens": 4096,
  "supportsJson": true,
  "supportsStreaming": false,
  "tokenEstimator": "conservative-json"
}
```

原则：

- 模型能力由配置声明，不能仅根据一次成功请求推断；
- 未配置时采用保守平台默认值；
- `maxInputTokens` 不得超过 `contextWindowTokens - maxOutputTokens`；
- 强模型可以提高预算，但不能跳过单条证据压缩和证据追溯；
- 阶段 5 流式能力继续单独决策，本计划不实施流式传输。

### 7.3 EvidenceTransportPlan

建议新增内部可审计结构：

```json
{
  "schema": "wynai.evidence-transport-plan/v1",
  "mode": "adaptive-hybrid",
  "initialMode": "aggregate-catalog",
  "finalMode": "aggregate-catalog",
  "reason": ["core-evidence-sufficient", "planner-budget-within-limit"],
  "modelBudget": {
    "contextWindowTokens": 32768,
    "inputBudgetTokens": 24576,
    "estimatedTokens": 11840,
    "outputReserveTokens": 4096,
    "safetyReserveTokens": 2048
  },
  "evidence": {
    "sourceRowCount": 418,
    "representedRowCount": 418,
    "omittedGroups": 0,
    "chunkCount": 0,
    "lossless": true
  },
  "decisionTrace": [
    {"step": "aggregate-evidence-check", "result": "sufficient"},
    {"step": "per-item-compaction", "result": "applied"},
    {"step": "planner-budget-check", "result": "passed"}
  ]
}
```

该结构必须进入诊断日志，供 `insightId` 复盘；不要求全部暴露给最终用户。

## 8. 自动决策算法

### 8.1 决策顺序

1. 校验 `InsightInput v1`、字段语义和调用方质量声明；
2. 编译 SkillPlan，确定核心、扩展、证据依赖和允许能力；
3. 读取当前 Provider/Model 能力档案；
4. 生成确定性 Evidence Profile；
5. 计算有效输入预算和阶段预算；
6. 对每个证据条目执行独立大小门禁和可追溯压缩；
7. 判断聚合证据是否覆盖全部核心方法；
8. 若覆盖且预算足够，使用 `aggregate-catalog`；
9. 若核心方法需要行级关系且 Skill/平台允许分块，升级为 `lossless-row-chunk`；
10. 若只有扩展方法需要分块，保留核心并将扩展标记为待完成；
11. 若核心无法在预算和分块上限内安全完成，返回真实 `needs_review/failed`；
12. 将最终模式、预算、原因和覆盖度写入诊断。

### 8.2 不允许的决策

- 仅因某个实体缺少期间记录就启动分块或判定数据缺失；
- 仅因模型上下文较强就把全部目录和行重复放入每个阶段；
- 使用固定 Top-N、头尾采样或静默删除核心证据；
- 让用户承担传输模式选择；
- 让 LLM 自行修改核心/扩展阻断级别；
- 以 `LLM_CONTEXT_LIMIT` 为理由生成确定性伪洞察。

## 9. 上下文预算设计

### 9.1 预算层级

平台需要同时记录四个值：

- `contextWindowTokens`：模型上下文总窗口；
- `inputBudgetTokens`：本次输入允许使用的预算；
- `estimatedInputTokens`：平台估算的实际输入；
- `outputReserveTokens`：为 JSON 输出和修订预留的空间。

现有 `JSON.stringify(...).length / 4` 只能作为保守兜底估算。后续应支持模型 tokenizer 或可插拔估算器，并保留估算方法和版本。

### 9.2 单条证据门禁

目录窗口从 32/16/8/4 递减不再是主策略，只能作为最后的目录数量控制。每个证据条目必须先经过：

1. 结构判断：标量、分类列表、聚合行、派生事实；
2. 独立大小估算；
3. 超限转换为摘要、范围和分块引用；
4. 保留 `sourceRowCount`、`representedRowCount`、`chunkCount` 和 `transmission`；
5. 需要行级分析时再按块取数，不在 Planner 目录中展开全部行。

## 10. 分阶段实施计划

### 阶段 A：契约和基线冻结

**目标**：冻结模型能力、传输计划和 Skill 高层能力边界。

**任务**：

- 更新 Skill Executable Contract v1；
- 新增 Model Capability Profile 设计；
- 新增 EvidenceTransportPlan v1；
- 记录 418 行、1,581 行、低基数和高基数基线；
- 明确 16K/32K/128K 模型预算计算规则。

**验收级别**：平台级 P1，文档评审 + 契约测试设计评审。

**阶段门**：未完成契约冻结，不进入代码实施。

### 阶段 B：证据条目自适应压缩

**目标**：修复“小于 500 行反而完整展开”的缺陷。

**任务**：

- 对单条证据增加独立大小门禁；
- Planner 目录只传摘要和证据 ID；
- 保留完整事实源和无损范围元数据；
- 证明 418 行案例不再因单条证据展开触发预算错误；
- 增加大字段、长中文标签和多证据重复场景测试。

**验收级别**：平台级 P1 + 模块级 M2。

**阶段门**：禁止采样，所有压缩必须可追溯。

### 阶段 C：平台自动传输决策器

**目标**：由平台根据证据覆盖和预算选择聚合、分块或混合模式。

**任务**：

- 实现 `transportMode=auto`；
- 实现核心证据充分性判断；
- 实现聚合优先、核心不足时自动升级分块；
- 实现扩展独立失败和 `completed-partial`；
- 将决策原因写入 `EvidenceTransportPlan` 和诊断。

**验收级别**：平台级 P1 + 模块级 M1/M2。

**阶段门**：用户不需要新增配置，旧 Skill 未配置时仍能安全运行。

### 阶段 D：模型能力档案和预算适配

**目标**：让不同上下文能力的模型使用各自合理预算。

**任务**：

- 增加 Provider/Model 能力配置；
- 计算输入预算、输出预留和安全余量；
- 支持保守默认值和配置错误校验；
- 让 Gateway/Orchestrator 记录预算来源和估算器版本；
- 验证强模型可以使用更大预算，但仍受单条证据门禁。

**验收级别**：平台级 P1 + 模块级 M2。

**阶段门**：16K、32K、128K 配置均不得产生越界请求或伪成功。

### 阶段 E：跨阶段编排和分块汇总

**目标**：保证分块结果可以被 Critic/Narrator 安全使用。

**任务**：

- 分块事实统一结构和范围字段；
- 防止跨块重复、冲突和数字重复计入；
- 对跨块汇总增加确定性校验；
- 只允许 SkillPlan 允许的行级关系方法触发分块；
- 分块失败时按核心/扩展规则返回真实状态。

**验收级别**：模块级 M1/M2。

### 阶段 F：真实平台和模块 UAT

**目标**：验证真实用户链路和不同模型预算档案。

**平台级 P1**：

- 契约版本和字段兼容；
- 自动决策可解释；
- 完整事实源和证据覆盖可复盘；
- 预算、模式、块范围和失败状态可查；
- 无隐式采样和伪成功。

**模块级 M1**：

- 真实 LLM 聚合证据模式成功；
- 真实 LLM 自动混合模式成功；
- 返回有业务意义的管理摘要、关键发现、风险和行动建议。

**模块级 M2**：

- 418 行上下文边界案例；
- 1,581 行高基数案例；
- 16K/32K/128K 模型配置；
- 核心证据不足、扩展证据不足；
- 稀疏业务记录；
- 分块失败、超时、取消和重试。

浏览器截图必须同时显示实际洞察正文、当前状态和必要的部分完成/失败原因，不能只截入口或空状态。

### 阶段 G：发布与回滚门禁

**目标**：以可控方式启用自动决策。

**任务**：

- 保留平台级开关，默认 `auto`；
- 记录每次模式选择和预算分布；
- 先在测试/验收环境启用，再扩展到生产；
- 出现证据覆盖下降、预算误判或分块冲突时，可回退到聚合优先模式；
- 回滚不能恢复隐式采样或确定性伪洞察。

**验收级别**：平台级 P1 + 模块级 M2。

## 11. 测试矩阵

| 用例 | 期望模式 | 关键验证 |
|---|---|---|
| 低基数月度销售利润 | `aggregate-catalog` | 直接成功，证据摘要可追溯 |
| 418 行三年季度多维结果 | `aggregate-catalog` 或自动压缩后混合 | 不因单条证据展开触发 `LLM_CONTEXT_LIMIT` |
| 1,581 行高基数结果 | `aggregate-catalog` + 必要分块 | 证据完整、无静默采样 |
| 需要供应商-产品-期间组合异常 | `lossless-row-chunk` | 块范围、覆盖度和跨块汇总正确 |
| 只有扩展方法需要行级关系 | `adaptive-hybrid` | 核心完成，扩展失败不拖垮核心 |
| 真实稀疏数据 | 聚合优先 | 不补零、不判定证据缺失 |
| 16K 模型 | 更强压缩/更多分块 | 不越界，不伪成功 |
| 32K 模型 | 更宽输入预算 | 能利用预算但仍保留单条门禁 |
| 128K 模型 | 更大目录或更少分块 | 不重复发送无必要数据 |
| 模型能力缺失 | 保守默认 | 可解释失败，不误报模型健康 |
| Provider 失败 | 任一模式 | 真实失败，无降级正文 |

## 12. UAT 完成标准

1. 418 行案例不再因单个证据条目完整展开而触发平台上下文错误；
2. 1,581 行案例保持完整证据覆盖，且不依赖隐式采样；
3. 用户无需选择传输模式；
4. Skill 只配置业务能力边界，不承担 token 和分块工程；
5. 平台可以解释每次模式选择和升级原因；
6. 强上下文模型能够使用更高预算，但不会跳过平台门禁；
7. 16K/32K/128K 模型配置均有独立自动化和真实 UAT 证据；
8. 核心/扩展失败边界符合 SkillPlan；
9. 真实稀疏数据不被误判为证据缺失；
10. LLM 失败不生成伪洞察或模板化降级；
11. 每次运行都能通过 `insightId` 复盘输入、证据、预算、模式、阶段和终态；
12. 阶段 5 流式响应继续作为独立决策，不因本计划自动启动。

## 13. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 模型能力配置不准确 | 配置校验、保守默认、安全余量、真实探针和 UAT |
| 分块调用成本和延迟增加 | 聚合优先、仅核心不足时升级、限制并发和块数 |
| 跨块结论不一致 | 块范围元数据、确定性汇总、Critic 校验和数字证据验证 |
| Skill 配置过于复杂 | 只保留高层能力字段，平台负责技术策略 |
| 平台自动判断误判 | 记录决策原因，支持 `needs_review`，不生成伪成功 |
| 强模型被过度使用 | 仍执行单条证据门禁和 operation 预算 |
| 旧 Skill 缺少新字段 | 使用安全默认值，不要求一次性迁移所有 Skill |

## 14. 需要 Review 的问题

请重点确认以下决策：

1. 是否确认平台默认使用 `transportMode=auto`，用户不选择模式；
2. 是否接受 Skill 只声明 `evidenceLevel/rowRelationship/allowLosslessChunking` 等高层能力；
3. 是否同意引入 Model Capability Profile，并由平台配置上下文窗口、输入预算和输出预留；
4. 是否同意“聚合优先，核心证据不足时自动无损分块”的混合策略；
5. 是否同意 418 行案例作为首个回归门禁，证明单条证据大小门禁生效；
6. 是否同意阶段 F 必须包含 16K/32K/128K 三档模型能力测试；
7. 是否确认本计划不启动流式响应，阶段 5 继续单独评审。

## 15. 当前状态和下一步

- 本文档目前仅用于 Review，尚未修改代码；
- 用户确认后先实施阶段 A，完成契约和基线冻结；
- 每个阶段完成代码、自动化测试和对应级别 UAT 后再进入下一阶段；
- 阶段 F 真实成功 LLM UAT 通过后，才评估是否需要启动流式响应阶段 5；
- 所有失败结论必须区分模型能力不足、平台预算不足、运行环境阻断和业务证据不足。
