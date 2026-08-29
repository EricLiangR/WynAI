# 指定问题实时 UAT 报告

日期：2026-08-29  
服务端口：`8787`  
验收级别：模块级严格 UAT（真实问数 + 真实数据洞察 LLM 链路）

## 测试问题

`过去五年，每个季度不同地区、不同商品类型的收入、利润情况`

## 执行结果

### 1. 智能问数

- 状态：通过
- 数据集：`AI对话分析-销售数据`
- 会话：`conv-205ac92f-664e-4a44-901a-e6789f3f9650`
- Trace：`trace-e75f0b05-0400-4e1b-bc24-ab422d1efb48`
- Turn：`turn-e51b3576-8fd7-4096-a5b2-f129723a93a1`
- 识别指标：订单金额、订单利润
- 识别维度：客户地区、类别名称、订购日期（季度）
- 返回结果：728 行
- 洞察 ID：`ins-bb912834-1584-4661-94ab-a74379977c3d`

### 2. 数据洞察

- 状态：不通过
- HTTP：`502`
- 错误码：`LLM_UPSTREAM_ERROR`
- 错误：`大模型请求失败 (dashscope.aliyuncs.com): fetch failed`
- 生成阶段：Planner 失败，Critic/Narrator 未执行
- 正文：未生成
- 降级：未发生，严格模式正确阻断

## Gateway 证据

- Provider：`primary`
- 模型：`deepseek-v4-flash-0731`
- 调用次数：19
- 成功：0
- 失败：3
- 超时：0
- 熔断拒绝：18
- fallback：0
- 当前 Provider：`open=true`

## 诊断日志

完整诊断文件：

`C:\Users\ZENOSZ~1\AppData\Local\Temp\WynAI-runtime-data-8787\insight-diagnostics\ins-bb912834-1584-4661-94ab-a74379977c3d.json`

## 网络核验

- `dashscope.aliyuncs.com` DNS 解析成功
- 到解析出的地址 `:443` TCP 连接失败（`Test-NetConnection=False`）
- 与服务端 `fetch failed` 诊断一致

## 结论

本次 UAT **不通过**。问数链路正常，数据洞察链路因当前运行环境无法建立到 DashScope 的上游请求而失败。该结果不是证据校验问题，也不是降级结果；平台严格模式按预期返回失败。
