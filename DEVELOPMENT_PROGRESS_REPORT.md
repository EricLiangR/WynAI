# 新智能问数开发、测试与 UAT 汇总

> 本文件随每个阶段、测试批次和 Bug 修复持续更新。

> 最近一次回归与用户验收批次：2026-08-24（Asia/Shanghai）。在 2026-08-23 平台语义 50 组基础上，完成高级语义与真正澄清状态增强：自动化测试 128/128；真实 Wyn 高级 UAT 50/50（101 轮）；桌面 50/50、移动 10/10；60 张截图/API 交叉核验 60/60；控制台错误、页面/消息横向溢出和输入区遮挡均为 0。B-010 至 B-028 在各自范围内关闭；外部依赖项继续单独列示。

## 总体状态

| 阶段 | 范围 | 状态 | 当前结论 |
| --- | --- | --- | --- |
| Phase 0 | Wyn 元数据、查询、索引/样本、权限能力验证 | 部分完成 | 管理员元数据、NONE、WAX、分组、月/季/年时间粒度、排序和过滤矩阵已验证；双账号权限和非索引数据集待依赖 |
| Phase 1 | 统一版本化 LLM 交互协议和 InsightDocument | 已完成 | Request/Response/Document v1 规范化器、危险字段拒绝和契约测试已交付 |
| Phase 2 | 独立查询内核、范围标识、审计和测试 | 已完成（首期） | Canonical/Router/Adapter 已执行 Wyn 查询；新增 limitReached/truncationConfidence |
| Phase 3 | 单数据集多轮问数和多元素页面 | 高级语义与澄清范围已完成 | QuestionSemanticFrame v2、BusinessQueryIntent v2、QueryProgram v1、IntentPatch v1、Pending/Committed 状态、同比/环比、分区 TopN、完整年度和 Skill 实体映射已接入；高级 50 组/101 轮及桌面移动截图 UAT 通过 |
| Phase 4 | 结构化 Skills 第一阶段 | 已完成（基础版） | 本地 Skill 加载、作用域/优先级、冲突澄清、Planner/Critic 注入、确定性指标口径和治理 API 已实现；完整可视化管理界面仍待后续 |
| Phase 5 | 生产化增强和高级能力 | 部分完成 | 已交付受控多数据集查询/对齐合并、缓存和预算 POC、Skill 版本治理、请求限流/审计，并完成桌面/移动端 UI 回归；身份代理、分布式存储、向量库和任意 Join 仍按依赖推进 |
| Template Report MVP | 通用 DOCX 模板上传、业务标注、绑定、查询、公式、动态表格/图表、AI 内容协作和 Word 导出 | 已完成 MVP | 真实能耗模板端到端 UAT 通过；网页动态块编辑已接入；ONLYOFFICE/Collabora、复杂文本框/SmartArt 和任意跨数据集 Join 明确留到后续 |

## 阶段交付记录

| 日期 | 阶段 | 开发内容 | 测试/UAT | 结果 | Bug |
| --- | --- | --- | --- | --- | --- |
| 2026-08-22 | Phase 0 | 创建目标计划和 API 能力矩阵；验证指定数据集元数据 | `GET /api/health`、`GET /api/datasets`、`GET /api/datasets/:id/metadata` | 通过：Wyn connected=true，数据集 revision=7、27 个字段、indexed=true | 无 |
| 2026-08-22 | Phase 0 | 直接验证 NONE 数据集查询 | `QueryType=NONE`, `RowLimit=5` | Wyn 返回明细，但发现响应为嵌套 JSON 字符串 | B-001 |
| 2026-08-22 | Phase 0 | 直接验证受控 WAX 概览查询 | `EVALUATE ROW(...)` | Wyn 返回完整概览聚合，但应用解析为 0 rows | B-001 |
| 2026-08-22 | Phase 0 | 修复 Wyn 嵌套 JSON/BOM 解析 | 待重启服务后回归 | 已修复，后续真实回归记录已通过 | B-001 |
| 2026-08-22 | Phase 0 | 真实回归：指定数据集元数据、质量样本、WAX 概览、客户和地区聚合 | 管理员 UAT；`http://127.0.0.1:8792` | 通过：5000 行样本为 `limitReached=true`、`truncationConfidence=possible`；聚合结果返回真实值 | B-001 已关闭 |
| 2026-08-22 | Phase 1 | 新增 `AIInteractionRequest/Response v1`、`InsightDocument v1` 规范化器、JSON Schema 文件及危险字段校验 | 交互契约自动化测试 | 通过：95 项全量测试通过（最新批次） | 无 |
| 2026-08-22 | Phase 2 | 结果范围契约增加 `limitReached` 与 `truncationConfidence`，避免把达到上限误判为已截断 | 查询结果归一化测试、真实 Wyn 回归 | 通过 | 无 |
| 2026-08-22 | Phase 3 | 新增 Smart Query 会话 API、连续追问状态和组合式 InsightDocument | 管理员真实 UAT：创建会话、发送问题、返回 KPI/文本/图表/表格/告警块 | 通过：`wynai.insight-document/v1`，15 个页面块，样本边界已披露 | B-002 已关闭 |
| 2026-08-22 | Phase 4 | 新增结构化 Skill Registry、作用域/优先级解析和指标冲突检测 | Skill 离线契约测试 | 通过：95 项全量测试通过（当前批次） | B-006 已关闭 |
| 2026-08-22 | Phase 0 | 扩展 Canonical 查询能力矩阵 UAT | `npm run uat:phase0:query-matrix`；真实管理员服务 `8810` | 通过：11/11，月/季/年粒度、区域/类别排序聚合、数值字段比较、字符串/数字/日期/in/isNotNull 过滤 | 无 |
| 2026-08-22 | Phase 0 | 多数据集真实目录、语义和查询 UAT | `npm run uat:phase0:multi-dataset`；真实管理员服务 `8818`；销售、实验室、零售三个数据集 | 通过：4/4；元数据读取、实验室按科室总 TAT 聚合、零售按类别销售/利润聚合、全部 `indexed=true` 事实均有证据 | 无 |
| 2026-08-22 | Phase 3 | 会话持久化、结构化筛选继承和 Skill 目录接口 | 跨进程恢复；`GET /api/smart-query/skills`；指定数据集会话 | 通过：恢复历史会话，加载 `sales-baseline@1.0.0`，返回 15 个页面块 | 无 |
| 2026-08-22 | Phase 4 | Skill 注入 Planner/Critic、确定性 fallback 指标选择和运行解析留痕；销售 Skill 示例 | 95 项自动化测试；真实会话 UAT | 通过：Skill 引用进入分析规划和运行审计，组织级冲突夹具真实返回 `needs_clarification` | 无 |
| 2026-08-22 | Phase 2/5 | 多数据集受控查询、对齐合并、缓存预算及 Word 模板 POC | `npm run uat:phase2` | 通过：4/4；明细级 Join、复杂 Word 对象仍明确为限制 | 无 |
| 2026-08-22 | Phase 3/5 | 独立问数结果渲染、图表 ResultSet 绑定和响应式 UI | 桌面浏览器 + 390×844 移动视口；真实管理员会话；移动端表格滚动 | 通过：桌面显示真实 KPI/3 张表格；移动端 14 个结果块、无横向溢出、表格容器可滚动 | B-003 已关闭 |
| 2026-08-22 | Phase 4 | Skill 冲突夹具刷新后真实 UAT 回归 | `npm run uat:phase4`；管理员服务 `8812`；组织请求头 `X-Wyn-Organization-Id=uat-org-conflict` | 通过：3/3，销售 Skill 与组织冲突 Skill 返回 `needs_clarification`，无静默覆盖；请求体伪造组织不会参与解析 | 无 |
| 2026-08-22 | Template Report MVP | 新增 `TemplatePackageRepository`、业务描述到 `BusinessQueryIntent`/Canonical 查询提议、绑定确认、模板版本和审计记录 | `test/template-report.test.mjs`；真实模板 API UAT | 通过：上传解析 274 个 Block，业务描述可生成受控查询；禁止 SQL/WAX 原始 Payload | 无 |
| 2026-08-22 | Template Report MVP | 新增白名单公式 `ratio/change/percentage/difference/sum`、证据链、动态段落/重复表格/交叉表、SVG 图表关系插入 | 自动化测试 95/95；真实运行 UAT | 通过：真实区域聚合、动态表格、交叉表和图表关系均有结构证据；数值来自查询或公式 | 无 |
| 2026-08-22 | Template Report MVP | 新增 AI 内容会话、用户手工编辑/确认和网页动态块工作台 | `npm run uat:template-report`；桌面浏览器；390×844 移动视口 | 通过：模板报告 UAT 5/5；网页无横向溢出、无控制台错误，动态内容确认后可下载 Word | B-005 已关闭 |
| 2026-08-22 | Phase 5 | 新增 Skill 草稿、审批、退役、版本列表、回滚及持久化审计；智能问数会话增加主体上下文、会话访问控制、限流、请求审计和运行解析留痕；公开目录只暴露 approved；管理写操作和审计读取增加令牌门槛；直接 Canonical 查询入口纳入统一治理 | `npm test`；最新服务 `8818`；`test/uat-artifacts/phase5-governance/latest.json`；Phase 3/4 最新冒烟 4/4 | 通过：96/96 自动化测试；治理 UAT 9/9；最新服务 Wyn health 200、未授权审计 503、Phase 3/4 会话冒烟 4/4；仅验证本地服务边界，未宣称 Wyn 权限穿透 | 无 |
| 2026-08-22 | Phase 3 UI | 左侧新增独立“独立问数”入口；原入口更名为“Wyn 问数”；两条工作区和接口标识完全分离 | 桌面浏览器、390×844 移动视口、真实“总销售额是多少？”端到端查询、`npm test` | 通过：独立问数返回 13 个组合结果块；Wyn 问数仍只展示旧 API 工作区；99/99 自动化测试，无控制台错误和横向溢出 | B-007 已关闭 |
| 2026-08-22 | Phase 3 正确性/UX | 新增有限规则问题规划器；覆盖四位年份/去年、TopN、销售额/利润、商品类别、区域和按月追问；独立页面改为聊天消息流 | `npm run check`；`npm test` 106/106；指定销售数据集固定 5 轮 UAT；桌面与 390×844 浏览器 | 限定范围通过：已覆盖的 Top5、2025 年、利润、华东、按月用例正确；不代表多年份、年度粒度、比较和开放表达已通过 | B-008 后因语义覆盖不足重新打开 |
| 2026-08-22 | Phase 3 用户探索 UAT | 验证多年份、年度粒度和“继续按月份”多轮语义 | 真实会话 `conv-5ad7bd7f-498b-4395-b6f5-cb4b9c108ac9`、`conv-567629dd-d028-4ad0-9bcb-405cb929af01`；指定销售数据集 | 失败：两个首轮问题均退化为无时间过滤的全量 scalar `¥24,613,596.8`；后续按月未继承应有的 2023-2025 范围 | B-010 已登记，开放 |
| 2026-08-22 | Phase 3 浏览器截图 UAT | 从左侧独立入口完成桌面/390x844 移动端真实问数；核对多年份、每年、2025 总额、利润追问、按月追问、页面上下文、截图和控制台 | `SMART_QUERY_USER_UAT_REPORT_2026-08-22.md`；`test/uat-artifacts/phase3-semantic-ui/2026-08-22/latest.json`；7 张交付截图；`npm run check`、`npm test`、`npm run uat:phase3` | 用户 UAT 不通过：4 通过、1 有条件通过、4 失败；自动化 108/108、API UAT 4/4 仍通过，证明原测试缺少语义/视觉合理性覆盖 | B-010、B-011 阻断；B-012 至 B-014 开放 |
| 2026-08-22 | 外部 LLM 诊断 | 使用 `.env.local` 执行不含业务数据的真实 DashScope 请求；增加可重复连通 UAT、脱敏产物和底层网络错误诊断 | `npm run uat:llm-connectivity`；`npm run check`；`npm test` | DashScope HTTP 200，模型 `deepseek-v4-flash-0731`，连通 UAT 1/1，自动化 98/98；原 `fetch failed` 来自受限测试执行环境，非账号或配置错误 | E-001 根因已澄清；后续严格业务 UAT 已完成 |
| 2026-08-22 | 严格外部 LLM UAT | 按授权向阿里云 DashScope 发送真实数据集字段语义、受控聚合摘要和报告上下文；执行真实 Planner、Critic 和报告生成；不发送完整明细、WYN Token 或 LLM Key | `npm run uat:llm-connectivity`；`npm run uvt:v2`；`npm run check`；`npm test`；审计 9 个持久化运行 | 通过：连通 `1/1`，严格 UAT `14/14`，自动化 `108/108`；9 个运行全部 `completed`，无 `deterministic-fallback`/`deterministic-critic`，报告模型均为 `deepseek-v4-flash-0731`，未发现 Token/Key/Auth 头泄漏 | E-001、B-009 已关闭；时间戳产物和 `latest.json` 均保留 |
| 2026-08-22 | 全量回归 | 补充 Skill 治理测试：草稿/审批/版本/回滚、请求限流和审计主体边界；增加请求体身份伪造拒绝、请求审计恢复、会话越权、公开目录过滤和 Skill 运行解析测试；补充四份 v1 JSON Schema；直接查询入口治理测试 | `npm test` | 通过：96/96；身份仅接受受信请求头，会话主体隔离，未放宽字符集或权限规则 | B-006 已关闭 |

| 2026-08-22 | E1-E4 平台级意图修复 | 新增版本化 `BusinessQueryIntent v2` JSON Schema、字段语义候选、ConstraintLedger、统一确定性/LLM 意图入口、Canonical 编译和结果意图反向校验 | `npm run check`；`npm test` 113/113；新增 `test/business-query-intent-v2.test.mjs` | 通过：多年份、两位年份、相对年份、按年形状、缺期间拒绝均有自动证据 | B-010 已关闭 |
| 2026-08-22 | E1/E4 时间与多轮状态 | 会话升级为 v2，持久化业务意图、约束账本、业务时区和 SkillRefs；修改式追问只改变显式槽位 | 真实 Wyn 三轮：多年份销售额 → 改成利润 → 只看华东；每轮核对 intent/query/result | 通过：三轮均保留 2023-2025 + year；第三轮只新增华东筛选，语义校验均为 true | B-014、B-015 已关闭 |
| 2026-08-22 | E1/E3 时间准确性 | 结果归一化改用 `Asia/Shanghai` 业务时区归并，Canonical 传递时区及必需期间 | UTC 年界自动化边界测试；真实 Wyn 三年金额对照 | 通过：2023=3,113,839.42，2024=2,924,827.72，2025=858,563.79 | B-011 已关闭 |
| 2026-08-22 | E7 用户体验 | 时间标签按 Schema 粒度本地化；发送后立即清空；阶段、耗时、取消和保留问题重试；桌面/移动对话截图 | 桌面 1440x1000、移动 390x844、控制台 error/warn 检查、取消操作 | 通过：9/9，控制台无错误/警告；证据 `test/uat-artifacts/intent-v2/2026-08-22/latest.json` | B-012 已关闭；B-013 UI 范围关闭 |
| 2026-08-23 | E1-E6 平台语义扩展 | 新增 `QuestionSemanticFrame v1` 和 JSON Schema；扩展类别、商品、城市、省份、总部省份、地区、客户、供应商、员工、支付方式、运货商；分离时间过滤/分组/累计；统一极值排名；原问题约束贯穿 Intent/Query/Result 校验 | `npm run check`；`npm test`；50 条差异化语义矩阵 | 通过：最新 `121/121`；显式指标、业务实体、层级、时间、累计、排名和输出要求均可验证 | B-016、B-017、B-018 已关闭 |
| 2026-08-23 | E6/E7 组合结果准确性 | 多维或多指标结果不再绘制丢失信息的单系列图；指标和维度按用户表述顺序输出 | UAT-042 二维 48 行、UAT-044 双指标 16 行浏览器截图修复回归 | 通过：完整表格，无误导图表；销售额/利润顺序与问题一致 | B-019、B-020 已关闭 |
| 2026-08-23 | 50 组真实 Wyn API UAT | 在指定数据集 revision 7 验证 50 个跨实体、时间、累计、排名、多维、多指标和空结果问题 | `npm run uat:semantic50`；逐条核对 Intent、Canonical、ResultSet 行数/顺序/质量 | 通过：50/50；结果均为非样本、非截断；UAT-049 无数据按预期受控澄清 | 无开放缺陷 |
| 2026-08-23 | 50 组浏览器截图 UAT | 从左侧“独立问数”入口逐条提交 50 个问题，检查用户可见答案、表格、消息流、布局和控制台 | 50 张结果局部图 + 50 张全页面图；`npm run uat:semantic50:verify` | 通过：50/50，控制台错误 0，页面/消息区溢出 0，100 张截图格式、尺寸和唯一哈希有效 | B-021 已关闭 |
| 2026-08-23 | 移动端多轮 UAT | 390x844 连续执行“类别销售额 → 改利润 → 只看华东 → 按月” | 四轮逐次核对指标、维度、2025 年范围、华东筛选和布局截图 | 通过：4/4，约束全部正确继承，控制台错误 0，横向溢出 0 | 无开放缺陷 |

| 2026-08-24 | 高级语义协议 | QuestionSemanticFrame 升级 v2；新增版本化 QueryProgram v1；派生指标、分区排名、基期扩展和投影步骤不允许大模型直接生成 WAX/SQL | 新增 advanced-smart-query 7 项专项；相关回归 20/20 | 通过：协议、编译、执行和显示格式一致 | B-022、B-023、B-024 已关闭 |
| 2026-08-24 | 真正澄清状态机 | Pending/Committed 双上下文、awaiting_clarification、受控 IntentPatch v1、取消待澄清；Skill 将销售经理映射到员工姓名 | 10 组澄清场景，均先澄清后执行；核对原时间/累计/排名未丢失 | 通过：10/10 | B-025、B-026 已关闭 |
| 2026-08-24 | 复合多轮继承 | 筛选追问继承全部复合/派生指标；指标切换重绑派生指标；年/月/季粒度与范围独立继承 | 50 组复杂客户场景，共 101 轮真实 Wyn 查询 | 通过：50/50；首轮问题全部修复后整批重跑 | B-027、B-028 已关闭 |
| 2026-08-24 | 高级桌面/移动 UAT | 从独立问数入口执行同比、环比、组内 TopN、累计、澄清、复合指标与三轮追问；逐场景截图 | 桌面 1440x1000 50/50；移动 390x844 10/10；60 张证据交叉核验 | 通过：控制台/横向溢出/输入遮挡均为 0；60 个唯一哈希 | 无开放缺陷 |
## Bug 台账

| 编号 | 发现阶段 | 严重度 | 问题 | 影响 | 修复 | 回归状态 |
| --- | --- | --- | --- | --- | --- | --- |
| B-001 | Phase 0 | P1 | Wyn 查询响应可能是 JSON-encoded string，`parseJsonText()` 只解析一层 | 所有真实 WAX/NONE 结果可能被当成空结果 | 已修改 `server.mjs`，支持 BOM 和最多两层 JSON 解包 | 已关闭：真实管理员 UAT 通过 |
| B-002 | Phase 3 | P1 | 统一交互契约的 ID 校验不接受数字开头的 Wyn UUID | 会话创建成功但首轮消息被错误拒绝 | ID 白名单调整为字母数字开头，保留连字符 | 已关闭：指定 UUID 会话 UAT 通过 |
| B-003 | Phase 3 | P1 | 确定性分析图表未携带对应 `resultSetId`，组合页面只能显示图表占位而不能读取真实数据 | 会话返回成功但前端图表为空，表格结果引用不完整 | 在探索 artifact 汇聚边界统一补入执行结果集 ID，并增加会话契约回归断言 | 已关闭：真实管理员桌面/移动端 UAT 通过 |
| B-004 | Phase 3/5 | P2 | 新增图表渲染路径调用未定义的 `formatCompactNumber`，在真实图表数据出现后会触发前端运行时错误 | 图表数值标签无法渲染，可能中断结果块绘制 | 在 `renderSmartDocument` 内加入受控 `Intl.NumberFormat` 紧凑格式化和非数值保护 | 已关闭：`npm run check`、95/95 单测及桌面/移动端 UI UAT 通过 |
| B-005 | Template Report MVP | P1 | 网页首次确认绑定时重复编译已有 BusinessIntent，缺少 `datasetIds` 导致绑定失败 | 用户完成提议后无法进入报告运行 | 服务端检测已有 `queryRequests` 时直接复用受控查询；确认不再重复调用语义编译 | 已关闭：浏览器实测可完成绑定、运行和内容确认 |
| B-006 | Phase 4 | P2 | Skill 治理回滚测试使用单字符合法 ID `s`，Registry 最小长度校验错误拒绝 | Skill 回滚和治理全量回归失败 | ID 校验改为首字符加 0-79 个合法字符，仍限制为字母数字和连字符 | 已关闭：`npm test` 95/95 |
| B-007 | Phase 3 UI | P1 | 独立智能问数后端已交付，但前端仅嵌在“AI 数据分析”页面，左侧没有独立入口 | 用户只能看到 Wyn AI 问数页面，无法识别或进入新问数能力 | 新增左侧“独立问数”菜单和专属模式；旧入口明确命名为“Wyn 问数”；缓存版本升级至 v21 | 已关闭：桌面/移动浏览器及真实查询通过，`npm test` 99/99 |
| E-001 | 严格 LLM UAT | P2 | 通用 `fetch failed` 未保留底层网络错误，且受限执行环境失败被误记为 DashScope 不可达 | 容易把执行环境限制误判为 LLM 账号或 `.env.local` 配置错误 | LLM 客户端记录脱敏目标主机、底层错误码和 cause；新增固定文本真实连通 UAT 与持久化产物 | 已关闭：HTTP 200，连通 UAT 1/1，确认账号和配置有效 |
| B-008 | Phase 3 正确性/UX | P1 | 自然语言约束可能未进入查询，失败后仍可能返回与问题不一致的精确数字；前端消息流问题已修复 | 查询成功不等于回答正确；有限固定句式通过不能覆盖真实表达变体 | UI/警告分级部分已完成；查询语义范围扩大为版本化 Planner、约束完整性和结果一致性专项 | 重新打开：纳入 `SMART_QUERY_SEMANTIC_ACCURACY_ENHANCEMENT_PLAN.md` E0-E8 |
| B-009 | 严格 LLM UAT | P1 | 真实 Planner/Critic/报告调用暴露 90 秒超时、DeepSeek reasoning 占满输出导致空正文、Critic 负载过大，以及查询 ID、开放意图、TAT 语境、空分组和组合标签校验不稳定 | 严格运行会超时、产生空报告或因计划/证据格式差异失败，无法形成可信 UAT | 默认超时提高并支持 `LLM_TIMEOUT_MS`；结构化调用关闭 thinking、提高输出上限、限制 Critic 行数；规范查询 ID；补充业务计划校验和分组非空保护；增强组合标签及分组摘要证据校验；UAT 改用 Node HTTP 并修正哈希误报和用例选择 | 已关闭：严格 UAT 14/14，9 个持久化运行全部完成且无回退，108/108 自动化测试通过 |
| B-010 | Phase 3 语义准确性 | P1 | 多年份和年度粒度退化为无过滤 scalar，多轮继承错误 | 构成自信误答 | BusinessQueryIntent v2、TimeSemantics、约束覆盖/结果覆盖校验和年度结果形状不变量 | 已关闭：真实 Wyn 三年结果和 113/113 自动化通过 |
| B-011 | Phase 3 时间准确性 | P1 | Wyn 本地日期序列化为 UTC 后被按 UTC 归并到上月/上年 | 年/月金额错误 | Canonical 显式传递 `Asia/Shanghai`，归并使用业务时区并补年界测试 | 已关闭：自动边界和真实三年 UAT 通过 |
| B-012 | Phase 3 结果 UX | P2 | 图表/表格显示 ISO 时间且标签截断 | 业务结果难读 | 根据结果 Schema grain 本地化为年/季度/月/周/日，完整标签保留 Tooltip | 已关闭：桌面/移动截图通过 |
| B-013 | Phase 3 交互 UX | P2 | 输入延迟清空，慢查询缺阶段、耗时、取消和重试反馈 | 用户误判卡住 | 立即清空、四阶段/耗时、取消按钮、取消后保留问题重试 | UI 范围已关闭；Wyn 上游协作式终止保留为非阻断增强 |
| B-014 | Phase 3 多轮 Skills | P2 | 修改式追问后 SkillRefs 丢失 | 业务口径不稳定 | SkillRefs 纳入 ConversationState v2 并与新一轮解析结果合并 | 已关闭：三轮侧栏持续显示 `sales-baseline@1.0.0` |
| B-015 | Phase 3 多轮时间 | P1 | `只看/仅看` 未被 TimeSemantics 识别为修改式追问，导致年份和粒度丢失 | 第三轮错误变成按日期排名 | 统一对话操作分类覆盖继续/替换/筛选/限定类前缀并补三轮测试 | 已关闭：真实华东三年利润 UAT 通过 |
| B-016 | Phase 3 平台语义 | P1 | 类别、城市、省份、最高、累计等用户显式语义可能在规划过程中静默丢失 | 返回数据真实但回答错误问题 | 新增 `QuestionSemanticFrame v1`，显式语义必须进入 ConstraintLedger 并完成字段映射 | 已关闭：50 条语义矩阵、真实 API 50/50、浏览器 50/50 |
| B-017 | Phase 3 时间语义 | P1 | “过去五年累计”被自动转为年份分组 | 累计问题错误返回逐年序列 | 将时间范围、分组粒度和累计模式建模为独立槽位，仅显式分组词触发时间粒度 | 已关闭：UAT-013、039、041-043 通过 |
| B-018 | Phase 3 结果校验 | P1 | Validator 只验证已生成 Intent，自身无法发现原问题约束被遗漏 | 错误 Intent 可能被标为“已校验” | 建立 QuestionSemanticFrame → Intent → Canonical → ResultSet 的覆盖校验，失败结果不得显示成功答案 | 已关闭：缺约束和空结果均被拦截 |
| B-019 | Phase 3 结果 UX | P2 | 二维或多指标 ResultSet 绘制单系列图，未呈现的信息会被用户误读为不存在 | 图表与完整查询结果语义不一致 | 仅在图表可完整表达结果时绘图，否则展示完整表格 | 已关闭：UAT-042、044 修复截图通过 |
| B-020 | Phase 3 输出契约 | P2 | 多指标列顺序不保持用户问题中的表达顺序 | 阅读顺序与提问不一致 | 指标和维度按问题中首次出现位置稳定排序 | 已关闭：UAT-044 表头回归为订单金额、订单利润 |
| B-021 | UAT 证据 | P3 | 首轮截图实际编码为 JPEG，但文件扩展名为 PNG | 证据工具可能误判格式 | 全部统一为 `.jpg` 并校验编码、尺寸、文件大小和内容哈希 | 已关闭：100/100 截图有效且内容唯一 |
| B-022 | Phase 3 高级排名 | P1 | 多年份 TopN 可能被执行为全局排名 | “每年第一”只返回一个全局冠军 | QueryProgram 增加按 period/业务分区独立排名 | 已关闭：AMT-011 至 020 |
| B-023 | Phase 3 派生指标 | P1 | 同比/环比缺少正确基期或把基期暴露给用户 | 派生值错误或结果范围超出问题 | 按年/月粒度扩展基期，派生后投影用户期间，Schema 标记 percentage | 已关闭：AMT-001 至 010、047 至 050 |
| B-024 | Phase 3 时间语义 | P1 | “每年”被同时当成分组和显式时间范围 | 无明确范围的问题被错误限制 | 时间范围、粒度、完整年度策略分离 | 已关闭：专项和真实 Wyn 回归通过 |
| B-025 | Phase 3 澄清状态 | P1 | 指代不明时缺少 Pending，补充后可能丢原条件 | 澄清不是可靠的多轮状态转换 | Pending/Committed 状态机和 IntentPatch v1；补丁成功后才提交 | 已关闭：AMT-031 至 040 |
| B-026 | Phase 4 业务实体 | P1 | 销售经理无法稳定解析到员工字段 | 经理排名无法查询或需要反复解释 | approved Skill 映射销售经理到员工姓名并保留 SkillRef | 已关闭：AMT-020、021、031、045 |
| B-027 | Phase 3 多轮继承 | P1 | 只看华东等筛选追问可能丢复合或派生指标 | 后续回答偏离首轮问题 | 修改式追问继承全部未显式替换槽位 | 已关闭：复合/派生追问真实回归通过 |
| B-028 | Phase 3 派生重绑 | P1 | 改成利润/再看同比后派生指标可能仍绑定旧指标 | 标题与计算来源不一致 | 派生指标按当前显式指标重绑 source/alias | 已关闭：AMT-011 至 017、047 至 050 |

## 模板报告 MVP 交付明细

### 已实现

- DOCX 标准段落、表格、页眉和页脚解析；显式占位符和跨 `run` 文本替换；稳定 `Block ID`、内容 Hash 和用户业务标注。
- `TemplatePackage v1` 持久化：原始 DOCX、解析 Block、候选识别、绑定、版本和审计事件均保留在 `data/report-templates/`。
- 业务语言 → `BusinessQueryIntent v1` → `CanonicalQueryRequest`：字段、聚合、分组、时间粒度和结果形状由服务端校验，AI/用户不能提交 SQL/WAX/Payload。
- `ReportRun v1`：运行参数、数据集 revision、查询结果集、证据、质量边界、公式版本、内容版本和导出文件记录在 `data/report-runs/`。
- 白名单确定性公式：比例、变化率、占比、差额和求和；除零策略明确，拒绝任意 JavaScript。
- 动态段落、重复/分组表、矩阵表、SVG 图表插入；保留 DOCX ZIP、样式和页眉页脚结构。
- AI 洞察块多轮讨论、用户手工编辑、确认版本和网页动态块工作台；下载接口输出 Word 和审计 JSON。

### UAT 证据

- `test/uat-artifacts/template-report/latest.json`：`5/5 passed`。
- `test/uat-artifacts/template-report/generated-report.docx`：真实模板生成物，未删除。
- `test/template-report.test.mjs`：业务描述、公式、持久化、动态表格、交叉表、SVG 图表关系自动化验证；当前 `npm test` 为 95/95。
- 浏览器实测：桌面工作台和 `390×844` 移动视口均可操作；移动视口 `scrollWidth=375`，未发现横向溢出，控制台无错误。

### 当前遗留

- LibreOffice/`soffice` 未安装，`render_docx.py` 无法生成 PNG；已保留 `test/uat-artifacts/template-report/rendered/` 失败记录。当前使用 OOXML/ZIP 结构校验和 DOCX 重新解析作为替代验证，正式交付环境仍需补充渲染机。
- DashScope 配置、固定文本连通和完整严格外部 LLM UAT 均已通过。授权外发内容限定为字段语义、受控聚合摘要和报告上下文，不包含完整明细、`WYN_TOKEN` 或 `LLM_API_KEY`；系统继续保持严格模式失败，不把确定性 fallback 标成严格成功。
- 固定服务端 `WYN_TOKEN` 的终端用户身份代理、双账号行级权限、非索引数据集精确聚合尚未完成真实依赖验证。
- 首期网页编辑是动态块编辑，不是完整 Office 编辑器；ONLYOFFICE/Collabora、复杂文本框/SmartArt、任意明细级 Join、批量报告和审批流未纳入本次 MVP。

## UAT 验收门槛

| UAT 编号 | 验收项 | 前置条件 | 状态 |
| --- | --- | --- | --- |
| UAT-0-01 | 管理员可读取指定数据集元数据 | Wyn Token 可用 | 通过 |
| UAT-0-02 | NONE 返回明细且保留范围标识 | B-001 回归完成 | 通过：`isSample=true`，`limitReached=true`，`truncationConfidence=possible` |
| UAT-0-03 | WAX 概览返回真实聚合数值 | B-001 回归完成 | 通过：source_rows=6793、total=24613596.8、profit=11855100.8 |
| UAT-0-04 | WAX 分组趋势、区域、类别和客户结果正确 | 分组探针完成 | 通过首期：趋势（月/季/年）、客户/地区/类别已验证；客户深度排名仍受结果上限约束 |
| UAT-0-05 | 过滤、排序、时间粒度语义一致 | 查询矩阵完成 | 通过首期：11/11；空值排序和 Wyn 原生分页仍待外部协议验证 |
| UAT-0-06 | 权限和行级权限不越权 | 受限账号可用 | 未开始 |
| UAT-0-07 | 非索引数据集的精确/样本边界明确 | 第二数据集可用 | 未开始 |
| UAT-1-01 | 版本化交互模型拒绝 SQL/WAX/原始 Payload | Phase 1 契约测试 | 通过 |
| UAT-3-01 | 单数据集会话可连续追问并返回组合页面 | 管理员 Token | 通过 |
| UAT-4-01 | Skill 按作用域和触发词解析，冲突可检测 | Skill Registry 测试 | 通过 |
| UAT-0-08 | Canonical 查询矩阵：时间粒度、排序、字段比较和五类过滤 | `uat:phase0:query-matrix` | 通过：11/11 |
| UAT-3-02 | 会话跨进程恢复、结构化筛选继承 | JSON 会话存储 | 通过 |
| UAT-4-02 | Skill 加载、规划注入、冲突澄清 | `sales-baseline@1.0.0` | 通过 |
| UAT-3-03 | 组合页面真实结果渲染和响应式布局 | 管理员 Token；服务 `8806`；浏览器桌面与 390×844 视口 | 通过：真实表格/指标可见，移动端无横向溢出；证据见 `test/uat-artifacts/phase5-ui/latest.json` |
| UAT-3-04 | 已覆盖的明确问题约束和固定多轮追问保持一致 | 指定销售数据集；服务 `8787` | 有条件通过：仅 Top5、2025 年收入、利润、华东、按月 5 轮固定表达匹配 CanonicalQueryRequest；证据见 `test/uat-artifacts/phase3-conversation/latest.json`，不得外推到全问题域 |
| UAT-3-05 | 独立问数以消息流保留历史且内部诊断不冒充业务警告 | 桌面与 390×844 浏览器 | 通过：消息历史保留、快捷追问和上下文可见、技术警告块为 0、无横向溢出 |
| UAT-3-06 | 多年份、年度粒度和多轮时间范围语义完整 | 指定销售数据集；服务 `8787` | 修复后通过：三年结果、累计/趋势分离和多轮时间继承均正确；修复前失败证据保留 |
| UAT-3-07 | 浏览器截图、用户结果合理性和易用性验收 | 左侧独立入口；桌面与 390x844；真实 Wyn 管理员身份 | 修复后通过：原 9 项 9/9；扩展浏览器 50/50；移动多轮 4/4；修复前失败证据保留在 UAT 报告 |
| UAT-3-08 | 50 组跨实体/时间/排名/组合语义真实 Wyn 验收 | 指定数据集 revision 7；管理员身份；服务 `8787` | 通过：真实 API 50/50，字段/粒度/排序/范围/结果质量均符合预期 |
| UAT-3-09 | 50 组桌面截图和结果合理性验收 | 左侧独立入口；1280x720；真实 Wyn 数据 | 通过：50/50，100 张局部/全景图交叉核验，控制台错误 0，横向溢出 0 |
| UAT-3-10 | 移动端四轮上下文继承 | 390x844；类别销售额 → 利润 → 华东 → 月 | 通过：4/4，指标、维度、时间、筛选正确继承，无溢出 |
| UAT-3-11 | 同比/环比基期扩展、分区 TopN、完整年度和复合多轮 | 指定数据集 revision 7；管理员身份；服务 8787 | 通过：高级真实 Wyn 50/50，共 101 轮；自动化专项 7/7 |
| UAT-3-12 | Pending/Committed 澄清与受控 IntentPatch | 10 组自然语言补充维度场景 | 通过：10/10；补充后原时间、累计、排名和指标保留 |
| UAT-3-13 | 高级桌面/移动截图验收 | 1440x1000 与 390x844；独立问数入口 | 通过：桌面 50/50、移动 10/10、60 张截图/API 交叉核验 60/60 |
| UAT-LLM-01 | 固定文本验证 DashScope 账号、地址和模型连通 | `.env.local` 有效；允许外部网络访问 | 通过：HTTP 200，`1/1`，模型 `deepseek-v4-flash-0731` |
| UAT-LLM-02 | 严格 Planner/Critic/报告使用真实数据语义和聚合证据，任何回退均判失败 | 已取得指定外发授权 | 通过：`14/14`；9 个持久化运行全部完成，无确定性回退或敏感凭据泄漏 |

## 独立问数 UE 对齐验收（2026-08-24）


| 项目 | 结果 |
| --- | --- |
| 界面一致性 | 通过：独立问数采用与 Wyn 问数一致的顶部数据集栏、中央欢迎区、快捷问题卡片和底部输入框布局。 |
| 数据集切换 | 通过：切换至“智慧试验室运营中心数据AI”后，会话重置，右侧上下文和语义目录同步为新数据集。 |
| 完整字段清单 | 通过：指标、维度、时间字段使用完整列表输出，不再以“等 x 项”省略；长内容在右侧栏内纵向滚动，无横向溢出。 |
| 回归检查 | 通过：npm run check、git diff --check 和浏览器控制台错误检查均通过。 |

## 证据文件

- 项目开发计划：[NEW_SMART_QUERY_DEVELOPMENT_PLAN.md](./NEW_SMART_QUERY_DEVELOPMENT_PLAN.md)
- 独立问数语义准确性增强计划：[SMART_QUERY_SEMANTIC_ACCURACY_ENHANCEMENT_PLAN.md](./SMART_QUERY_SEMANTIC_ACCURACY_ENHANCEMENT_PLAN.md)
- 独立问数用户视角 UAT 报告：[SMART_QUERY_USER_UAT_REPORT_2026-08-22.md](./SMART_QUERY_USER_UAT_REPORT_2026-08-22.md)
- Wyn API 能力矩阵：[WYN_API_CAPABILITY_MATRIX.md](./WYN_API_CAPABILITY_MATRIX.md)
- 现有自动化测试：`test/`
- 真实运行记录：`data/analysis-runs/`
- Phase 0 UAT：`test/uat-artifacts/phase0/latest.json`
- Phase 0 查询矩阵：`test/uat-artifacts/phase0/query-matrix-latest.json`
- Phase 0 多数据集：`test/uat-artifacts/phase0/multi-dataset-latest.json`
- Phase 2 UAT：`test/uat-artifacts/phase2/latest.json`
- Phase 3 UAT：`test/uat-artifacts/phase3/latest.json`
- Phase 3/4 增量 UAT：`test/uat-artifacts/phase3-4/latest.json`
- Phase 3 正确性与多轮 UI：`test/uat-artifacts/phase3-conversation/latest.json`
- B-010 真实失败会话：`data/smart-query-conversations/conv-5ad7bd7f-498b-4395-b6f5-cb4b9c108ac9.json`、`data/smart-query-conversations/conv-567629dd-d028-4ad0-9bcb-405cb929af01.json`
- Phase 3 浏览器截图 UAT：`test/uat-artifacts/phase3-semantic-ui/2026-08-22/latest.json` 及同目录 PNG 文件
- Phase 4 UAT：`test/uat-artifacts/phase4/latest.json`
- Phase 5 UI UAT：`test/uat-artifacts/phase5-ui/latest.json`
- Phase 0 查询矩阵：`test/uat-artifacts/phase0/query-matrix-latest.json`（最新 10/10）
- Phase 5 Skill 治理：`test/uat-artifacts/phase5-governance/latest.json`
- 模板报告 UAT：`test/uat-artifacts/template-report/latest.json`
- 模板报告生成 Word：`test/uat-artifacts/template-report/generated-report.docx`
- DashScope 连通 UAT：`test/uat-artifacts/llm-connectivity/latest.json`（固定文本，不含业务数据，1/1 通过）
- 严格外部 LLM UAT：`test/uat-artifacts/strict-llm/latest.json`（`14/14 passed`；时间戳历史产物和 latest 均保留）
- 平台语义 50 组真实 API UAT：`test/uat-artifacts/semantic-50/2026-08-23/api-results.json`（50/50）
- 平台语义 50 组浏览器 UAT：`test/uat-artifacts/semantic-50/2026-08-23/browser-results.json`（50/50，控制台错误 0）
- 100 张截图交叉核验：`test/uat-artifacts/semantic-50/2026-08-23/verification.json`（50/50，100 张唯一）
- 移动端四轮多轮 UAT：`test/uat-artifacts/semantic-50/2026-08-23/mobile-results.json`（4/4）
- 高级语义与多轮 UAT 详细报告：SMART_QUERY_ADVANCED_UAT_REPORT_2026-08-24.md
- 高级 50 组真实 API：test/uat-artifacts/advanced-multiturn-50/2026-08-24/api-results.json（50/50，101 轮）
- 高级桌面/移动浏览器结果：test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/
- 高级 60 张截图交叉核验：test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence-verification.json（60/60）
## 动态后续操作 UAT（2026-08-24）

### 本轮交付

- 移除结果区固定业务快捷操作；仅在真实、非截断结果上按当前数据集元数据、查询计划和会话状态生成最多 3 个后续操作。
- 后续操作采用版本化 `wynai.follow-up-action/v1` 结构，只携带自然语言追问和来源依据；不携带 SQL、WAX 或原始查询 Payload。
- 操作类型为替换指标、增加维度、增加时间粒度和排名；已存在的时间或排名意图不重复建议，样本/截断结果不展示操作。
- 修复自定义字段名参与追问时的语义识别：`员工姓名`、`客户地区`、`检测项目` 等准确映射为可执行的维度意图。

### 验证与验收

| 项目 | 结果 |
| --- | --- |
| 自动化测试 | 通过：`node --test test\\followup-actions.test.mjs test\\question-planner.test.mjs test\\interaction-contract.test.mjs`，15/15。 |
| 静态检查 | 通过：`npm run check`；`git diff --check` 无空白错误（仅有既有 CRLF 提示）。 |
| 浏览器 UAT | 通过：桌面真实服务 `8787`，销售、实验室、零售三个数据集共 10/10；每例均检查结果、操作语义及多轮执行后的可见结果。 |
| 截图证据 | 通过：`test/uat-artifacts/dynamic-followups/2026-08-24/screenshots/uat-01.png` 至 `uat-10.png`；使用可见视口截图避免浏览器 `fullPage` 空白图问题。 |

### 缺陷留痕

| 编号 | 问题 | 处理结果 |
| --- | --- | --- |
| DF-01 | 动态操作生成的自定义目录字段未始终进入正确语义维度。 | 已修复并在销售/实验室 UAT 复验通过。 |
| DF-02 | 当前实验室源数据的 `总TAT` 聚合为负数。 | 非本次 UE/快捷操作范围；保留为数据口径与聚合治理事项，未将其误判为前端或追问问题。 |