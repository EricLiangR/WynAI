# 数据洞察可组合平台迭代报告（2026-08-29）

## 结论

本轮完成阶段 1-6 的首轮平台化收口：输入继续以调用方聚合结果为准；合理规模结果完整进入 Evidence Pack；高基数结果改为可追溯分块清单，不再头尾采样；Skill 能力通过 `config/insight-skills/*.json` 配置；Planner/Critic 具备核心/扩展/可选分层和逐项状态；`completed-partial` 在 API 与页面展示未完成项及原因；LLM 不可用时保持真实失败，不生成 deterministic fallback。

## 实施项

- `lib/data-insights/llm-orchestrator.mjs`
  - 聚合结果超过 500 行时输出 `chunked-summary-all-rows` 分块清单，记录 chunkCount、offset、rowCount 和全字段统计。
  - Evidence Catalog 对聚合 rows 使用同一分块规则，不再递归压缩为 12 条头尾样本。
  - Planner 归一化 `coreHypotheses`、`extendedHypotheses`、`optionalHypotheses`、`planningMode`。
  - Critic assessment 增加 priority、blocking、evidenceIds；部分完成诊断增加逐项原因。
- `config/insight-skills/sales-baseline.json`
  - 承载销售 Skill 的核心/扩展方法、字段依赖、证据依赖、阻断规则、部分完成规则和业务语义。
- `server.mjs`
  - 启动时加载可配置 Insight Skill profile。
  - `completed-partial` 文档 block 返回 `incompleteItems`。
- `public/app.js` / `public/styles.css`
  - 页面逐条展示未完成分析项、优先级和原因。

## 自动化验收

- `npm test`：278/278 通过。
- `npm run check`：通过。
- 新增高基数测试：1,581 行聚合结果保留 1,581 行，LLM 编排输入包含 `chunked-summary-all-rows` 和 `chunkCount`，不包含 `bounded-summary`。

## 8787 本地 UAT

服务地址：`http://127.0.0.1:8787/`。

1. `GET /api/health`：Wyn 连接正常；LLM Gateway 当前 `unhealthy`，原因是运行上下文禁止连接 DashScope 443。
2. `POST /api/data-insights/inputs`：标准 `wynai.insight-input/v1` 注册成功。
   - UAT Insight ID：`ins-428cf529-5374-49a2-bd9c-5599874c65dd`
   - 结果范围：2024-01 至 2024-06，共 6 行，销售额/利润中文字段保持不变。
3. `GET /api/data-insights/{id}/diagnostics`：返回 11 个有序事件，包含输入、运行、Evidence Pack、Gateway、阶段和最终结果。
4. `POST /api/data-insights/{id}/generate`：返回 `502`、`status=failed`、`error.code=LLM_CIRCUIT_OPEN`；诊断中保留底层 `LLM_REQUEST_FAILED` 和 `connect EACCES ...:443`，`fallbacks=0`，未生成洞察文档。

浏览器截图证据：

- [平台标准输入与洞察工作台（PC）](D:\工作计划\20251210-AIGC\WynAI\uat-platform-composable-desktop-20260829.png)
- [平台标准输入与洞察工作台（移动端 390×844）](D:\工作计划\20251210-AIGC\WynAI\uat-platform-composable-mobile-390x844-20260829.png)
- [已有真实洞察正文（PC）](D:\工作计划\20251210-AIGC\WynAI\uat-platform-composable-real-insight-content-1280x720-20260829.png)
- [已有真实洞察结果页（PC）](D:\工作计划\20251210-AIGC\WynAI\uat-platform-composable-real-insight-1280x720-20260829.png)

## UAT 判定

| 验收项 | 结果 | 说明 |
|---|---|---|
| 平台协议与输入边界 | 通过 | 标准输入注册、字段类型、调用方范围均生效 |
| Evidence Pack 全量/分块 | 通过（自动化） | 1,581 行覆盖测试通过；真实外部 LLM 分块运行待网络上下文 |
| Skill 可配置能力 | 通过（本地） | profile 从配置目录加载；`skills/` 重解析路径未直接修改 |
| Planner/Critic 分层与部分完成 | 通过（自动化） | 核心/扩展逐项状态和原因可序列化 |
| LLM 正常路径正文 | 待外部网络 | 当前进程无法连接 DashScope，不能伪造通过 |
| LLM 失败路径与禁止降级 | 通过 | 真实返回 failed，熔断/重试/底层错误均留痕 |
| PC/Mobile 正文截图 | 待外部网络 | 当前无法产生真实 LLM 洞察正文截图 |

## 后续门禁

待在允许访问已配置 Provider 的 `8787` 运行上下文重新执行：

- 真实 LLM Planner/Critic/Narrator 三阶段成功；
- 728 行和 1,581 行高基数数据的分块运行；
- `completed-partial` 页面正文与逐项 warning 截图；
- PC 1280×720 和移动 390×844 截图、控制台错误检查；
- 更新最终平台 P2、模块 M3 UAT 报告。

## 上下文预算修复（本轮继续）

- `lib/data-insights/evidence-pack.mjs`：预算视图不再重复计入 `statistics.derived` 的逐项派生证据，只记录总数和有界传输数量。
- `lib/data-insights/llm-orchestrator.mjs`：Planner/Critic/Narrator 共用有界 Evidence Catalog；大数组只发送全量统计摘要，结果集仍以 `chunked-summary-all-rows` 保留行数、分块范围和字段统计。
- Planner 目录窗口支持 32/16/8/4 自适应收缩，只有在最小窗口仍超出 `maxTokens` 时才返回 `LLM_CONTEXT_LIMIT`。
- Critic/Narrator 复用 Planner 最终目录窗口，避免后续阶段再次膨胀。
- 真实候选 `ins-17d194e3-a43b-4094-81e9-aa5b81dbde89` 离线编排验证：1,581 行、7 字段，Evidence Pack 估算 2,215 tokens，Planner 实际请求约 17,438 tokens，Planner/Critic/Narrator 三阶段均完成。
- `npm test`：278/278 通过；`npm run check`：通过。
- 重启后的普通受限进程真实探针仍返回 `EACCES:443`，因此本轮外部网络 UAT 不能标记通过；需在允许 Node 出站到 `dashscope.aliyuncs.com:443` 的同一 `8787` 进程上下文重新执行。
