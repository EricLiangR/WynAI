# EvidenceTransportPlan v1

版本：`wynai.evidence-transport-plan/v1`

## 目的

记录平台为何选择聚合证据、无损行级分块或自动混合模式。该计划是内部运行契约，不要求用户手工选择。

## 模式

- `aggregate-catalog`：统计摘要、证据目录和可追溯 ID；
- `lossless-row-chunk`：按范围无损分块并汇总块事实；
- `adaptive-hybrid`：聚合优先，核心证据不足时自动升级分块；
- `auto`：平台决策入口，运行结果必须记录最终模式。

## 最低字段

- `mode`、`initialMode`、`finalMode`；
- `policy`：Skill 高层能力边界；
- `reason`、`decisionTrace`：自动决策的可解释原因；
- `modelBudget`：模型窗口、输入预算、输出预留和估算器；
- `evidence`：来源行数、表示行数、省略分组、块数和无损标志。

## 决策要求

1. 先验证聚合证据能否覆盖全部核心方法；
2. 证据足够时使用 `aggregate-catalog`；
3. 核心方法需要行级关系且 Skill/平台允许时，升级为 `lossless-row-chunk`；
4. 只有扩展需要分块时，核心结果可以 `completed-partial`；
5. 核心无法安全完成时返回真实 `needs_review/failed`；
6. 禁止固定 Top-N、头尾采样或静默删除核心证据。

## 追踪示例

```json
{
  "schema": "wynai.evidence-transport-plan/v1",
  "mode": "adaptive-hybrid",
  "initialMode": "aggregate-catalog",
  "finalMode": "aggregate-catalog",
  "reason": ["core-evidence-sufficient", "planner-budget-within-limit"],
  "evidence": {
    "sourceRowCount": 418,
    "representedRowCount": 418,
    "omittedGroups": 0,
    "chunkCount": 0,
    "lossless": true
  }
}
```
