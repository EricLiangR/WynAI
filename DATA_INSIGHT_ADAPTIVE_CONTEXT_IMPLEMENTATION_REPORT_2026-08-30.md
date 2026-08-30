# 自适应证据传输与模型预算实施报告

日期：2026-08-30  
状态：阶段 A-G 核心实现完成，阶段 5（流式响应）未启动

## 交付结果

- 冻结 `wynai.model-capability/v1`：模型上下文窗口、输入预算、输出预留、安全余量和估算器版本化。
- 冻结 `wynai.evidence-transport-plan/v1`：`auto`、聚合目录、无损分块和混合模式及决策轨迹。
- Skill 仅声明高层能力边界；平台默认 `transportMode=auto`，支持通过 `INSIGHT_TRANSPORT_MODE=aggregate-catalog` 受控回退。
- Planner/Critic/Narrator 的证据目录只传摘要和证据 ID；完整聚合结果仍保存在 Evidence Pack，禁止因 500 行阈值隐式采样。
- 服务端按 Model Capability Profile 构建 Evidence Pack，并把档案、预算和传输计划写入诊断日志。
- 分块只允许 SkillPlan 明确允许的行级方法；保留块索引、offset、chunkCount 和无损标志。
- 数值证据校验支持带单位的近似展示和趋势序列相邻变化率，避免合法四舍五入被误判为无证据。

## 验证结果

- `npm run check`：通过。
- `npm test`：290/290 通过。
- 418 行回归：完整事实源保留，Planner 不再内联行数据，不触发 `LLM_CONTEXT_LIMIT`。
- 真实 `127.0.0.1:8787` LLM UAT：`ins-a4385336-d931-4fe8-b69a-f529cf07477d`。
  - Provider：DashScope 主 Provider。
  - Planner/Critic/Narrator：全部完成。
  - 结果：`completed-partial`，扩展证据不足未阻断核心洞察。
  - Planner 预算：`11551/20000 tokens`，目录传输为 `summary-and-evidence-id-only`。
  - 传输模式：`auto` 最终选择 `aggregate-catalog`，原因和覆盖度已写入 `transportPlan`。

## Git 提交

- `0e60cfc`：能力档案与传输契约。
- `997738b`：单条证据 token 门禁和 418 行回归。
- `f0b36ca`：自动传输决策与模型预算适配。
- `b9c6053`：平台受控开关和分块边界。

## 后续门禁

流式响应阶段 5 仍未启动；需要在现有真实 UAT 基础上单独评审是否引入。生产启用前仍应使用平台级 P1 和模块级 M2 验收矩阵复测 16K/32K/128K 配置、分块失败、超时、取消和重试。
