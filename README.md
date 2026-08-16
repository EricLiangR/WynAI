# Wyn AI 数据分析应用原型

本项目包含 Wyn AI 问数、问数结果二次洞察，以及基于 Wyn 治理数据集的自主数据分析智能体 V2.1。

Wyn 负责治理后的数据集、语义和查询执行；上层应用负责假设规划、查询需求建模、执行路由、统一结果集、确定性计算、ECharts 图表、证据追踪、LLM 文本生成、运行持久化和正式报告导出。

## 启动

需要 Node.js 18 或更高版本：

```powershell
npm start
```

默认访问 <http://127.0.0.1:8787>。需要局域网访问时设置 `HOST=0.0.0.0`，再通过本机局域网 IP 访问，例如 `http://10.32.209.78:8787/`。

## 配置

本地配置位于 `.env.local`：

```dotenv
WYN_BASE_URL=http://localhost:51980
WYN_TOKEN=your_token
HOST=127.0.0.1
PORT=8787
WYN_VIEW_PROXY_PORT=8788
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_API_KEY=your_llm_key
LLM_MODEL=your_model_name
```

浏览器只访问本应用的 `/api/*`。Wyn Token 和 LLM API Key 只保存在服务端，不进入前端源码、URL、报告或运行记录。

局域网模式还会开放 `WYN_VIEW_PROXY_PORT`（默认 `8788`）供内嵌 Wyn 图表使用。该原型暂未实现用户登录和访问控制，只应在可信内网中开放；生产环境应增加身份认证、HTTPS、请求限流和网络访问白名单。

## V2.1 自主探索流程

1. 读取 Wyn 数据集结构、字段角色、业务描述、同义词和 AI 配置。
2. 用户只选择数据集即可启动；关注方向和筛选均为可选，其中筛选默认折叠。
3. AI Planner 首选生成平台无关的 `CanonicalQueryRequest`；完整计划不合法时，AI 改为选择假设和分析方法，由受控编译器生成 Canonical 请求。任何模式都不允许 AI 生成 WAX、SQL 或 Pivot Payload。
4. Query Router 为聚合需求选择受控 WAX 适配器，为明细样本选择 Dataset NONE 适配器。
5. 所有返回值转换为 `CanonicalResultSet`，显式记录范围、来源、截断和采样状态。
6. 首轮探索路径由问题、数据语义和能力画像共同决定；Critic 根据实际结果决定是否追加下一轮查询，并记录触发结果集和原因。
7. 证据校验同时核对指标、维度、期间与过滤范围；明细样本默认不进入运行持久化。
8. 大模型只能基于白名单证据 ID 组织报告；严格模式校验失败时 run 直接失败，非严格模式才允许明确标记的回退。
9. 运行保存至 `data/analysis-runs/`，报告可导出为独立 HTML、Markdown 或完整分析 JSON。

规划模式含义：

- `ai-planner`：AI 给出完整 Canonical 查询需求，校验通过后执行。
- `ai-guided-planner`：AI 选择假设和分析方法，确定性编译器生成并校验 Canonical 查询需求。
- `deterministic-fallback`：LLM 不可用或计划无效时，由语义能力和问题意图选择受控降级路径。

`deterministic-fallback` 仅用于非严格体验。开发和严格 UAT 中，Planner、Critic、查询或 AI 报告失败都必须使 run 失败；`fallback`、`partial`、warning 和空 AI 报告均不计通过。

当前 V2.1 已通过 `65/65` 自动化测试、`14/14` 真实严格 UAT 和最新 `9/9` run 独立审计。严格 UAT 使用阿里云 DashScope 的 `qwen3-coder-next`；本次已获得授权发送数据集元数据、字段语义、聚合摘要和报告上下文，Token、Key 和完整明细不会发送。

无论采用哪种规划模式，Wyn 负责数据查询执行，确定性程序负责数值计算和证据绑定，AI 不接触 Token、完整明细或底层查询语言。

## 主要接口

- `GET /api/health`：检查 Wyn 连接并显示 LLM 配置状态；LLM 真实连通由 Planner/Critic/报告调用验证。
- `GET /api/datasets`：读取允许分析的 Wyn 数据集。
- `GET /api/datasets/:id/metadata`：读取字段和 AI 语义定义。
- `POST /api/analysis-agent/query-plans/preview`：预览服务端生成的 WAX 白名单计划。
- `POST /api/analysis-agent/runs`：执行完整数据集分析。
- `GET /api/analysis-agent/runs`：读取持久化运行历史。
- `GET /api/analysis-agent/runs/:id`：读取完整运行和证据。
- `GET /api/analysis-agent/runs/:id/report?format=html|markdown|json`：导出正式报告。
- `POST /api/chat`：代理 Wyn AI 问数流式接口。
- `GET /api/analysis-results/:viewId`：读取问数结构化结果集。
- `POST /api/secondary-insights`：对问数聚合结果执行二次洞察。
- `POST /api/analysis-agent/v2/runs`：仅以数据集和可选关注方向启动自主分析。
- `GET /api/analysis-agent/v2/runs`：读取 V2 运行历史。
- `GET /api/analysis-agent/v2/runs/:id`：读取假设、查询、统一结果集、发现和证据。
- `GET /api/analysis-agent/v2/runs/:id/report?format=html|markdown|json`：导出 V2 正式报告。

应用不提供数据源 SQL 接口，也不接受浏览器或大模型提交任意 WAX。所有可执行查询均由服务端依据语义目录和白名单操作生成。

## 测试与验收

```powershell
npm run check
npm test
npm run test:coverage
npm run uvt
npm run uvt:v2
npm audit
```

- 第一阶段目标：[PHASE1_GOALS.md](./PHASE1_GOALS.md)
- 第二阶段目标：[PHASE2_GOALS.md](./PHASE2_GOALS.md)
- UVT 场景：[UVT.md](./UVT.md)
- V2 实施目标：[V2_IMPLEMENTATION_GOALS.md](./V2_IMPLEMENTATION_GOALS.md)
- V2 UAT 结果：[UAT_V2_RESULTS.md](./UAT_V2_RESULTS.md)
- V2.1 产品需求：[PRODUCT_REQUIREMENTS_V2_1.md](./PRODUCT_REQUIREMENTS_V2_1.md)
- V2.1 产品设计：[PRODUCT_DESIGN_V2_1.md](./PRODUCT_DESIGN_V2_1.md)
- V2.1 实施目标：[V2_1_IMPLEMENTATION_GOALS.md](./V2_1_IMPLEMENTATION_GOALS.md)
- V2.1 UAT 结果：[UAT_V2_1_RESULTS.md](./UAT_V2_1_RESULTS.md)

## 当前边界

- 单次分析只使用一个数据集。
- 单个聚合或明细查询最多返回 5,000 行；增长来源查询会自动限制为两个比较期间，避免全历史 TopN 截断。
- 正式 PDF 通过独立 HTML 的打印功能生成。
- 本地 JSON 仓库适合原型与单实例部署；生产多实例需要数据库、权限映射、审计日志和密钥托管。
- 真实 LLM UAT 会把字段元数据、语义描述、聚合摘要和报告上下文发送到配置的外部模型服务；执行前必须确认客户数据外发授权与脱敏策略。
