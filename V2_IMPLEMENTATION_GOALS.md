# V2 首个开发切片目标与验收标准

> 状态：Completed  
> 日期：2026-08-01  
> 关联需求：[PRODUCT_REQUIREMENTS_V2.md](./PRODUCT_REQUIREMENTS_V2.md)  
> 关联设计：[PRODUCT_DESIGN_V2.md](./PRODUCT_DESIGN_V2.md)

> 能力边界：这里的 Completed 仅表示“查询三层解耦首个切片”完成，不代表自主探索目标完成。固定 baseline/trend/structure/growth-driver 仍是已知缺口，后续目标见 [V2_1_IMPLEMENTATION_GOALS.md](./V2_1_IMPLEMENTATION_GOALS.md)。

## 1. 本轮目标

完成一个可在真实 Wyn 数据集上运行的纵向切片，证明系统不再依赖单一查询方式：智能体提出平台无关的查询需求，路由器根据需求选择明细或聚合执行接口，所有返回值进入统一结果集，再由分析程序动态判断是否继续下钻。

## 2. 必须交付

1. `CanonicalQueryRequest`：只表达指标、维度、粒度、过滤、比较和结果规模，禁止 WAX、SQL 与原始 Pivot Payload。
2. `ControlledWaxAdapter`：承担完整数据集聚合，WAX 仅在服务端短期编译和执行。
3. `DatasetNoneAdapter`：承担受控明细样本，显式标记采样、截断和本地过滤限制。
4. `QueryRouter`：依据查询模式与数据集能力选择适配器，不由 Planner 指定底层协议。
5. `CanonicalResultSet`：统一 Schema、Rows、Statistics、Scope、Provenance 和 Quality。
6. 两轮 Harness：第一轮建立基线和趋势；第二轮根据趋势动态追加“时间 × 区域”和“时间 × 类别”来源验证。
7. 证据范围校验：结论与证据的指标、维度、期间和过滤必须一致。
8. V2 前端：只选择数据集即可启动；关注方向可选；筛选放入默认折叠的高级设置。
9. V2 API、运行持久化和 HTML、Markdown、JSON 报告导出。
10. 自动化测试与真实 Wyn UAT 结果记录。

## 3. 验收门槛

| 门槛 | 目标 |
| --- | --- |
| 现有 V1 回归 | 全部通过 |
| V2 单元与契约测试 | 全部通过 |
| Canonical 请求包含原始 WAX/SQL | 100% 拒绝 |
| V2 开放式启动 | 仅 `datasetId` 必填 |
| 查询执行适配器 | 至少 NONE 与 WAX 两类 |
| 动态分析轮次 | 基线后按结果追加增长来源查询 |
| 增长来源证据范围 | 指标、时间、维度和过滤 100% 匹配 |
| 明细持久化 | 默认不保存明细行 |
| 数值发现证据覆盖率 | 100% |
| 真实 Wyn UAT | UVT-V2-01 至 UVT-V2-08 全部通过 |
| 界面 UAT | 桌面核心路径可操作、可滚动、无内容截断 |

## 4. 非目标

- 本切片不接入未经正式验证的 Pivot 内部协议。
- 本切片不开放任意 SQL、任意 WAX、数据源直连或跨数据集 Join。
- 本切片不实现完整行业 Skill、MCP 服务化、RFM、购物篮和因果推断。
- 本切片不把同步 HTTP 执行升级为完整 SSE 任务系统；该项进入后续迭代。

## 5. 完成定义

代码检查、单元测试、真实接口 UAT、浏览器界面 UAT 和安全检查均已通过，实际结果见 [UAT_V2_RESULTS.md](./UAT_V2_RESULTS.md)。
