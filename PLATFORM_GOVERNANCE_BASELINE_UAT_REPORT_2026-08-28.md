# 平台治理与 UAT 阶段 0 基线报告

> 日期：2026-08-28（Asia/Shanghai）
>
> 计划：`PLATFORM_GOVERNANCE_AND_UAT_ROADMAP.md` 阶段 0
>
> 治理基线：`PLATFORM_AND_MODULE_UAT_GOVERNANCE.md` v1.0
>
> 环境：`http://127.0.0.1:8787/`

## 1. 验收级别

- 平台级：P0
- 模块级：M0
- 阶段目的：固化当前版本、服务、依赖、测试和截图回归基线

## 2. 执行结果

| 检查项 | 结果 | 证据 |
|---|---|---|
| Node 运行时 | 通过 | Node v24.11.1 |
| Git 基线 | 记录 | HEAD `3d140df`，工作区存在此前用户迭代修改 |
| 8787 健康检查 | 通过 | Wyn status 200，LLM 已配置 |
| `npm run check` | 通过 | 全部目标文件语法检查通过 |
| `npm test` | 通过 | 233/233，0 失败 |
| 智能问数会话创建 | 不通过 | 当前运行进程写会话临时文件返回 `EPERM` |
| 五张截图问题复现 | 已登记 | REG-001 至 REG-005 |

## 3. 基线缺陷

### BG-001：运行进程写权限导致会话无法创建

- 严重度：P1
- 平台级别：P1/P2
- 模块影响：智能问数 M2/M3 无法可靠执行
- 现象：`POST /api/smart-query/conversations` 返回 `EPERM`，目标为 `data/smart-query-conversations/*.tmp`
- 判断：环境/运行进程权限问题，不是用户语义问题
- 处理要求：必须以工作区写权限启动 8787 服务并重跑会话创建；若仍失败，再检查运行数据目录配置和原子写入路径
- 当前状态：开放，阻断实时 UAT

### BG-002：UAT 新证据目录无法创建

- 严重度：P1
- 平台级别：P1/P2
- 现象：创建 `test/uat-artifacts/platform-governance-baseline-2026-08-28` 被工作区 ACL 拒绝
- 判断：证据持久化路径权限与服务运行权限存在共同环境问题
- 处理要求：恢复 UAT 证据目录写权限，或配置明确可写的证据根目录；不得覆盖已有证据
- 当前状态：开放，阻断机器可读阶段证据落盘

### REG-003：显式“历年”时间分组丢失

- 严重度：P0
- 平台级别：P1/P2
- 模块级别：M1/M3
- 处理要求：在语义契约和查询编译层修复，不允许只增加单个关键词特例
- 当前状态：开放，阻断发布

其余 REG-001、REG-002、REG-004 进入阶段 1-4 的平台化修复范围；REG-005 作为正向基准保留。

## 4. 阶段 0 结论

阶段 0 已完成版本、服务和自动化基线盘点，但由于 BG-001、BG-002 阻断，阶段结论为：

> **条件通过：自动化基线通过，实时会话 UAT 和机器可读证据落盘不通过；先修复运行时/证据路径权限和失败可观测性，再进入阶段 1 的实时验收。**

## 5. 阶段 1 进展（同日）

阶段 1 已完成第一批可观测性改动并通过自动化回归：

- 会话层增加 `query.planned`、`query.compiled`、`query.execution.failed`；
- HTTP 层增加 `request.failed`；
- 当前全量自动化测试：241/241 通过；
- 真实 8787 服务复现 REG-001 时，trace `trace-8ea6f6e7-6a96-43fc-86f8-9e370bcae7d1` 已形成：
  `request.accepted → turn.received → skill.resolved → planning.completed → query.planned → query.compiled → query.execution.failed → request.failed`；
- 日志已能确认 REG-001 是 Wyn 执行失败，不是语义解析失败。

阶段 1 仍未完全关闭：当前 `QueryRouter` 的适配器级错误尚未补充结构化 `compile/execute` 阶段字段，且 Wyn 原始错误摘要仍需进一步脱敏固化。

## 6. 下一步

1. 补齐适配器级编译/执行阶段和 Wyn 错误摘要；
2. 恢复 `test/uat-artifacts` 可写路径，保存阶段 0 机器可读基线；
3. 重新执行 REG-001 至 REG-005，并为每条用例保存 API、trace 和截图证据；
4. 阶段 1 通过后，完成阶段 2 时间语义和查询正确性修复；
5. 未关闭 REG-003 前禁止发布。
