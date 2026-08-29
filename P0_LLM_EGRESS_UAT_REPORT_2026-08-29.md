# P0-LLM-EGRESS-001 真实 LLM UAT 报告

## 1. 验收范围

- 服务地址：`http://127.0.0.1:8787`
- 真实 Provider：DashScope
- 模型：`deepseek-v4-flash-0731`
- 验收类型：平台 P0 基础连通性、数据洞察模块 M3、浏览器 PC/Mobile
- 禁止项：Mock、deterministic fallback、degraded 伪成功

## 2. 自动化与真实 LLM 结果

| 项目 | 结果 |
|---|---|
| `npm test` | 279/279 通过 |
| `npm run check` | 通过 |
| 高基数洞察 | 连续 3/3 通过 |
| Provider | `llm-orchestrated` |
| Planner/Critic/Narrator | 三次均 `completed` |
| Narrator repair | 第 1 次 1 次且成功；第 2、3 次 0 次 |
| 正文长度 | 1198、1306、1306 |
| 降级/伪成功 | 0 次 |

真实洞察 ID：`ins-17d194e3-a43b-4094-81e9-aa5b81dbde89`。

## 3. 浏览器验收

页面刷新后显示 30 条标准输入结果，选中上述 Insight。页面真实显示“外部大模型”，并呈现管理摘要、关键发现、风险判断、行动建议。

- PC 1280×720 正文截图：`uat-p0-desktop-insight-content-1280x720.png`
- Mobile 390×844 完整正文截图：`uat-p0-mobile-insight-full-390x844.png`
- PC `scrollWidth=clientWidth=1280`
- Mobile `scrollWidth=clientWidth=375`（设备 CSS 宽度为 375）
- 两端控制台 `error/warn=[]`

## 4. 健康监测

监测脚本：`uat-p0-health-monitor.mjs`，运行结果：`uat-p0-health-monitor.json`。

30 分钟监测已完成：58 次探针全部 `200 healthy`，`passed=true`，失败 0 次。运行结果保存在 `uat-p0-health-monitor.json`；监测期间无 `EACCES` 分类、无超时伪装、无 fallback。

## 5. 未关闭项

当前 `8787` 进程实际账号为 `GRAPECITY\\ZenosZeng`，启动日志显示项目 `data` 目录不可写，使用临时运行目录 `C:\\Users\\ZENOSZ~1\\AppData\\Local\\Temp\\WynAI-runtime-data-8787`。因此：

- 本次真实 LLM 调用和模块级 UAT 可以判定通过；
- 平台 P0 不能宣称完全关闭；
- 仍需修复受控运行账号/目录权限，完成稳定出站策略、干净重启一致性和 30 分钟监测闭环。

## 6. 结论

代码层面的上下文预算、证据校验和 `completed-partial` 修复已通过真实 LLM 验证；当前手动启动实例可以使用数据洞察。平台级出站治理尚未达到“所有环境统一受控、重启一致、日志持久化”的最终关闭标准。
