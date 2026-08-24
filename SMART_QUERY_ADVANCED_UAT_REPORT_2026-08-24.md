# 独立智能问数高级语义与多轮 UAT 验收报告

> 验收日期：2026-08-24（Asia/Shanghai）  
> 服务地址：http://127.0.0.1:8787  
> 数据集：2b445034-38fe-4350-9cab-b7684c28b5f8，revision 7  
> 证据协议：wynai.advanced-multiturn-uat/v1、wynai.advanced-browser-api-crosscheck/v1

## 验收结论

本轮高级语义、多轮对话和澄清状态增强通过验收。最终静态检查通过，全量自动化测试 128/128。用户反馈场景已修复；自规划 50 组复杂客户场景共执行 101 轮，真实 Wyn API 50/50 通过；桌面浏览器 50/50 通过；390x844 移动端代表性高风险场景 10/10 通过；60 张截图与 API 结果交叉核验 60/60 通过。页面横向溢出、消息区溢出、输入区遮挡和控制台错误均为 0。

这一定义的是本轮已规划范围通过，不外推为双权限账号、非索引数据集、身份代理、分布式存储或向量知识库已经完成。

## 客户视角验收标准

| 维度 | 验收方法 | 结果 |
| --- | --- | --- |
| 意图准确性 | 对每轮 Intent、QueryProgram、Canonical Query 与原问题约束做一致性断言 | 101/101 轮符合预期 |
| 数据准确性 | 使用管理员上下文直接调用 Wyn 数据集查询，核对期间、分组、指标、排名和派生值 | 50/50 场景通过 |
| 多轮连续性 | 实际提交“改成利润”“只看华东”“再看同比/环比”等追问 | 指标、时间、维度、筛选、排名和派生指标按显式修改继承 |
| 澄清体验 | 提交 10 组指代不明问题，再用自然语言补充维度 | 10/10 先澄清、后执行；Pending 不污染 Committed |
| 桌面可用性 | 1440x1000 逐场景真实提交、等待渲染、核对可见文本并截图 | 50/50，通过且无控制台错误 |
| 移动可用性 | 390x844 覆盖同比、环比、分区 TopN、累计、澄清、复合指标和三轮追问 | 10/10，通过且无遮挡/页面横向溢出 |
| 证据完整性 | 校验 JPEG、固定视口尺寸、文件大小、SHA-256 唯一性，并与 API/浏览器 JSON 对照 | 60/60，60 个唯一哈希 |

## 覆盖设计

| 组别 | 用例 | 重点 |
| --- | --- | --- |
| A | AMT-001 至 AMT-010 | 年/月同比、月环比、基期扩展、复合指标及筛选追问 |
| B | AMT-011 至 AMT-020 | 按年份/城市/地区/经理分区的组内 TopN 与指标切换 |
| C | AMT-021 至 AMT-030 | 完整年度、累计口径、Skill 业务实体映射和多类维度 |
| D | AMT-031 至 AMT-040 | 真正澄清状态机、Pending/Committed 上下文和 IntentPatch |
| E | AMT-041 至 AMT-050 | 多指标、年/季/月粒度、两到三轮连续修改和派生指标追加 |

## 关键结果合理性复核

| 场景 | 真实结果 | 合理性结论 |
| --- | --- | --- |
| 2023/2024/2025 销售额第一省份 | 浙江省 / 天津市 / 浙江省 | 按年份分别排名，不再把全期间压成单一 Top1 |
| 2023-2025 销售额同比 | +4.06% / -6.07% / -70.65% | 查询自动扩展 2022 基期，页面只投影用户要求的三年 |
| 过去三个完整年度 | 2023-2025 | 当前日期为 2026-08-24，排除未完整的 2026 年 |
| 销售经理累计销售额前三 | 李芳 / 张雪眉 / 王伟 | “销售经理”经 approved Skill 映射到“员工姓名”，累计后再排名 |
| 澄清“过去三年累计前三的是谁” | 首轮等待维度；补充销售经理后执行 | 时间、累计、Top3 在 Pending 中保留，补充维度后一次提交 |
| 移动端复杂表格 | 表格内部可横向滚动 | 页面本身无横向溢出，输入区和底部导航无重叠 |

## 缺陷闭环

| 编号 | 首轮问题 | 平台级修复 | 回归 |
| --- | --- | --- | --- |
| B-022 | 多年份 TopN 被当成全局排名，无法得到“每年第一” | QueryProgram 增加分区排名，按 period 或业务分区独立取 TopN | AMT-011 至 020；自动化组内排名测试通过 |
| B-023 | 同比/环比缺少正确基期，或把基期暴露到结果中 | 根据粒度自动扩展查询窗口，派生后只投影用户期间，并声明 percentage Schema | AMT-001 至 010、047 至 050 通过 |
| B-024 | “每年”既被当成分组又被误当成显式时间范围 | 时间范围、时间粒度、完整年度策略分离；无范围时不伪造范围约束 | “华东地区每年销售额和同比”及相关回归通过 |
| B-025 | 指代不明时没有真正 Pending 状态，补充回答可能丢失原问题条件 | Pending/Committed 双上下文状态机；仅受控 wynai.intent-patch/v1 可提交；支持取消 | AMT-031 至 040 通过 |
| B-026 | “销售经理”未稳定映射到数据集字段 | approved Skill 业务实体将销售经理映射为员工姓名并保留 SkillRef 审计 | AMT-020、021、031、045 通过 |
| B-027 | 筛选追问可能丢失同比/环比或复合指标 | 修改式追问继承全部未被显式替换的指标与派生指标 | AMT-001 至 010、041、047 通过 |
| B-028 | “改成利润”或“再看同比”后派生指标仍可能绑定旧指标 | 按当前显式指标重绑 derived metric alias/source，并保留时间与排名 | AMT-011 至 017、047 至 050 通过 |

## 50 组逐案记录

| ID | 场景 | 客户问题链 | 状态链 | 最终结果行数 | 桌面截图 | 移动截图 |
| --- | --- | --- | --- | ---: | --- | --- |
| AMT-001 | 三年销售额同比后限定华东 | 2023至2025年销售额和销售额同比增长率<br>→ 只看华东 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-001.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-001-mobile.jpg) |
| AMT-002 | 三年利润同比后限定华东 | 2023至2025年利润和利润同比增长率<br>→ 只看华东 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-002.jpg) | — |
| AMT-003 | 三年销量同比后限定华东 | 2023至2025年销量和销量同比增长率<br>→ 只看华东 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-003.jpg) | — |
| AMT-004 | 月销售额环比后限定华东 | 2025年每月销售额和环比增长率<br>→ 只看华东 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-004.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-004-mobile.jpg) |
| AMT-005 | 月利润环比后限定华东 | 2025年每月利润和环比增长率<br>→ 只看华东 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-005.jpg) | — |
| AMT-006 | 月销量环比后限定华东 | 2025年每月销量和环比增长率<br>→ 只看华东 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-006.jpg) | — |
| AMT-007 | 月销售额同比后限定华东 | 2025年每月销售额和同比增长率<br>→ 只看华东 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-007.jpg) | — |
| AMT-008 | 月利润同比后限定华东 | 2025年每月利润和同比增长率<br>→ 只看华东 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-008.jpg) | — |
| AMT-009 | 复合指标与销售额同比 | 2023至2025年销售额、利润和销售额同比增长率<br>→ 只看华东 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-009.jpg) | — |
| AMT-010 | 复合指标与销量同比 | 2023至2025年销售额、销量和销量同比增长率<br>→ 只看华东 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-010.jpg) | — |
| AMT-011 | 每年省份冠军后切利润 | 2023、2024、2025年销售额排名第一的省份分别是哪个<br>→ 改成利润 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-011.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-011-mobile.jpg) |
| AMT-012 | 每年城市冠军后切利润 | 2023至2025年每年销售额最高的城市<br>→ 改成利润 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-012.jpg) | — |
| AMT-013 | 每年省份利润后两名后切销售额 | 2023至2025年每年利润最低的两个省份<br>→ 改成销售额 | ok → ok | 6 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-013.jpg) | — |
| AMT-014 | 每年产品销量前三后切销售额 | 2023至2025年每年销量前三的产品<br>→ 改成销售额 | ok → ok | 9 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-014.jpg) | — |
| AMT-015 | 每年省份销售额前二后切利润 | 2023至2025年每年销售额前两个省份<br>→ 改成利润 | ok → ok | 6 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-015.jpg) | — |
| AMT-016 | 每年城市利润前三后限定华东 | 2023至2025年每年利润前三的城市<br>→ 只看华东 | ok → ok | 9 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-016.jpg) | — |
| AMT-017 | 每年类别销量冠军后切销售额 | 2023至2025年每年销量最高的商品类别<br>→ 改成销售额 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-017.jpg) | — |
| AMT-018 | 每城利润最高产品后限定华东 | 每个城市利润最高的产品<br>→ 只看华东 | ok → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-018.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-018-mobile.jpg) |
| AMT-019 | 每地区销售额最高客户后切利润 | 每个地区销售额最高的客户<br>→ 改成利润 | ok → ok | 6 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-019.jpg) | — |
| AMT-020 | 每经理销售额最高产品后切利润 | 每个销售经理销售额最高的产品<br>→ 改成利润 | ok → ok | 9 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-020.jpg) | — |
| AMT-021 | 三年销售经理累计前三后切利润 | 过去三年销售额累计排名前三的销售经理是谁<br>→ 改成利润 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-021.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-021-mobile.jpg) |
| AMT-022 | 五年销售经理累计前五后限定华东 | 过去五年销售额累计排名前五的销售经理<br>→ 只看华东 | ok → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-022.jpg) | — |
| AMT-023 | 三年员工利润后三后切销售额 | 过去三年累计利润最低的三个员工<br>→ 改成销售额 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-023.jpg) | — |
| AMT-024 | 三年客户累计销售额前五后限定华东 | 2023至2025累计销售额前五的客户<br>→ 只看华东 | ok → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-024.jpg) | — |
| AMT-025 | 三年产品累计利润前五后切销量 | 2023至2025累计利润前五的产品<br>→ 改成销量 | ok → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-025.jpg) | — |
| AMT-026 | 三年供应商累计销售额前五后切利润 | 2023至2025累计销售额前五的供应商<br>→ 改成利润 | ok → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-026.jpg) | — |
| AMT-027 | 三年城市累计销售额前五后限定华东 | 2023至2025累计销售额前五的城市<br>→ 只看华东 | ok → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-027.jpg) | — |
| AMT-028 | 三年省份累计利润前三后切销售额 | 2023至2025累计利润前三的省份<br>→ 改成销售额 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-028.jpg) | — |
| AMT-029 | 三年类别累计销量前三后切利润 | 2023至2025累计销量前三的商品类别<br>→ 改成利润 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-029.jpg) | — |
| AMT-030 | 三年运货商累计销售额前三后切利润 | 2023至2025累计销售额前三的运货商<br>→ 改成利润 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-030.jpg) | — |
| AMT-031 | 澄清销售经理维度 | 过去三年销售额累计排名前三的是谁<br>→ 我是需要按照销售经理作为维度 | needs_clarification → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-031.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-031-mobile.jpg) |
| AMT-032 | 澄清商品类别维度 | 2025年销售额最高的是哪个<br>→ 按照商品类别作为维度 | needs_clarification → ok | 1 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-032.jpg) | — |
| AMT-033 | 澄清客户维度 | 去年利润最低的五个是谁<br>→ 按客户维度 | needs_clarification → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-033.jpg) | — |
| AMT-034 | 澄清城市维度 | 2023至2025累计销售额最高的是谁<br>→ 按城市维度 | needs_clarification → ok | 1 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-034.jpg) | — |
| AMT-035 | 澄清省份维度 | 2023至2025累计利润前三的是哪些<br>→ 按省份维度 | needs_clarification → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-035.jpg) | — |
| AMT-036 | 澄清产品维度 | 2025年销量前十的是哪些<br>→ 按产品名称维度 | needs_clarification → ok | 10 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-036.jpg) | — |
| AMT-037 | 澄清供应商维度 | 过去三年累计销售额前五的是谁<br>→ 按供应商维度 | needs_clarification → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-037.jpg) | — |
| AMT-038 | 澄清运货商维度 | 2024年利润后三名是谁<br>→ 按运货商维度 | needs_clarification → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-038.jpg) | — |
| AMT-039 | 澄清支付方式维度 | 2025年销售额最高的是哪一种<br>→ 按支付方式维度 | needs_clarification → ok | 1 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-039.jpg) | — |
| AMT-040 | 澄清每年城市冠军 | 2023至2025年每年销售额最高的是谁<br>→ 按城市维度 | needs_clarification → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-040.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-040-mobile.jpg) |
| AMT-041 | 省份双指标后限定华东 | 2023至2025年各省销售额和利润<br>→ 只看华东 | ok → ok | 5 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-041.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-041-mobile.jpg) |
| AMT-042 | 年度省份销售额后切利润 | 2023至2025年每年各省销售额<br>→ 改成利润 | ok → ok | 48 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-042.jpg) | — |
| AMT-043 | 季度利润后切销售额 | 2025年按季度看利润<br>→ 改成销售额 | ok → ok | 1 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-043.jpg) | — |
| AMT-044 | 月销售额后限定华东 | 2025年每月销售额<br>→ 只看华东 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-044.jpg) | — |
| AMT-045 | 三年销售经理累计后切利润 | 过去三年按销售经理累计销售额<br>→ 改成利润 | ok → ok | 9 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-045.jpg) | — |
| AMT-046 | 三年趋势连续切指标和地区 | 2023至2025年销售额趋势<br>→ 改成利润<br>→ 只看华东 | ok → ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-046.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-046-mobile.jpg) |
| AMT-047 | 华东年度同比后切利润同比 | 华东地区每年销售额和同比增长率<br>→ 改成利润 | ok → ok | 9 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-047.jpg) | — |
| AMT-048 | 年度趋势追加同比 | 2023至2025年销售额趋势<br>→ 再看同比增长率 | ok → ok | 3 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-048.jpg) | — |
| AMT-049 | 月销售额追加环比 | 2025年每月销售额<br>→ 再看环比增长率 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-049.jpg) | — |
| AMT-050 | 月利润追加同比 | 2025年每月利润<br>→ 再看同比增长率 | ok → ok | 2 | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/amt-050.jpg) | [查看](test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-mobile/amt-050-mobile.jpg) |
## 截图人工复核记录

| 截图 | 人工观察 |
| --- | --- |
| AMT-001 桌面 | 两轮消息清晰；同比为 4.06%/-6.07%/-70.65%；限定华东后上下文和派生指标仍在 |
| AMT-011 桌面 | 2023/2024/2025 各自只有一个冠军；改利润后按自然年份顺序显示 |
| AMT-031 桌面 | 可见用户补充“按照销售经理作为维度”；最终为李芳、张雪眉、王伟及精确金额 |
| AMT-040 移动 | 复杂分区结果位于对话流内；表格内部滚动，输入区、数据集选择区和底部导航无重叠 |

## 证据索引

- API 全量结果：test/uat-artifacts/advanced-multiturn-50/2026-08-24/api-results.json
- 桌面浏览器结果：test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/browser-desktop-results.json
- 移动浏览器结果：test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/browser-mobile-results.json
- 60 张截图：test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence/screenshots-desktop/ 与 screenshots-mobile/
- 自动交叉核验：test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence-verification.json
- 原始证据归档：test/uat-artifacts/advanced-multiturn-50/2026-08-24/browser-evidence.zip
- 可重复执行：npm run uat:advanced50
- 可重复核验：npm run uat:advanced50:verify

## 未纳入本轮完成结论的依赖

| 项目 | 原因 | 状态 |
| --- | --- | --- |
| 双账号数据集/行级权限穿透 | 仍需用户提供两类受限账号 | 未启动，不阻断管理员范围验收 |
| 非索引数据集完整性策略 | 需要一个明确关闭索引的真实数据集 | 未启动，不把 NONE 样本当完整统计 |
| 向量知识库 | 第一阶段明确暂不接入 | 未启动 |
| 生产身份代理、分布式会话/审计存储 | 需要部署架构和生产身份上下文 | 未启动 |
