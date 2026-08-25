# 独立问数意图规划性能需求与设计

> 版本：1.0
>
> 日期：2026-08-25（Asia/Shanghai）
>
> 状态：性能基线已实现；路由策略已由准确性优先风险分级方案修订
>
> 适用范围：左侧“独立问数”入口的单数据集自然语言规划链路

## 0. 后续风险路由修订（2026-08-25）

本文件记录的性能基线仍有效，但“只要确定性意图完整就一律不调用 LLM”已被准确性优先的风险分级路由取代。低风险完整问题继续使用快路径；同比、环比等派生指标属于中风险，优先调用 LLM 并接受确定性约束校验；高风险必须通过联合校验。最新规则以 SMART_QUERY_RISK_ROUTING_LEARNING_REQUIREMENTS_AND_DESIGN.md 为准。


## 1. 背景与问题

用户问题“过去五年，每年的销售收入和同比增长率”已经被确定性语义层完整解析为：2021-2025、按年、销售收入、同比增长率、同比基期扩展及结果期间投影。原实现仍以“复杂度 >= 3”为条件强制调用通用大模型，并沿用 LLM_TIMEOUT_MS=180000。大模型在 180 秒内无响应后，服务才回退到早已可用的确定性计划。

生产证据：

| 请求 | 耗时 | 实际状态 |
| --- | ---: | --- |
| request-audit-272979de-86be-4143-ae0b-eb03c86ad2d0 | 180351ms | HTTP 200，超时后确定性回退 |
| 同类复杂请求 | 180018ms | HTTP 200，超时后确定性回退 |
| 同类复杂请求 | 180011ms | HTTP 200，超时后确定性回退 |

这不是 Wyn 数据查询慢。主要时间消耗发生在查询前的意图大模型等待；前端原四段提示又按计时器轮换，并不代表后端真实执行阶段。

## 2. 目标与非目标

### 2.1 目标

1. 确定性意图已经完整且通过约束覆盖校验时，不调用意图大模型。
2. 模糊问题仍可使用大模型辅助解析，但不得沿用报告生成的 180 秒预算。
3. 外部意图模型连续失败时快速降级为受控澄清，不让每位用户重复等待。
4. 用户取消浏览器请求时，中断服务端正在进行的意图模型调用。
5. 响应和请求审计记录规划路径、规划耗时、是否调用大模型及其耗时。
6. 页面只显示真实可证明的等待状态，不伪装成后端阶段遥测。

### 2.2 非目标

- 不取消大模型在模糊、别名未知或约束不完整问题中的辅助作用。
- 不允许大模型直接生成 SQL、WAX 或任意查询 Payload。
- 本次取消传播覆盖意图模型等待；Wyn 查询执行的协作式取消仍取决于后续接口能力。
- 不改变 BusinessQueryIntent、CanonicalQueryRequest、QueryProgram 或 VisualizationSpec 的版本契约。

## 3. 功能需求

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| LAT-R01 | 完整确定性意图快路径 | status=supported、约束覆盖有效且无必需未决约束时，llmAttempted=false |
| LAT-R02 | 意图专用超时 | 新增 INTENT_LLM_TIMEOUT_MS，默认 10000ms；不影响报告/探索大模型的 LLM_TIMEOUT_MS=180000 |
| LAT-R03 | 意图熔断 | 同一意图模型实例连续失败 2 次后打开 60 秒熔断，熔断期直接返回确定性澄清 |
| LAT-R04 | 受控回退 | LLM 超时、网络、JSON、覆盖或编译失败时，只能返回已校验确定性计划/澄清 |
| LAT-R05 | 取消传播 | 浏览器取消 -> HTTP 连接关闭 -> AbortSignal -> planQueryIntent；取消审计状态为 499 |
| LAT-R06 | 可观测性 | 响应带 planningDiagnostics；审计带 plannerMode/planningDurationMs/llmAttempted/llmDurationMs |
| LAT-R07 | 等待体验 | 显示“正在提交问题/正在处理业务问题/服务仍在处理/可以取消重试”，不声称正在执行具体后端阶段 |
| LAT-R08 | 正确性不回退 | 同比查询仍扩展 2020 基期，计算后只投影用户要求的 2021-2025；输出 5 行销售收入与同比 |

## 4. 路由设计

    自然语言问题
      -> 确定性 BusinessQueryIntent
      -> 约束覆盖校验
         -> 完整：deterministic-fast-path -> Canonical -> Wyn -> QueryProgram -> 结果校验
         -> 不完整：
            -> 熔断已打开：deterministic-clarification
            -> 熔断未打开：意图 LLM（默认最多 10 秒）
               -> 输出通过覆盖与编译校验：hybrid-llm-validated
               -> 失败：deterministic-clarification，并累计失败次数

快路径资格由语义完整性决定，不再由问题复杂度决定。问题可以复杂，只要指标、维度、时间、筛选、排名、派生指标和必需约束已经被完整解析，就没有理由为相同结论额外等待大模型。

## 5. 组件设计

### 5.1 question-planner.mjs

- deterministicPlanIsComplete() 统一判断快路径资格。
- plannerResult() 统一返回规划模式和耗时诊断。
- 每个 LLM 实例使用 WeakMap 保存失败计数和熔断截止时间。
- 取消错误不参与普通降级，直接向上传播，避免后台继续运行。

### 5.2 exploration-agent.mjs

- 内部超时和调用方取消合并到同一 AbortController。
- 内部超时返回 LLM_TIMEOUT；用户取消返回 REQUEST_ABORTED。
- planQueryIntent() 接受并传递 signal。

### 5.3 session.mjs 与 server.mjs

- 会话将 HTTP 请求 signal 传给规划器。
- 服务端为意图规划创建独立 LLM 客户端，读取 INTENT_LLM_TIMEOUT_MS。
- 客户端连接关闭时终止意图模型；请求审计记录 499。
- 成功、澄清和结果校验失败响应均保留 planningDiagnostics。

### 5.4 public/app.js

页面等待提示仍显示累计秒数和取消按钮，但不再通过固定 4 秒间隔伪造“语义校验、Wyn 查询、组织回答”等后端阶段。未来若需要精确阶段，必须由服务端事件流或真实阶段遥测驱动。

## 6. 配置与观测

    LLM_TIMEOUT_MS=180000
    INTENT_LLM_TIMEOUT_MS=10000

/api/health 公开安全的 intentLlmTimeoutMs，不公开 Key。每条问数审计至少包含：

- plannerMode
- planningDurationMs
- llmAttempted
- llmDurationMs
- durationMs
- HTTP status

## 7. 测试与验收

### 7.1 自动化

- 精确问题使用永不返回的 Mock LLM，断言 LLM 调用次数为 0。
- 校验 2021-2025、年度粒度、销售收入、同比别名和 2020 基期扩展。
- 连续两次模拟 LLM 超时，第三次断言熔断且不调用 LLM。
- 调用方取消断言返回 REQUEST_ABORTED。
- 请求审计断言保存规划模式和各阶段耗时。
- 全量自动化：145/145；npm run check、git diff --check 通过。

### 7.2 真实 Wyn 与浏览器 UAT

| 用例 | 结果 | 服务端证据 |
| --- | --- | --- |
| UAT-LAT-001：过去五年，每年的销售收入和同比增长率 | 通过：2021-2025 共 5 行，收入和同比正确，自动组合图 | API 379ms；审计 353ms；规划 7ms；LLM 0 次 |
| UAT-LAT-002：同会话追问“只看华东” | 通过：保留五年/年度/收入/同比，只新增 客户地区=华东 | 审计 270ms；规划 1ms；LLM 0 次 |
| UI 结果验收 | 通过：回答、详情、组合图、图表切换、明细、上下文和多轮消息可见 | 3 张 1280x720 截图 |

截图目录：test/uat-artifacts/intent-latency-2026-08-25/。

## 8. 上线结论

原 180351ms 请求已降至真实 API 379ms，同口径服务端审计为 353ms，减少约 99.8%。结果语义、同比计算、多轮继承和组合图均保持正确。该性能项可以关闭；后续重点监控 P95/P99、Wyn 查询耗时拆分及 499 取消率。
