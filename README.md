# Wyn AI 数据分析应用原型

本项目包含 Wyn AI 问数、问数结果二次洞察，以及基于 Wyn 治理数据集的自主数据分析智能体 V2.1。

Wyn 负责治理后的数据集、语义和查询执行；上层应用负责假设规划、查询需求建模、执行路由、统一结果集、确定性计算、ECharts 图表、证据追踪、LLM 文本生成、运行持久化和正式报告导出。

2026-08-27 智能问数增强：并列地区等同字段多值条件使用受控 `in` 筛选；混合量纲在存在系列维度时支持双轴柱线组合图；三维结果支持分面多面板；高基数分类支持 ECharts dataZoom；用户显式图表类型优先于自动推荐。本期不包含自然语言配色主题。详见 `SMART_QUERY_VISUALIZATION_SEMANTIC_ENHANCEMENT_REQUIREMENTS_DESIGN_AND_UAT_2026-08-27.md`。

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
LLM_TIMEOUT_MS=180000
LLM_ENABLE_THINKING=false
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

当前项目自动化回归为 `108/108`。独立智能问数的真实 UAT 已覆盖 Phase 0 查询矩阵 `11/11`、Phase 0 多数据集 `4/4`、Phase 2 `4/4`、Phase 3/4 `4/4`、模板报告 `5/5`，Skill 治理 UAT `9/9`。DashScope 固定文本连通 UAT `1/1` 和严格外部 LLM UAT `14/14` 均已通过；严格 UAT 的 Planner、Critic 和报告均调用真实模型 `deepseek-v4-flash-0731`，9 个持久化运行全部完成且未使用确定性回退。完整阶段记录见 `DEVELOPMENT_PROGRESS_REPORT.md`。

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
- `POST /api/data-insights/inputs`：按 `InsightInput v1` 注册标准洞察输入并返回 `insightId`。
- `GET /api/data-insights`、`GET /api/data-insights/:insightId`：读取标准洞察输入列表和详情。
- `POST /api/data-insights/:insightId/generate`：对标准结果集执行二次洞察。
- `POST /api/analysis-agent/v2/runs`：仅以数据集和可选关注方向启动自主分析。
- `GET /api/analysis-agent/v2/runs`：读取 V2 运行历史。
- `GET /api/analysis-agent/v2/runs/:id`：读取假设、查询、统一结果集、发现和证据。
- `GET /api/analysis-agent/v2/runs/:id/report?format=html|markdown|json`：导出 V2 正式报告。
- `GET /api/smart-query/skills`：读取已审核的结构化 Skill 目录和版本。
- `POST /api/smart-query/conversations`：创建单数据集或受控多数据集会话。
- `POST /api/smart-query/conversations/:id/messages`：发送多轮自然语言问题，返回 `AIInteractionResponse v1` 和 `InsightDocument v1`；成功且有结构化结果时同时返回标准数据洞察 `insightId`。
- 会话主体应由受信网关写入 `X-Wyn-User-Id`、`X-Wyn-Organization-Id` 请求头；请求体中的同名字段不参与身份解析。
- `GET /api/smart-query/skills/audit`、`GET /api/smart-query/audit`：读取 Skill 变更和问数请求审计。
- Skill 写操作需要配置 `WYN_AI_SKILL_ADMIN_TOKEN`，并在请求头传 `X-Wyn-Skill-Admin-Token`。
- `POST /api/smart-query/query`：执行一个或多个经过校验的 Canonical 查询，并可按声明维度受控合并结果。

协议 Schema 位于 `schemas/`：`AIInteractionRequest v1`、`AIInteractionResponse v1`、`CanonicalQueryRequest v1` 和 `InsightDocument v1`。

应用不提供数据源 SQL 接口，也不接受浏览器或大模型提交任意 WAX。所有可执行查询均由服务端依据语义目录和白名单操作生成。

## 测试与验收

```powershell
npm run check
npm test
npm run test:coverage
npm run uvt
npm run uvt:v2
npm run uat:llm-connectivity
npm run uat:phase0
npm run uat:phase0:query-matrix
npm run uat:phase0:multi-dataset
npm run uat:phase2
npm run uat:phase3
npm run uat:phase4
npm run uat:phase3-4
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
- 单个聚合或明细查询最多返回 20,000 行；增长来源查询会自动限制为两个比较期间，避免全历史 TopN 截断。
- 正式 PDF 通过独立 HTML 的打印功能生成。
- 本地 JSON 仓库适合原型与单实例部署；生产多实例需要数据库、权限映射、审计日志和密钥托管。
- 真实 LLM UAT 已按授权把字段元数据、语义描述、受控聚合摘要和报告上下文发送到阿里云 DashScope；不发送完整明细、`WYN_TOKEN` 或 `LLM_API_KEY`。后续使用其他客户数据时仍须单独确认数据外发授权与脱敏策略。
- 新智能问数的统一协议、会话和 Skill 设计记录见 [NEW_SMART_QUERY_DEVELOPMENT_PLAN.md](./NEW_SMART_QUERY_DEVELOPMENT_PLAN.md)；阶段开发、测试、UAT 和 Bug 台账见 [DEVELOPMENT_PROGRESS_REPORT.md](./DEVELOPMENT_PROGRESS_REPORT.md)。
- 数据洞察平台稳健性增强需求、设计和 UAT 见 [DATA_INSIGHT_PLATFORM_ROBUSTNESS_REQUIREMENTS_DESIGN_UAT_2026-08-28.md](./DATA_INSIGHT_PLATFORM_ROBUSTNESS_REQUIREMENTS_DESIGN_UAT_2026-08-28.md)。
- 数据洞察平台稳健性增强已完成 ROB-01~ROB-09：`npm test` 233/233、`npm run check` 和 `npm run check:insight` 通过；固定服务地址为 `http://127.0.0.1:8787/`。真实高维结果支持 InsightDocument 正常生成和明确的确定性 degraded 降级，UAT 证据见 `test/uat-artifacts/data-insight-robustness-2026-08-28/`。
## Windows 发布包

项目可以构建为包含 Node.js、生产依赖和 WinSW 的 Windows x64 ZIP。目标服务器不需要安装 Node.js，也不需要执行 `npm install`。

```powershell
.\build-windows-package.bat 1.0.1
```

或者直接运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows-package.ps1 -Version 1.0.1
```

产物位于 `release/windows/`。构建流程会执行语法检查、自动化测试、生产依赖安装、ZIP 校验，以及从 ZIP 解压后的启动/存活/停止冒烟测试。

发布包的部署配置位于 `config/wynai.env`，首次启动或安装服务时从模板创建。`config` 和 `data` 是持久化目录，升级时不得覆盖。
