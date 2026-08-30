# 数据洞察平台可靠性实施与 UAT 报告

> 日期：2026-08-30（Asia/Shanghai）  
> 范围：阶段 0-4  
> 验收级别：平台级 P1 + 模块级 M1/M2  
> 服务地址：`http://127.0.0.1:8787`  
> 结论：代码与协议门禁通过；当前运行实例的真实 LLM 出站门禁未通过

## 1. 验收目标

本轮验证以下平台能力，而非针对单一问题增加特例：

1. LLM 慢响应不再被 15 秒阈值误判为失败；
2. 聚合结果作为权威输入，不发生核心证据二次采样或静默截断；
3. 真实业务稀疏不被误判为数据缺失；
4. 核心和扩展洞察按 Skill 与平台规则独立验收；
5. 扩展失败不拖垮已验证核心结果；
6. 核心失败、Provider 失败和超时均报告真实状态，不生成模板化降级洞察。

## 2. 实施摘要

### 2.1 LLM Gateway

- 保持非流式同步 `fetch`；
- 15 秒响应头阈值改为 `gateway.slow` 软告警；
- 区分响应头硬超时、响应体超时、总截止、取消和 Provider 错误；
- Planner、Critic、Narrator 使用独立阶段预算；
- Narrator Repair 使用独立 90 秒预算；
- PowerShell 输出未修改，完整过程进入后台诊断事件。

### 2.2 Evidence Pack

- 默认取消固定 40 组、时间 Top 60、贡献 Top 20 限制；
- 完整输入默认生成完整核心聚合；
- 显式限制才设置 `resultLimited`；
- 分离源数据完整度、平台证据覆盖度和业务稀疏性；
- Planner 使用证据目录引用，避免相同证据在请求中重复展开。

### 2.3 核心/扩展编排

- 核心项目不可被 LLM 降级为非阻断；
- 扩展项目显式可选时允许 `completed-partial`；
- 单条 Narrator 结论不合格时隔离该条；
- 全部结论不可用时才执行一次 Repair；
- 新增零售基线 Skill Profile，业务规则不写死在通用编排器中。

## 3. 自动化验收

| 门禁 | 结果 | 说明 |
|---|---|---|
| `npm run check` | 通过 | 语法与静态检查通过 |
| `npm test` | 284/284 通过 | 全量回归通过 |
| 专项测试 | 46/46 通过 | 覆盖慢响应、响应体超时、完整证据、显式受限、稀疏业务、核心/扩展、隔离和 Repair |

## 4. 真实 LLM UAT

### 4.1 245 行供应商/时间/品类案例

- Insight ID：`ins-aa63dce4-e5af-4d88-a2c2-cf38cf7cf90d`；
- 状态：`completed`；
- Planner：7.725 秒；
- Critic：5.003 秒；
- Narrator：10.999 秒；
- Repair：未触发；
- 输入：245 行；
- 证据分组：432；
- 省略分组：0；
- `groupingsComplete=true`；
- `sourceTruncated=false`；
- `sparsityMode=observed-records-only`。

结果返回高价值、低价值、风险供应商与可执行建议，证明稀疏业务记录不会被误判为平台证据缺失。

### 4.2 1,581 行高基数地理/月度案例

- Insight ID：`ins-09e7f7b3-e36a-4d90-aadb-93a55eaad190`；
- 问题：`统计每月、各客户地区、客户省份、客户城市的订单金额、订单利润、客单价。`；
- 状态：`completed`；
- 模型：`deepseek-v4-flash-0731`；
- Planner：7.246 秒；
- Critic：3.542 秒；
- Narrator：11.998 秒；
- 输入：1,581 行、7 字段；
- 证据分组：2,303；
- 省略分组：0；
- `groupingsComplete=true`；
- `isSample=false`；
- `isTruncated=false`；
- `missingRowsAreZero=false`。

页面返回的洞察包含：整体销售额与利润、毛利率、月度周期性、地区贡献集中度、异常月份、风险判断和具体行动建议。洞察正文长度为 1,418 字符。

### 4.3 最终门禁重跑

完成代码、文档和截图后，再次执行 `npm run uat:data-insight`。同一 Insight ID 重新完成真实 Planner/Critic/Narrator 调用：

- Planner：6.805 秒；
- Critic：4.139 秒；
- Narrator：7.408 秒；
- 最终状态：`passed`；
- Provider：`llm-orchestrated`；
- 模型：`deepseek-v4-flash-0731`；
- 证据分组：2,303；
- 省略分组：0；
- `groupingsComplete=true`；
- `isSample=false`、`isTruncated=false`；
- `missingRowsAreZero=false`。

该重跑证明最终工作区代码仍可由真实 `8787` 进程完成外部 LLM 全链路，而非只复用历史结果。

目标关闭审计再次执行同一真实 UAT，结果仍为 `passed`：Planner 6.219 秒、Critic 4.325 秒、Narrator 8.389 秒，正文长度 1,109；1,581 行输入对应 2,303 个证据分组全部覆盖、0 个省略，且 `isSample=false`、`isTruncated=false`。该次运行作为本报告最终完成门禁。

## 5. PC 浏览器 UAT

测试环境：Codex In-app Browser，PC 视口 `1440x1000`，访问真实 `127.0.0.1:8787`。

验收动作：

1. 打开项目首页；
2. 进入“数据洞察”；
3. 选择 `ins-09e7f7b3-e36`；
4. 核对 1,581 行、7 字段、100% 完整和“外部大模型”；
5. 核对管理摘要、关键发现、风险判断和行动建议实际可见；
6. 检查页面无降级提示、无 LLM 错误、无空洞察。

截图证据：

- `test/uat-artifacts/data-insight-reliability-2026-08-30/pc-selected-input.png`：显示 Insight ID、问题、输入规模、字段、完整度和模型状态；
- `test/uat-artifacts/data-insight-reliability-2026-08-30/pc-complete-insight.png`：显示实际管理摘要、关键发现、风险判断和行动建议。

PC UAT 结论：通过。

## 6. 缺陷闭环

| 编号 | 原问题 | 修复结论 | 状态 |
|---|---|---|---|
| REL-TIMEOUT-001 | 15 秒响应头阈值直接中止真实慢请求 | 改为软告警，硬超时和阶段预算独立 | 已关闭 |
| REL-EVIDENCE-001 | 核心证据使用固定 Top-N/组数限制 | 默认完整聚合，限制必须显式声明 | 已关闭 |
| REL-CONTEXT-001 | 高基数证据重复展开触发上下文超限 | Planner 改为权威目录引用 | 已关闭 |
| REL-SPARSE-001 | 部分月份无记录被当成证据缺失 | 引入 observed-records-only 业务稀疏语义 | 已关闭 |
| REL-ORCH-001 | 单个扩展或 Narrator 结论失败拖垮全局 | 核心/扩展分级、单条隔离、受控 Repair | 已关闭 |

本轮未发现未记录的 P0/P1 缺陷。

## 7. 阶段 5 决策

建议暂不引入流式响应。当前同步 `fetch` 的分层超时与状态分类已经解决本轮误判，且两个真实完整 LLM 案例均成功。继续通过诊断事件收集慢响应分布；只有频繁出现长响应头等待、需要用户可见进度、或需要流式空闲超时判断时再启动阶段 5。

## 8. 最终结论

阶段 0-4 的代码、协议和自动化门禁达到本期完成标准：完整聚合输入不再二次采样，证据覆盖与业务稀疏可区分，核心/扩展边界可配置，失败不会生成伪成功。受控账号下的真实 LLM 成功链路和 PC 正文截图已通过；但当前 `8787` 实例的运行账号仍被环境禁止访问 DashScope `443`，因此当前实例的真实成功 UAT 不能签署为通过。

## 9. 当前实例复验（2026-08-30）

本节记录本次确认后的真实复验，不覆盖前述受控账号成功证据。

| 项目 | 真实结果 | 判定 |
|---|---|---|
| `npm run check` | 通过 | 通过 |
| `npm test` | 288/288 通过 | 通过 |
| `GET /api/live` | HTTP 200，PID `7908` | 通过 |
| `GET /api/llm/health` | `unhealthy/circuit_open`，`LLM_REQUEST_FAILED`/`EACCES`，目标 `dashscope.aliyuncs.com:443` | 环境阻断 |
| `npm run uat:followup` | HTTP 502，运行 `failed`，无正文、无文档，诊断 `lifecycle.valid=true`、`openAttempts=0` | 失败链路符合预期 |

机器可读证据：`uat-followup-platform-2026-08-30/latest.json`；失败链路截图：`uat-followup-data-insight-health-failure.png`。

该结果说明平台已正确拒绝 LLM 失败并保留完整诊断，未出现确定性降级伪洞察；它不是 1-3 代码改造的回归。待运行账号/出站策略允许访问 `443` 后，必须重新执行成功洞察和 PC 正文截图，才能关闭最终真实 UAT 门禁。
