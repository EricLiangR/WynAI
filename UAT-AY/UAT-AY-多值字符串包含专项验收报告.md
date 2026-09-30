# UAT-AY 多值字符串包含专项验收报告

## 1. 验收范围

- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- Skill：`sales-opportunity-a53@1.1.0`
- 服务：`http://127.0.0.1:8787/`
- 验收方式：真实浏览器页面、独立会话、可见结果截图；浏览器视口 1440 x 960
- 本轮目标：验证客户类型普通字符串多成员筛选、Markdown 字典映射、Canonical 多值操作符、WAX 受控编译、20,000 行统一上限和前端分页

## 2. UAT 明细

| 编号 | 问题内容 | 测试结论 | 不通过原因分析 | 修复方案 | 修复验收情况 | 相关截图 |
| --- | --- | --- | --- | --- | --- | --- |
| MV-001 | 我的 POE 客户名单 | 通过 | 无 | POE 由 Markdown 字典映射为 `Private Entity（POE）`，使用 `containsAny` | 返回 7 个客户；页面筛选显示 `客户类型 containsAny Private Entity（POE）`，无语义校验错误 | [MV-001](screenshots/MV-001.png) |
| MV-002 | 我的 MNC 客户名单 | 通过 | 首轮出现一次浏览器 `ERR_CONNECTION_REFUSED`，重跑后通过，属于服务热加载/瞬时连接问题，不是查询语义失败 | 保留有限重试和服务稳定性监控；本轮不新增规则降级 | 重跑返回 7 个客户；页面筛选显示 `客户类型 containsAny Multinational Corporation（MNC）` | [MV-002](screenshots/MV-002.png) |
| MV-003 | 我的 POE、MNC 客户名单 | 通过（触发上限提示） | 结果总量 25,078，超过统一 20,000 行上限；平台没有声称已交付完整名单，而是明确提示结果可能不完整 | 统一使用两个同字段 `containsAny` 条件；超过 20,000 直接提示，已返回部分提供前端分页 | 页面显示总数据 25,078、实际返回 20,000、结果可能不完整；第 1 页和第 2 页切换成功，共 200 页 | [MV-003](screenshots/MV-003.png)、[第 1 页](screenshots/MV-003-page-1.png)、[第 2 页](screenshots/MV-003-page-2.png) |
| MV-004 | MNC、POE 客户的商机金额是多少 | 通过 | 无 | MNC/POE 分别映射为规范全称，按同字段多值包含条件组合 | 返回 `7,111,470.13` 元；页面显示两个 `containsAny` 条件 | [MV-004](screenshots/MV-004.png) |
| MV-005 | 不是 MNC 和 POE 客户的商机金额是多少 | 通过 | 无 | 使用 `notContainsAny` 表达“不包含任一成员”，不枚举数据库组合值 | 返回 `2,401,301,728.07` 元；页面显示 `客户类型 notContainsAny Multinational Corporation（MNC）、Private Entity（POE）` | [MV-005](screenshots/MV-005.png) |
| MV-006 | MNC 客户的商机金额大于 20 万的商机有几个 | 通过 | 无 | MNC 使用 `containsAny`，金额阈值仍使用普通数值 `gt` | 返回 4,301 个商机；页面同时显示多值字符串条件和金额阈值条件 | [MV-006](screenshots/MV-006.png) |

## 3. 技术核对

| 层次 | 核对结果 | 证据 |
| --- | --- | --- |
| Skill / Markdown 字典 | 通过 | `skills/sales-opportunity-a53/dictionaries.md` 保留完整客户类型表；MNC→`Multinational Corporation（MNC）`，POE→`Private Entity（POE）`。本轮补充 `fieldSemantics`，声明 String、`delimited-text`、多值成员和四个专用操作符。 |
| Canonical 查询协议 | 通过 | `containsAny`、`containsAll`、`notContainsAny`、`notContainsAll` 已纳入协议；只允许字符串字段，值最多 50 个，并保持本地过滤与远端编译语义一致。 |
| WAX 受控编译 | 通过 | `containsAny` 编译为多个 `FIND(value, column) > 0` 的 OR；`notContainsAny` 编译为多个 `FIND(value, column) = 0` 的 AND；未解析 JSON，也未枚举组合值。 |
| LLM 规划 | 通过 | 页面结果由 LLM 理解并通过查询约束校验；MNC/POE 问题生成 `containsAny`，否定问题生成 `notContainsAny`。 |
| 20,000 行契约 | 通过 | MV-003 真实结果总量 25,078，页面按 20,000 行上限返回并明确提示超限；聚合问题仍正常返回单行结果。 |
| 前端分页 | 通过 | `pagination-evidence.json` 记录第 1 / 200 页→第 2 / 200 页，首行数据发生变化。 |

## 4. 日志和截图分析

- 6 条最终浏览器用例均完成，页面错误数为 0。
- 重跑后的浏览器控制台保留 1 个静态资源 404 和 2 个短暂 `ERR_CONNECTION_REFUSED`。后者只在服务热加载窗口出现，MNC 用例重跑即通过；应作为平台稳定性监控项，不应改变业务查询语义。
- 页面可见筛选条件已经从旧的 `属于/IN` 变为 `containsAny` / `notContainsAny`，且摘要中的 MNC、POE 使用完整规范值，证明字典映射和查询协议在用户可见结果中联动生效。
- MV-003 的真实结果验证了统一上限规则：平台没有按聚合/明细分支设置不同上限，而是统一采用 20,000；超过上限时保留透明提示。

## 5. 本轮变更

1. 增加通用 Skill `fieldSemantics` 承载能力，支持字段类型、存储方式、多值特征和允许操作符；该能力不写死 MNC/POE。
2. 将目标 Skill 的 `客户类型` 声明为普通字符串多成员字段，明确不解析 JSON，并把 MNC/POE 的实际源值映射继续放在 Markdown 字典。
3. 将字段语义传递给语义目录和 LLM 规划上下文，避免只依赖平台硬编码。
4. 修正文档中“可能以 JSON 数组字符串返回”的过时表述。
5. 增加真实浏览器多值验收脚本和分页验收脚本，保留页面截图、结果 JSON、控制台日志和页面错误日志。

## 6. 后续建议

### 已验证，无需立即改动

- 普通字符串多成员字段的四类 Canonical 操作符和 WAX `FIND` 编译路径。
- MNC/POE Markdown 字典映射和用户可见筛选摘要。
- 统一 20,000 行上限以及已返回数据的前端分页。

### 建议后续立项

- 对“超过 20,000 行”的结果增加更明显的超限状态和可操作的缩小筛选建议；完整导出不属于本轮已验证能力。
- 对热加载期间的短暂连接失败增加服务就绪探针、有限重试和更明确的 trace 信息；不引入固定规则降级。
- 若需要修改 Wyn 远端字段描述，应由数据集管理员在 Wyn 中把该字段描述同步为普通字符串多成员语义；本轮采用 Skill 字段语义承载完成平台侧生效，没有冒充已修改远端 Wyn 元数据。

## 7. 证据索引

- 浏览器结果：[results.json](multivalue-browser-uat/results.json)
- 浏览器控制台：[console.json](multivalue-browser-uat/console.json)
- 页面错误：[page-errors.json](multivalue-browser-uat/page-errors.json)
- 分页证据：[pagination-evidence.json](multivalue-browser-uat/pagination-evidence.json)
- 真实截图目录：[screenshots](multivalue-browser-uat/screenshots)
- Skill 字典：[dictionaries.md](../skills/sales-opportunity-a53/dictionaries.md)
