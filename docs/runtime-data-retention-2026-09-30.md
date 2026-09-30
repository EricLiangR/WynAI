# 运行时过程数据与存储优化记录（2026-09-30）

## 1. 问题现象

`data/operation-events/` 长期承载智能问数每次会话的操作事件，运维核对时发现：

| 目录 | 磁盘文件数 | 配置上限 | 结论 |
| --- | --- | --- | --- |
| `operation-events` | 31,078 | 10,000 | 超限约 3 倍，持续增长 |
| `request-audit` | 2,000 | 2,000 | 正常，恰好等于上限 |
| `insight-runs` | 200 | 200 | 正常 |
| `insight-diagnostics` | 1,936 | 5,000 | 未超限，但单文件最大 13MB，合计 1.10GB |

全量运行数据合计约 1.18GB / 36,357 个文件，其中 `data/insight-diagnostics`（事件明细）与
`data/operation-events` 属于可回收的诊断类数据。

## 2. 根因

### 2.1 `JsonRunStore.init()` 无界并发读取导致句柄耗尽（EMFILE）

`lib/run-store.mjs` 的 `init()` 使用无界 `Promise.all` 读取目录下每个文件：

```js
const loaded = await Promise.all(files.map(async name => {
  try { return JSON.parse(await readFile(...)); }
  catch { return null; }   // 静默吞掉错误
}));
```

Windows 上同时打开的句柄有限（约 8K）。实测 12,000 个文件时：

```
total   = 12000
ok      = 8189
errors  = [["EMFILE",3811]]
```

被 `catch { return null }` 吞掉后，`this.runs` 只装载了 8,189 条，而磁盘上有 12,000 个文件。
随后 `prune()` 基于**不完整的索引**执行裁剪——只能看到这 8,189 条，因此：

- 内存索引与磁盘文件长期不一致（实测 `in-memory = 8189`，`files after init = 31078`）；
- 早于索引窗口的旧文件永远不会被判定为 stale，目录随之单调增长。

### 2.2 时间戳缺失导致排序与裁剪方向错误

`runTimestamp()` 只识别 `completedAt` / `createdAt`：

```js
return Date.parse(run?.completedAt || run?.createdAt || '') || 0;
```

但 `operation-event` 记录只有 `at` 字段。实测：

```
keys = id,schema,traceId,sequence,at,event,phase,outcome,durationMs,...
has createdAt?  undefined
Date.parse(...) => NaN
```

所有记录时间戳恒为 `0`，`sort` 退化为插入顺序（即文件读取顺序），于是 `prune()` 会删除
**最新**记录而非最旧记录。实测 300 个文件裁剪到 50 时，保留的是 `...000000`–`...000049`
（最旧的一批），而非最新的记录。

### 2.3 结论

过程数据既没有被可靠裁剪（索引不完整），裁剪方向还是错的（时间戳恒为 0）。

## 3. 修复内容

### 3.1 `lib/run-store.mjs`

| 改动 | 说明 |
| --- | --- |
| 有界并发加载 | 新增 `mapWithConcurrency`，默认并发 64（`WYN_AI_STORE_LOAD_CONCURRENCY` 可覆盖，构造参数 `loadConcurrency` 可覆盖），避免 EMFILE |
| 时间戳回退 | `runTimestamp` 依次回退 `completedAt → createdAt → updatedAt → at`，兼容事件流记录 |
| 稳定排序 | 时间戳相同时用 `id` 兜底比较，保证跨进程、跨平台结果可复现 |
| 不再静默丢失 | `init()` 记录 `loadStats { files, loaded, skipped, failed }`，异常时输出告警 |
| 裁剪可观测 | `prune()` 返回删除条数，删除失败记录错误而非静默忽略 |

验证（12,000 个文件、上限 10,000）：

```
before  = 12000
after   = 10000
memory  = 10000
stats   = {"files":12000,"loaded":12000,"skipped":0,"failed":0}
keeps newest?  true
oldest gone?   true
```

### 3.2 保留策略单一事实来源

新增 `lib/runtime-retention.mjs`，集中定义每个运行数据目录的 `maxItems` 与处置类别：

- `durable`：运行期业务数据（会话、运行、模板等）；
- `audit`：审计留痕（request / skill / insight audit）；
- `diagnostic`：可回收诊断数据（`operation-events`、`insight-diagnostics`）。

`test/runtime-retention.test.mjs` 会解析 `server.mjs`，断言两处的 `maxItems` 永远一致，
防止运行期与运维脚本再次漂移。

### 3.3 运维脚本 `scripts/maintain-runtime-data.mjs`

```powershell
npm run maintain:data              # 预览（默认 dry-run，只读）
npm run maintain:data:apply        # 实际回收诊断类数据

# 精细控制
node scripts/maintain-runtime-data.mjs --json
node scripts/maintain-runtime-data.mjs --dispositions diagnostic,audit
node scripts/maintain-runtime-data.mjs --max-items-dir operation-events=3000
```

默认只回收 `diagnostic` 类目录，**不会**触碰业务数据。当前仓库实测输出：

```
★ operation-events              31077 条 /   40.85MB  上限  10000  可回收  21077 条 / 27.73MB  diagnostic
  insight-diagnostics            1936 条 /    1.10GB  上限   5000  可回收      0 条 / 0B      diagnostic
合计：36357 个文件 / 1.18GB；可回收 21077 个 / 27.73MB
```

### 3.4 `.gitignore` 加固

原先 `data/` 有 0 个受版本控制的文件却**未**被忽略，`.local-browser-profile/`（含真实
`Cookies`、`Login Data`、`Web Data`）同样未被忽略。已补充：

```
*.err
*.out
/data/*
!/data/.gitkeep
.local-browser-profile/
.local-browser-screenshots/
UAT-AY/runtime-*/
UAT-AY/server-*.err
UAT-AY/server-*.out
```

显式加入 `*.err` / `*.out` 是必要的：`*.log` 不会匹配 `server-8811.err`。

## 4. 验证

- `npm run check`：通过（已纳入 `lib/runtime-retention.mjs`、`scripts/maintain-runtime-data.mjs`）。
- `npm test`：584 项全部通过，其中新增 9 项回归：
  - `test/run-store.test.mjs`：事件流时间戳裁剪方向、句柄耗尽一致性、损坏记录统计；
  - `test/runtime-retention.test.mjs`：策略与 `server.mjs` 一致性、脚本默认 dry-run。

## 5. 后续建议

1. 事件流建议改为「单文件 / 单日 + 追加写」，避免数万个小文件带来的目录扫描开销。
2. `insight-diagnostics` 单条记录最大 13MB，建议对 `events` 内的 `data` 做体积上限或字段裁剪。
3. 可在服务启动时增加一次「磁盘文件数 vs 内存索引数」一致性校验，超出阈值时告警。

## 6. UAT 过程数据清理与纳入版本控制（2026-09-30）

### 6.1 清理原则

对 `UAT-AY/`、`uat/` 下的过程数据按「**是否被引用**」二选一处理：

- **被引用 → 纳入版本控制**：从全部受控文件、所有 `.md`/`.mjs`（文档与脚本视为知识资产）出发，
  计算引用关系的**传递闭包**；闭包内的资产一律保留并提交。
- **无任何引用 → 删除**：一次性浏览器跑批的临时产物、重复跑批目录、服务器日志等。

引用关系按「相对引用方文件解析相对路径」判定，因此 UAT 报告里 `[截图](screenshots/xxx.png)`
这类**相对链接**也能被正确识别；`runtime-*` 等临时目录不参与引用判定（不可作为引用来源）。

### 6.2 清理结果

| 项目 | 清理前 | 清理后 |
| --- | --- | --- |
| `UAT-AY/` | 317.15MB | 65.13MB |
| `uat/` | 4.97MB | 0（未被任何文件引用，与 `UAT-AY/uat-20260928-request-units` 重复） |
| 删除总量 | — | 244 项 / 256.98MB |

被删除的均为无引用产物，例如重复跑批目录
`release-gate-1.0.0-2026-09-21-*`（14 个）、`current-api-release-gate-2026-09-29*`（5 个）、
`runtime-*` 临时目录、`rerun-UAT-AY-*.json`、`browser-results-*.json` 等。

### 6.3 关键修复：被引用却未受控的资产

清理过程中发现三类「代码已引用、但未纳入版本控制」的资产，若单独删除会导致引用悬空，
本次一并纳入：

| 资产 | 引用方 |
| --- | --- |
| `lib/semantics/request-unit-policy.mjs` | `lib/conversation/question-planner.mjs`（**服务器运行依赖**） |
| `UAT-AY/optimization-evidence-L9Dkk9/uat-results.json`、`B-010-evidence.json` | `verify-b-runtime-regression*.mjs`、`verify-uat-fiscal-source.mjs`（**读取**） |
| `UAT-AY/screenshots/`、`.local-browser-screenshots/codex-iab-*` | `postfix-browser-uat/results.json`、`WYN_API_CAPABILITY_MATRIX.md`、`P0_WYN_LLM_PROGRESS_2026-09-14.md` |

`.local-browser-screenshots/` 此前被整体忽略，与受控文档的引用冲突；现改为
「默认忽略、白名单保留被引用的 `codex-iab-*` 证据」，`.local-browser-profile/`
（含 Cookies/Login Data）继续整体忽略。

### 6.4 验证

- 505 个受控文件全部保留，无任何受控文件被删除；
- 删除集静态校验「位于仓库内且未受版本控制」通过（越界/受控冲突 = 0）；
- `npm run check`、`npm test`（584 项）全部通过；
- 清理后 `git ls-files` 与工作区一致，无引用悬空。
