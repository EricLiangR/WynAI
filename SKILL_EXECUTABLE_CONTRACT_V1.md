# Skill Executable Contract v1

版本：`wynai.skill-plan/v1`

## 目的

把行业 Skill 从提示词说明升级为受平台校验的执行契约。平台负责编译和边界，Skill 负责行业语义、方法适用性和业务规则，LLM 只能在编译后的计划内选择和表达。

## 最低字段

- `coreMethods`：用户明确要求或行业必需的方法，固定 `blocking=true`。
- `optionalMethods`：Skill 明确声明可选的方法。
- `extendedMethods`：可在核心完成后按需执行的方法，默认非阻断。
- `requiredFields/requiredFacts`：方法的字段和确定性事实依赖。
- `blockingRules/partialCompletionRules`：核心失败和扩展失败的边界。
- `rowLevelMethods`：允许启动无损行级分块的方法。
- `businessSemantics/metricDefinitions/riskRules`：行业语义和口径。

## 编译规则

`compileSkillPlan` 生成 `wynai.skill-plan/v1`，固化方法、字段、事实、不可用核心方法和分块上限。Planner 的 `methodId` 必须存在于计划；核心假设不能引用扩展方法；Critic 不能自行改变 `blocking`。

## 容错规则

- 核心方法或核心事实不可用：整体 `needs_review/failed`，不得伪装成功。
- 单个扩展不可用：保留已验证核心，返回 `completed-partial` 并列出未完成项。
- 单条 Narrator 结论不可核验：隔离或删除该条；只有全部内容不可用时才进入一次 Repair。
- Skill 不应要求不存在的期间或完整笛卡尔积；稀疏记录按业务事实处理。
