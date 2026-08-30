# Insight Run Lifecycle and Diagnostic Contract v1

版本：`wynai.insight-run/v1` / `wynai.insight-diagnostic/v1`

## 运行状态

`queued -> planning -> running -> completed|failed|interrupted`。

`completed|failed|interrupted -> planning` 只能通过显式重试，且必须创建新的 `attemptId`。每个运行保存 `attempts[]`，当前运行的 `attempt`、`attemptId` 与最后一个 attempt 一致。

## 中断语义

- `process-restart`：服务启动时扫描并关闭此前未终态的运行；
- `client-disconnected/request-aborted`：HTTP 请求断开或调用方取消；
- Provider 错误和超时：保持 `failed`，不能误记为 `interrupted`。

中断记录 `interruption.reason/detectedAt/processId`，重试不会覆盖旧 attempt。

## 诊断终态不变量

每个 `generation.started` 必须有且仅有一个同 `runId + attemptId` 的 `generation.finished`、`generation.failed` 或 `generation.interrupted`。诊断接口返回 `lifecycle.valid`、`openAttempts` 和 `orphanTerminalEvents`，支持按 `insightId` 完整复盘输入、证据、阶段、Gateway、文档和错误。

仅创建了尚未启动生成的 `queued` 运行，不要求生成终态；服务重启会将其标为 `interrupted`，但不伪造 `generation.started`。
