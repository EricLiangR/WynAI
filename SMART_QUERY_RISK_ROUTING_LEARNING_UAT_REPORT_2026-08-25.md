# 独立问数风险路由、反馈学习与跨行业治理 UAT 报告

> 版本：1.0
>
> 日期：2026-08-25（Asia/Shanghai）
>
> 服务：http://127.0.0.1:8787
>
> 数据集：2b445034-38fe-4350-9cab-b7684c28b5f8
>
> 最终结论：通过

## 1. 验收范围

本轮一次性交付并验收以下七项平台能力：

| 编号 | 能力 | 交付结论 |
| --- | --- | --- |
| R1 | 统一风险分类 | 已完成 wynai.planning-risk-assessment/v1，输出 low/medium/high、分数、原因和执行策略 |
| R2 | 风险分级 LLM 路由 | 已完成低风险快路径、中风险 LLM 复核、高风险强制校验与失败边界 |
| R3 | 确定性/LLM 双重校验 | LLM 仅返回 BusinessQueryIntent；字段、约束、编译与结果仍由受控程序校验 |
| R4 | 全链路日志与回放 | 同一 traceId 串联请求、Skill、规划、Wyn 查询、校验、回答和反馈；支持顺序回放与脱敏 |
| R5 | 用户反馈学习闭环 | 正向反馈形成评测候选；口径错误形成 Skill 规则候选；均须人工审核，不自动发布 |
| R6 | 跨行业 Skill 治理 | 销售、实验室、零售三个 approved 基线 Skill；draft/retired 不进入生产解析 |
| R7 | 跨行业评测包 | 建立销售、实验室、零售 v1 评测包；销售已审批，实验室和零售等待业务负责人确认黄金答案 |

“越运行越聪明”在当前版本中的含义是：系统自动积累可追溯的反馈、候选规则和评测用例，再由治理流程审核发布。系统不会让单个用户反馈直接修改生产口径或查询行为。

## 2. 自动化与真实 API 验收

| 验收层 | 命令/范围 | 结果 |
| --- | --- | --- |
| 全量自动化 | npm test | 153/153 通过 |
| 静态检查 | npm run check | 通过 |
| 风险学习专项检查 | npm run check:risk-learning | 通过 |
| 真实 Wyn API | npm run uat:risk-learning | 6/6 通过 |
| 日志脱敏与恢复 | 单元测试 + 持久化重载 | 通过；token/API key/password/secret 按键名脱敏 |
| Skill 生产隔离 | approved/draft 解析测试 | 通过；仅 approved 参与生产 |
| 学习候选隔离 | 反馈、审核、生产 Skill 数量比较 | 通过；审核候选不自动发布 Skill |

真实 API 关键结果：

- 低风险“2025年销售收入总额是多少”：858,563.79，deterministic-fast-path，未调用 LLM。
- 中风险“过去五年，每年的销售收入和同比增长率”：hybrid-llm-validated，调用 LLM 后通过原问题约束校验。
- 五年结果：2021 2,989,215.73 / -1.87%；2022 2,992,383.95 / 0.11%；2023 3,113,839.42 / 4.06%；2024 2,924,827.72 / -6.07%；2025 858,563.79 / -70.65%。
- 用户口径纠正生成 pending_review 的 skill-rule 候选；管理员拒绝 UAT 候选后生产 Skill 数量保持 4，不发生自动发布。

API 证据：test/uat-artifacts/risk-learning-2026-08-25/latest.json。

## 3. 浏览器 UAT 与截图分析

环境：1280×720，左侧“独立问数”入口，真实 Wyn 数据查询。

| 证据 | 用户操作 | 可见验收结果 |
| --- | --- | --- |
| risk-learning-final-01-entry.png | 进入独立问数 | 独立入口、数据集选择、右侧上下文和语义目录均可见；无内容重叠 |
| risk-learning-final-02-low-risk.png | 提问 2025 年销售收入总额 | 回答、详情、KPI、动态追问和反馈控件完整；结果为 858,563.79 |
| risk-learning-final-03-positive-feedback.png | 点击“有帮助” | 页面内显示“已进入待审核学习队列”，无需离开对话 |
| risk-learning-final-04a-medium-yoy-chart.png | 连续追问过去五年收入和同比 | 柱线组合图正确展示销售收入与同比双轴趋势；2025 年显著下降与数据一致 |
| risk-learning-final-04-medium-yoy.png | 查看五年明细 | 2021–2025 五行数值和同比百分比完整可读 |
| risk-learning-final-05-correction-editor.png | 点击“口径有误”并输入纠正 | 页面内展开文本编辑器、提交和取消按钮；不再调用不受支持的 prompt() |
| risk-learning-final-06-correction-submitted.png | 提交口径纠正 | 回答区显示反馈已进入待审核队列 |

可用性与布局检查：

- ECharts Canvas：1 个，尺寸 515×300，非空。
- body/root clientWidth 与 scrollWidth 均为 1280，无横向溢出。
- 新建干净浏览器页面复验“理解有误 → 输入纠正 → 提交反馈”，控制台 error/warn 为 0。
- 七张截图均已逐张视觉检查；没有按钮、文字、图表、表格或输入框重叠。

## 4. 截图与日志交叉回放

| 截图场景 | traceId | 风险/路由 | 回放结果 |
| --- | --- | --- | --- |
| 低风险答案与正向反馈 | trace-94f199ef-6a5e-4c23-a0b4-b7d47dadf0e9 | low / deterministic-fast-path | 10 个事件，含 feedback.received |
| 五年收入与同比 | trace-7360db11-7554-4863-9327-89aa57a32df8 | medium / hybrid-llm-validated | 10 个事件，含 feedback.received |
| 口径纠错编辑与提交 | trace-6834a513-b832-45c1-a491-b21e9d99531c | low / deterministic-fast-path | 10 个事件，含 feedback.received |

三条链路均按以下顺序完整恢复：

request.accepted → turn.received → skill.resolved → planning.completed → query.executed → result.validated → response.composed → turn.completed → request.completed → feedback.received。

## 5. 缺陷与修复留痕

| 编号 | 发现方式 | 问题 | 修复 | 最终状态 |
| --- | --- | --- | --- | --- |
| B-037 | 浏览器 UAT | 负向反馈调用 window.prompt；应用内浏览器不支持，控制台报错且用户无法提交纠正 | 改为回答区内联 textarea，提供提交/取消；增加禁止 window.prompt 的回归测试 | 已关闭；干净页面复验控制台 0 错误 |
| B-038 | 状态审查 | deterministic-risk-fallback 被显示成普通受控规则成功，未告知 LLM 校验降级 | runtimeStatus 改为 warning，并明确“AI 意图校验暂不可用、采用已验证备用规划” | 已关闭；代码与静态检查通过 |
| E-002 | 首次专项 UAT | 测试脚本未配置 UAT_ADMIN_TOKEN，日志与审核接口被权限边界拒绝 | 使用正确的 X-Wyn-Skill-Admin-Token，并用本地临时 UAT 管理令牌重跑 | 已关闭；6/6 通过 |
| E-003 | 首次专项 UAT | 沙箱在 Windows 重解析工作区拒绝覆盖 latest.json | 以允许写入项目验收目录的运行方式生成证据 | 已关闭；latest.json 已更新 |

B-037 是产品缺陷；E-002/E-003 是测试环境与执行权限问题。所有失败均保留在本轮运行记录和本报告中，没有将首次失败覆盖成“从未发生”。

## 6. 当前边界与后续治理

- 实验室和零售评测包目前是 draft，必须由对应行业专家确认口径和黄金答案后，才可成为发布阻断门槛。
- 当前学习闭环是“自动采集 + 人工审核 + 版本发布”，不是无审核在线自学习。这是保证跨行业准确性和防止错误反馈污染生产的必要边界。
- 双账号 Wyn 数据集/行级权限穿透验证、未索引数据集精确性边界仍依赖用户后续提供账号和数据集，未在本轮虚构完成。
- 日志回放接口属于管理能力，受管理员令牌保护；普通用户不能通过日志越权读取其他用户数据。

## 7. 最终结论

本轮 1–7 项计划范围已完成开发、自动化测试、真实 Wyn API UAT、浏览器截图验收、日志回放和缺陷修复。可立即在 http://127.0.0.1:8787 继续试用。

系统已经具备受控进化基础：用户每次反馈都可形成版本化、可审计、可审核的改进候选；跨行业准确性提升仍以业务负责人确认和回归评测为发布前提。

