# LLM 出站稳定性 P0 目标与实施跟踪计划

## 1. 背景与问题定义

项目当前在 `127.0.0.1:8787` 运行时偶发或持续出现 `EACCES:443`。该错误发生在 Node 建立到外部 Provider 的 TCP 连接阶段，属于运行环境出站权限问题，不是数据洞察业务语义错误，也不能仅靠重试、扩大上下文或更换模型解决。

本计划的目标是建立跨开发、调试、测试、UAT、打包和生产一致的 LLM 出站链路，并以真实调用证据关闭问题。

## 2. 总目标

建立统一链路：

```text
8787 应用 -> 项目级 LLM Gateway -> 企业代理/固定出口 -> DashScope 或其他 Provider
```

完成后必须满足：

- `8787` 不直接连接外部 Provider；
- 所有环境使用同一 Gateway 契约和启动方式；
- Gateway 具备稳定 DNS、TLS、出站权限和密钥管理；
- LLM 失败返回真实失败，不生成降级假成功；
- 可按请求 ID 回放连接、重试、Provider 响应和阶段耗时；
- 开发、调试、测试、UAT、发布均有自动预检。

## 3. 范围

### 包含

- Gateway API 契约和健康检查；
- 8787 侧统一 Gateway 客户端；
- 出站代理、固定出口或专用服务节点；
- 超时、重试、熔断、限流和错误码；
- 真实 LLM UAT、故障注入和浏览器验收；
- 启动脚本、打包预检和运行手册；
- 诊断日志和运行指标。

### 不包含

- 通过 deterministic fallback 掩盖 LLM 失败；
- 依赖 DashScope 当前动态 IP 的长期防火墙规则；
- 把普通开发机临时放行视为最终生产方案；
- 将 Mock 调用作为真实 LLM UAT 的替代。

## 4. 分阶段计划

| 阶段 | 目标 | 主要交付物 | 验收级别 | 状态 |
|---|---|---|---|---|
| P0-0 | 基线和根因证据 | 出站对照原型、当前进程信息、错误样本 | 平台 P0 | 进行中 |
| P0-1 | Gateway 契约 | `/health/live`、`/health/ready`、`/v1/chat/completions`、统一错误码 | 平台 P1 | 待开始 |
| P0-2 | 稳定出站节点 | 企业代理、固定出口或受控服务节点 | 平台 P0 | 待开始 |
| P0-3 | 8787 解耦 | 所有 LLM 路径仅通过 Gateway，禁止直连 | 平台 P1 + 模块 M2 | 待开始 |
| P0-4 | 统一运行和预检 | `start:controlled`、`preflight:llm`、发布检查 | 平台 P1 | 待开始 |
| P0-5 | 故障治理 | 超时、重试、熔断、限流、日志和告警 | 平台 P1 | 待开始 |
| P0-6 | 严格真实 UAT | 多场景真实调用、故障注入、PC/Mobile 截图 | 平台 P0 + 模块 M3 | 待开始 |

## 5. Gateway 最低契约

```text
GET  /health/live       进程存活
GET  /health/ready      Gateway 与 Provider 真实可用
POST /v1/chat/completions 统一 JSON 调用
GET  /metrics           调用、失败、超时、熔断指标
```

每次调用必须记录：`requestId`、`operation`、Provider、模型、DNS/连接/响应头/总耗时、重试次数、错误码和最终状态。API Key 不进入日志。

## 6. 环境统一要求

应用环境只配置 Gateway 地址：

```text
LLM_GATEWAY_URL=https://内部网关地址
```

开发、IDE 调试、自动化测试、UAT 和发布全部通过同一受控启动方式运行。`127.0.0.1:8787` 继续保留，但它只访问 Gateway，不直接访问 DashScope。

## 7. 严格验收门禁

### 平台 P0

- 真实 `8787` 进程连续 10 次 `health/ready` 通过；
- 30 分钟运行无 `EACCES:443`；
- 8787 出站日志中对外 Provider 直连次数为 0；
- Gateway 真实 Provider 调用成功并有完整审计；
- 重启、IDE 启动、命令行启动结果一致；
- Gateway 断开、DNS 失败、连接拒绝、429、5xx、响应超时均返回真实失败或可审计重试；
- 不允许降级内容伪装成成功。

### 模块 M3

- 数据洞察真实执行 Planner、Critic、Narrator；
- 高基数聚合结果至少成功 3 次；
- 返回 `provider=llm-orchestrated` 且正文非空；
- PC 1280x720 截图看到真实洞察正文；
- Mobile 390x844 无横向溢出、无控制台错误；
- 使用 `insightId` 可以完整回放输入、Evidence Pack、Gateway 和三阶段日志。

### 发布级

- 新机器从零启动并通过预检；
- 打包运行方式与开发运行方式一致；
- Gateway 不可用时发布验证自动失败；
- 不能用 Mock 结果替代真实 Provider 验证。

## 8. 关闭标准

只有以下条件全部满足，才关闭 P0：

| 指标 | 门槛 |
|---|---:|
| 8787 直连外部 Provider | 0 次 |
| Gateway 健康探针 | 连续 10/10 |
| 真实数据洞察 | 连续 10/10 |
| 高基数洞察 | 至少 3/3 |
| 重启后验证 | 通过 |
| 开发/调试/UAT/发布 | 结果一致 |
| 故障注入 | 无伪成功 |
| 浏览器验收 | PC 和 Mobile 均通过 |

## 9. 外部依赖和责任边界

项目代码可以完成 Gateway 客户端、强制预检、错误治理、日志和 UAT；网络管理员或基础设施负责人必须提供 Gateway 运行节点、企业代理或固定出口、DNS/TLS 和密钥管理。没有稳定出站权限，不能宣称问题已根治。

## 10. 跟踪记录

- 当前直接 Node/8787 运行上下文曾出现 `EACCES:443`；
- 之前的 DashScope 防火墙规则尝试未成功落地，不能作为已解决依据；
- 本文档配套原型：`uat-llm-egress-prototype-2026-08-29.mjs`；
- 原型结果和最终 UAT 结果追加到本文档及 `DEVELOPMENT_PROGRESS_REPORT.md`。

### 2026-08-29 出站原型结论

原型使用同一目标 `https://dashscope.aliyuncs.com/compatible-mode/v1/models`，只携带无效测试令牌，不发送业务数据。

| 调用模式 | 受限上下文 | 允许出站上下文 |
|---|---|---|
| Node `fetch` 直连 | `EACCES`，连接多个远端 IP 的 `443` 均被拒绝 | HTTP `401`，已到达远端 |
| `curl.exe` 直连 | 无法连接，HTTP `000` | HTTP `401`，已到达远端 |
| PowerShell `Invoke-WebRequest` | Socket 权限错误 | HTTP `401`，已到达远端 |
| 当前 `127.0.0.1:8787 /api/llm/health` | `503`，底层为 `EACCES` | 仍为 `EACCES`，因为该 8787 进程本身仍是受限进程 |

结论：`EACCES:443` 不是项目调用协议或模型配置导致，而是具体运行进程的出站权限策略导致。允许出站的调用模式均能完成 TCP/TLS 并收到远端鉴权响应；要让项目稳定运行，必须让 8787 以同等网络权限启动，或让 8787 改为访问具备稳定出站能力的项目级 LLM Gateway。

### 2026-08-29 P0-0 当前发布/运行基线

| 检查项 | 真实结果 | 判定 |
|---|---|---|
| 8787 监听 | `0.0.0.0:8787`，PID `19244`，Node `C:\Program Files\nodejs\node.exe` | 本地服务正常 |
| 服务账号 | `XA-PRO-ZENOS\\CodexSandboxOffline` | 受限沙箱账号，不能作为稳定出站运行账号 |
| 启动模式 | 直接 Node 进程，非受控 Windows 服务/固定 Gateway 节点 | 不符合目标发布模式 |
| `/api/llm/health` | HTTP `503`，`LLM_REQUEST_FAILED`，底层 `connect EACCES <DashScope IP>:443` | Gateway 不可用 |
| Node/curl/PowerShell 直连 | 均无法连接 DashScope `443`；Node 明确返回 `EACCES`，curl 返回 HTTP `000` | 环境级出站阻断 |
| 出站防火墙审计 | 读取 `Get-NetFirewallProfile` 被拒绝访问 | 当前策略无法由项目账号审计 |
| 真实 LLM UAT | 未执行成功；健康预检已阻断，不能宣称通过 | P0 未关闭 |

P0-0 结论：当前问题仍是运行账号/出站策略缺陷。项目代码和 Gateway 错误治理能够如实报告失败，但无法在受限账号下自行授予外连权限。下一步 P0-1 需先确定内部 Gateway 或受控出站节点及其健康契约，然后再改造 `8787` 仅访问 Gateway。

### 2026-08-29 P0-0 账号切换复验

用户将 `CodexSandboxOnline` 设置密码，并在该账号上下文启动 `8787`。真实结果：

- `8787` 重新监听，运行数据目录为项目 `D:\工作计划\20251210-AIGC\WynAI\data`，不再使用受限 fallback 目录。
- `GET /api/llm/health` 返回 `200`、`ok=true`、`status=healthy`，模型为 `deepseek-v4-flash-0731`，探针约 `1,073ms`。
- 连续健康探针 `10/10` 成功，全部返回 `status=healthy`，单次延迟约 `747-1,514ms`。
- `npm run uat:data-insight` 真实 UAT 返回 `passed`：`ins-17d194e3-a43b-4094-81e9-aa5b81dbde89`，`provider=llm-orchestrated`，Planner/Critic/Narrator 均 completed，正文长度 `1,200`。
- 诊断日志保留每个阶段和 Gateway 调用。此前一次 Narrator repair 响应头超时也如实记录，后续重试成功，未生成伪降级内容。

该复验证明“以具备出站权限的账号启动 8787”可以恢复真实 LLM 调用；但 P0 总体仍未关闭，连续 10 次健康、30 分钟稳定性、高基数 3/3、重启一致性和浏览器 P0/M3 验收尚未完成。

### 2026-08-29 P0 真实代码复验与浏览器验收（进行中）

本次复验基于用户手动启动的真实 `127.0.0.1:8787`，没有使用 Mock 或 deterministic fallback：

- `npm test`：279/279 通过；`npm run check`：通过。
- 真实高基数洞察连续 3/3 通过，Insight `ins-17d194e3-a43b-4094-81e9-aa5b81dbde89`，`provider=llm-orchestrated`，模型 `deepseek-v4-flash-0731`，Planner/Critic/Narrator 全部 `completed`；第 1 次追加一次受控 `narrator-repair` 后成功，第 2、3 次无需修订。
- 三次正文长度分别为 1198、1306、1306；未出现 `fallback`、`degraded` 或 `INSIGHT_CLAIM_VALIDATION_FAILED`。
- 浏览器页面刷新后显示 30 条结果，选中上述 Insight；正文中真实显示管理摘要、关键发现、风险判断和行动建议，页面标识为 `外部大模型`。
- PC 截图：`uat-p0-desktop-insight-content-1280x720.png`；Mobile 完整正文截图：`uat-p0-mobile-insight-full-390x844.png`。两端 `scrollWidth=clientWidth`，控制台 `error/warn=[]`。
- 当前实例启动日志显示项目 `data` 目录不可写，使用 `C:\Users\ZENOSZ~1\AppData\Local\Temp\WynAI-runtime-data-8787`；这不阻断本次真实 LLM，但会影响跨重启日志和数据持久化，仍需修复目录权限或固定受控运行账号。
- `uat-p0-health-monitor.mjs` 已完成 30 分钟真实 `/api/llm/health` 监测，结果写入 `uat-p0-health-monitor.json`：58/58 次 `200 healthy`，失败 0 次，`passed=true`。

本次结果只证明当前手动启动实例可以真实调用 LLM，不等于 P0 完成。重启一致性、运行账号/目录权限、外部出站策略和监测结果仍是关闭门禁。
