# 数据洞察 Skill Profile

该目录存放数据洞察编排侧的 Skill 扩展配置。文件名不参与匹配，`id` 必须与 `skills/**/skill.json` 中已审批 Skill 的 ID 一致。服务端解析基础 Skill 后，按 ID 合并这里的配置。

## 核心字段

- `requiredFacts`：必须可构造的确定性业务事实。
- `insightMethods`：该行业允许的数据洞察方法全集。
- `coreMethods`：用户问题命中时属于核心、可阻断的分析方法。
- `optionalMethods`：扩展方法；失败只能形成未完成项，不能拖垮核心结果。
- `requiredFields`：核心方法可使用的业务字段。
- `evidenceRequirements`：每种方法所需字段或证据。
- `blockingRules`：核心失败边界。
- `partialCompletionRules`：扩展失败、单条叙述失败时的部分完成规则。
- `businessSemantics`：行业数据解释规则，例如真实业务稀疏、不自动补零。
- `qualityThresholds`：行业质量阈值，不得覆盖平台的完整输入和证据覆盖分离原则。

## 平台约束

1. `InsightInput v1` 是权威输入，核心证据不得被固定 Top-N 或固定行数静默截断。
2. `sourceCompleteness`、`evidenceCoverage`、`businessSparsity` 必须分别解释。
3. 自然缺少业务记录不等于数据缺失，除非输入契约明确要求完整期间集合。
4. 扩展方法必须是非阻断项；核心方法是否阻断由平台和 Skill 共同校验，不能只信任 LLM 输出。
5. Skill 不得允许模板化、无证据的降级洞察。
