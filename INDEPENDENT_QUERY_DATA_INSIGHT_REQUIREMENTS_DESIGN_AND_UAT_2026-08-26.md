# 独立问数接入数据洞察：需求、设计、开发测试与 UAT 验收报告

> 文档版本：1.0  
> 验收日期：2026-08-26（Asia/Shanghai）  
> 接入协议：`wynai.insight-input/v1`  
> 结论：开发完成，自动化测试与真实浏览器 UAT 通过

## 1. 目标与范围

本次目标是在不增加数据洞察来源分支、不修改 `InsightInput v1` 语义的前提下，让独立问数的成功回答可以进入现有数据洞察工作台，并继续执行二次洞察。

交付范围：

1. 新增独立问数结果适配器，将独立问数私有响应转换为 `InsightInput v1`。
2. 独立问数每轮成功且包含非空结构化结果时，服务端注册标准输入并返回 `insightId`。
3. 在该轮回答标题右侧显示“数据洞察”入口。
4. 点击入口后按 `insightId` 打开对应标准输入，而不是使用会话 ID 或 Wyn `viewId` 查询。
5. 数据洞察列表区分“Wyn 问数”“独立问数”和其他标准输入。
6. 完成协议、幂等、空结果、前端入口、全量回归和真实浏览器截图验收。

不在本次范围：数据库持久化、跨进程恢复、MCP/API 产品化、独立问数历史消息重新加载、数据洞察算法改造。

## 2. 架构设计

```text
独立问数查询内核
  | AIInteractionResponse v1 / InsightDocument v1 / resultSets
  v
IndependentQueryInsightAdapter
  | 剔除私有字段、规范化 Schema/质量/范围/证据
  v
InsightInput v1
  | source.type = independent-query
  | source.sourceId = conversationId:turnId
  v
DataInsightStore -> insightId -> 数据洞察页面与二次洞察生成器
```

数据洞察核心仍只接收标准协议。本次没有让数据洞察识别独立问数的私有响应，也没有在数据洞察算法中增加 `source.type` 分支。

### 2.1 字段映射

| 独立问数数据 | InsightInput v1 | 规则 |
| --- | --- | --- |
| 用户本轮问题 | `title`、`context.question` | 标题最多 200 字符 |
| `conversationId + turnId` | `source.sourceId` | 作为来源幂等键 |
| `traceId` | `source.traceId` | 用于运行追溯 |
| 会话数据集 | `datasets[]` | 保留 ID、名称和 revision |
| `document.scope` | `scope`、顶层 `quality` | 未声明信息保持 unknown |
| `document.evidence` | `evidence` | 最多 100 条 |
| `response.resultSets` | `resultSets` | 最多 8 个结果集、每个最多 5000 行和 100 个字段 |

适配器只保留字段协议允许的 `name/type/role/displayName/sourceField/format/unit/grain`，不会把 `requestId`、`executionPlanId`、`aggregation`、查询表达式或适配器实现细节送入数据洞察。

### 2.2 显示与失败规则

- `status=ok`、存在 `turnId` 且至少一个结果集包含数据行时注册并显示入口。
- 需要澄清、查询失败、取消或空结果时不注册，不显示入口。
- 同一 `conversationId:turnId` 重复注册时复用同一个 `insightId`。
- 适配失败不会破坏原独立问数回答；服务端记录错误，该轮不返回洞察入口。
- 从洞察页点击“发起新问数”会返回本次来源工作区；从 Wyn 问数进入时仍返回 Wyn 问数。

## 3. 实现清单

| 文件 | 变更 |
| --- | --- |
| `lib/data-insights/independent-query-adapter.mjs` | 新增独立问数标准输入适配器 |
| `server.mjs` | 在成功回答后注册标准输入，返回 `response.dataInsight` |
| `public/app.js` | 渲染入口、按 `insightId` 打开、记忆返回工作区、显示来源标签 |
| `public/styles.css` | 回答标题栏入口的桌面与移动端样式 |
| `public/index.html` | 将数据洞察空状态文案改为支持两种问数来源 |
| `test/data-insights.test.mjs` | 新增适配、幂等、空结果和入口测试 |
| `package.json` | 将新适配器加入静态检查 |

服务端成功响应新增可选引用：

```json
{
  "response": {
    "dataInsight": {
      "schema": "wynai.data-insight-reference/v1",
      "insightId": "ins-...",
      "inputSchema": "wynai.insight-input/v1"
    }
  }
}
```

## 4. 自动化测试结果

### 4.1 针对性测试

命令：`node --test test/data-insights.test.mjs`

结果：8/8 通过。其中本次新增 3 项：

1. 独立问数结果与上下文可转换并通过 `InsightInput v1` 运行时校验。
2. 澄清或空结果不注册；同一轮重复注册保持幂等。
3. 前端只有获得 `insightId` 才渲染并处理数据洞察入口。

### 4.2 静态检查与全量回归

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 184/184 通过 |
| 失败、跳过、取消 | 0 |

### 4.3 真实 API 验证

UAT 服务：`http://127.0.0.1:8799/`

| 项目 | 实际结果 |
| --- | --- |
| 数据集 | `AI对话分析-销售数据`，revision 7 |
| 问题 | `总销售额是多少？` |
| 回答状态 | `ok` |
| 标准协议 | `wynai.insight-input/v1` |
| 来源类型 | `independent-query` |
| API 验证 insightId | `ins-5ae1811c-e0cd-4703-ad4f-7e1ad30e59a2` |
| 结果规模 | 1 行 × 1 字段 |
| 原始字段和值 | `revenue = 24613596.800000027` |
| 质量 | exact、非样本、未截断、无告警 |

## 5. 浏览器 UAT

浏览器 UAT 使用同一真实 Wyn 数据集和问题，完整执行“独立问数 -> 回答入口 -> 标准数据洞察 -> 二次洞察”。浏览器运行生成的洞察记录 ID 为 `ins-7f0cdeaa-5b0f-45cf-ac5a-dd1870323796`。

### UAT-01 回答入口

预期：独立问数成功回答的右侧显示“数据洞察”按钮，且回答值正确。

实际：通过。页面显示 `¥24,613,596.8`，按钮位于回答标题右侧。

![独立问数回答右侧的数据洞察入口](test/uat-artifacts/independent-query-data-insight-2026-08-26/01-independent-query-answer-entry.png)

### UAT-02 标准输入详情

预期：点击入口后打开该轮对应记录，来源显示“独立问数”，并显示标准协议、行列数和原始值。

实际：通过。列表来源为“独立问数”；标题为原问题；详情为 1 行 × 1 字段、100% 完整；值为 `24,613,596.8`；页脚显示 `InsightInput v1`。

![独立问数标准输入的数据洞察详情](test/uat-artifacts/independent-query-data-insight-2026-08-26/02-data-insight-standard-detail.png)

### UAT-03 二次洞察

预期：数据洞察生成器能够直接消费独立问数产生的标准输入。

实际：通过。外部模型 `deepseek-v4-flash-0731` 完成二次洞察，读取 1 行 × 1 列、100% 完整的数据，并在报告中引用相同销售额。

![独立问数结果生成二次洞察](test/uat-artifacts/independent-query-data-insight-2026-08-26/03-secondary-insight-generated.png)

## 6. 验收结论

本次开发满足目标：独立问数已经通过 `InsightInput v1` 标准协议接入数据洞察，回答入口、来源识别、详情预览和二次洞察均可用；Wyn 问数现有适配方式没有改变；数据洞察核心协议、存储和生成逻辑无需增加独立问数专属代码。

现阶段保留的已知限制是数据洞察记录仍使用最多 30 条的进程内存储，服务重启后旧 `insightId` 不恢复。这是既有数据洞察限制，不影响本次在线主路径验收；后续如需历史回答长期可进入洞察，应单独增加持久化存储和访问控制。
# 阶段 1 运行模型补充

独立问数产生有效结果后注册标准输入，并关联 `interpret` InsightRun；数据集自主分析使用 `explore` InsightRun。页面通过运行列表和详情展示当前状态，失败运行不可伪装为成功洞察，重试会递增 attempt 并清理旧文档引用。


# 阶段 1 运行模型补充`n`n独立问数产生有效结果后注册标准输入，并关联 `interpret` InsightRun；数据集自主分析使用 `explore` InsightRun。页面通过运行列表和详情展示当前状态，失败运行不可伪装为成功洞察，重试会递增 attempt 并清理旧文档引用。


阶段 4/5/6 补充：独立问数结果进入 interpret，证据不足时可创建 parentRunId 关联的 explore；Skill 诊断 Playbook 和风险规则作为运行元数据保留。

## 2026-08-27 系统性增强收口

正式洞察统一经过 Evidence Pack 与 Planner/Critic/Narrator；统一工作台支持 InsightDocument v1、版本比较、HTML/Markdown/JSON 导出。InsightRun、文档和审计持久化，生成、重试、配额、并发、权限、脱敏、归档恢复和软删除由治理层处理。阶段 5/6 API 与桌面/390x844 移动 UAT 证据见 `DATA_INSIGHT_PHASE5_UAT_REPORT_2026-08-27.md`、`DATA_INSIGHT_PHASE6_UAT_REPORT_2026-08-27.md`。
