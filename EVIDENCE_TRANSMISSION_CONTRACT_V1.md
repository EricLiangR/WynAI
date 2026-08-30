# Evidence Transmission Contract v1

版本：`wynai.evidence-pack/v1`

## 目的

定义 `InsightInput v1` 进入 Planner、Critic、Narrator 前的事实边界。调用方提供的聚合结果是权威事实源；平台不得因为期望存在更多期间、维度或笛卡尔积而推断数据缺失。

## 必须保留的语义

- `sourceCompleteness`：调用方声明的 `accuracy/isSample/isTruncated`，以及来源行数。
- `evidenceCoverage`：平台实际编译的证据分组、表示分组和省略分组。
- `businessSparsity`：`observed-records-only`、不补零、不把无记录当作证据缺失。
- `transmission`：`inline`、`catalog-evidence` 或 `chunked-summary-all-rows`，并记录 `sourceRowCount/chunkSize/chunkCount`。

## 传输规则

1. 聚合结果在合理预算内完整传输；禁止静默 Top-N、头尾采样或固定期间窗口。
2. 超出单次上下文预算时，使用可追溯无损分块；每块记录 `index/offset/rowCount/chunkCount`。
3. 只有调用方或受控方法显式限制时，才设置 `resultLimited=true`；必须说明 `omissionReason` 和影响范围。
4. LLM 看到的是证据目录、统计摘要和必要分块，不得把目录窗口误称为源数据采样。
5. `omittedGroups=0` 只表示平台证据覆盖完整，不代表调用方传入了业务上所有可能组合。

## 失败边界

核心证据不可编译或被平台丢失时，核心洞察失败；真实稀疏、空值和调用方声明的有限范围不自动失败。
