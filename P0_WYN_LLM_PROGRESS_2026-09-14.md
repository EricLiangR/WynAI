# P0 Wyn 能力与 LLM 稳定性阶段报告

日期：2026-09-14  
阶段：P0-A Wyn 能力与结果边界、P0-B LLM 调用链稳定性  
状态：本阶段代码、自动化测试和真实浏览器关键路径已完成验收

## 1. 验收范围与边界

- UAT 数据集固定为 `18b86197-65e3-4682-8501-6e7125afad02`（01测试销售订单-09）。
- 权限穿透、非索引数据集精确聚合和 Wyn 原生分页不属于本项目后续计划；本阶段不修改 Wyn 权限逻辑。
- 不使用业务 fallback。LLM 或证据校验失败时，系统只能有限重试、澄清或返回结构化失败，不能生成伪造的业务答案。
- 本阶段验证的是平台通用能力，不针对销售字段增加特殊查询逻辑。

## 2. 目标与结果

| 目标 | 结果 | 证据 |
|---|---|---|
| Wyn 数据集元数据和查询链路可用 | 通过：revision 5、86 字段、`indexed=true` | 8787 `/api/datasets/{id}/metadata` |
| WAX 聚合可执行并可交付 | 通过：返回 89 个产品分组 | [WAX 聚合截图](.local-browser-screenshots/codex-iab-wax-aggregate-89-groups-2026-09-14.png) |
| 空结果可识别且不伪造数据 | 通过：`records=0`，页面显示空结果 | [空结果截图](.local-browser-screenshots/codex-iab-fy26-empty-result-2026-09-14.png) |
| 统一 20,000 行应用交付上限 | 通过：底层 28,618 行时交付 20,000 行，第一页 100 行、共 200 页 | [第 1 页](.local-browser-screenshots/codex-iab-20000-limit-page-1-2026-09-14.png)、[第 2 页](.local-browser-screenshots/codex-iab-20000-limit-page-2-2026-09-14.png) |
| 原始明细不聚合、不去重 | 通过：路由 `mode=detail`，适配器 `wyn-dataset-none-json`，重复记录保留 | [明细截图](.local-browser-screenshots/codex-iab-detail-none-20000-2026-09-14.jpg) |
| LLM 连通性与连续稳定性 | 通过：10/10，`retries=0`、`fallbacks=0`，平均 1,212.1ms | `uat-p0-health-monitor.json`、`uat-llm-connectivity-evidence/latest.json` |
| 真实 LLM 洞察链路 | 通过：Planner、Critic、Narrator 全部完成，`provider=llm-orchestrated`，无 fallback | `ins-6c7907d7-6fc0-4f28-ac5f-c7cff469bc11` 的运行证据 |

## 3. 已实施的平台修复

### 3.1 明细查询协议

BusinessQueryIntent v2 新增可选 `queryMode`：`aggregate` 或 `detail`。旧意图未声明时默认 `aggregate`，保持兼容。用户明确要求原始记录、不聚合、不去重或保留重复时，Planner 必须生成 `detail`。

`detail` 模式约束如下：

- 原始字段进入 `dimensions`，不伪装成指标；
- 禁止 `metrics`、`derivedMetrics` 和 `ranking`；
- 不注入内部 `countRows` 或 `distinctCount`；
- Canonical 查询编译为 `mode=detail`，固定路由到 Wyn `QueryType=NONE`；
- 交付层保留 20,000 行上限、前端分页和样本/截断边界。

相关实现：`schemas/wynai.business-query-intent.v2.schema.json`、`lib/semantics/business-query-intent.mjs`、`lib/conversation/question-planner.mjs`、`lib/llm/exploration-agent.mjs`。专项测试 `test/detail-query-mode.test.mjs` 通过。

### 3.2 Narrator 交付稳定性

修复了 Narrator 将内部证据预览 `preview.returnedRows`误写成用户交付行数的问题。Narrator 只能使用对用户交付契约可验证的数量；受限结果必须说明已交付行数和总数未知/是否截断。最多进行 3 次 LLM 尝试（初次生成加两次结构修复），每次修复绕过缓存；全部失败时返回错误，不返回固定业务摘要。

### 3.3 未知总数保持未知

修复 `Number(null) === 0` 导致的错误转换。`sourceTotalRowCount == null` 时，结果和 trace 中的 `totalRowCount/totalRows` 保持 `null`，不把未知总数解释为零。

### 3.4 可观测性和健康探针

`query.executed` 记录 `adapter`、`adapterVersion` 和 `quality`；健康探针支持固定样本数，便于重复验证成功率、延迟、重试和 fallback。真实成功 trace 为 `trace-753cde0b-6dc3-4769-b4b5-a7c9fa750a8e`，其关键事实为：`mode=detail`、`limit=20000`、`isSample=true`、`isTruncated=true`、`totalRowCount=null`、`returnedRowCount=20000`。

同时将输入中的 `capabilityCoverage` 登记为正式系统证据，避免 Critic 因证据目录遗漏而误报引用不存在；专项编排测试 20/20 通过。

## 4. 自动化与浏览器验收

| 检查项 | 结果 |
|---|---:|
| `npm run check` | 通过 |
| `npm test` | 428/428 通过 |
| `test/detail-query-mode.test.mjs` | 4/4 通过 |
| `test/v2-query-contract.test.mjs` | 17/17 通过 |
| `narration-delivery.test.mjs` | 10/10 通过 |
| LLM 连续健康探针 | 10/10 通过 |

浏览器证据来自 Codex 内置浏览器访问真实 `http://127.0.0.1:8787/`，不是 API 响应截图或隔离浏览器截图。已验收 WAX 聚合、空结果、20,000 行边界、翻页和 NONE 原始明细五条关键路径。

## 5. 项目范围决策

| 能力 | 当前状态 | 原因/下一步 |
|---|---|---|
| 真实用户权限穿透 | 项目范围外 | 不纳入后续开发、验证或发布门禁；继续使用现有 Wyn 权限边界 |
| 非索引数据集精确聚合 | 项目范围外 | 不纳入后续开发、验证或发布门禁 |
| Wyn 原生分页协议 | 项目范围外 | 不纳入后续开发、验证或发布门禁；Smart Query 只维护已验收的应用前端分页 |
| Arrow 性能路径 | 暂不处理 | 不属于本次范围，JSON 路径满足当前阶段 |

特别说明：20,000 行是当前平台和 Smart Query 的统一应用交付上限。超过该上限时系统必须明确提示结果受限；这不等同于已经证明 Wyn 原生支持任意页码分页。当前页面的 100 行/页、200 页展示是前端分页。

## 6. 阶段结论

P0-A 的已验证 Wyn 聚合、空结果、NONE 明细、20,000 行交付边界和前端分页，以及 P0-B 的 LLM 连通与真实洞察成功链路均达到本阶段目标。没有发现需要新增销售业务查询逻辑的平台缺陷。

后续工作不再围绕上述三项外部依赖展开。本阶段不以 fallback 作为任何成功结论；后续优先推进语义评测、LLM 长期稳定性监控、结果契约和用户体验优化。
