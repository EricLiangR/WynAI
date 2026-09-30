# 受治理语义映射 UAT 验收报告

- 日期：2026-09-22
- 应用地址：`http://127.0.0.1:8787/`
- 数据集：`01测试销售订单-09`
- 数据集 ID：`18b86197-65e3-4682-8501-6e7125afad02`
- Skill：`sales-opportunity-a53@1.3.0`
- 验收方式：Codex 内置浏览器真实用户操作、页面截图、技术详情与控制台日志核对
- 结论：4/4 通过

## 验收结果

| 用例 | 问题/场景 | 预期 | 实际 | 结论 | 证据 |
|---|---|---|---|---|---|
| GSM-001 | MNC客户中商机金额最高的5个项目，返回项目名称、partner | 正确解析 MNC、partner，返回前 5 项 | 返回 5 行，列为项目名称、partner、商机金额 | 通过 | `screenshots/01-mnc-partner-result.png` |
| GSM-002 | GSM-001 技术详情 | 客户类型使用成员包含；partner 绑定真实字段；Wyn 负责查询计算 | `客户类型 包含任一 Multinational Corporation（MNC）`；`partner → Opportunity_partner`；筛选、分组、聚合、排序均由 Wyn 执行；完整结果、非样本、无替代结果 | 通过 | `screenshots/02-mnc-partner-details.png` |
| GSM-003 | MCN客户中商机金额最高的5个项目，返回项目名称、partner | 未知简称不得猜测或执行 | 页面提示当前数据集或 Skill 无 MCN 已确认映射，要求说明业务字段和含义；未展示查询结果表 | 通过 | `screenshots/03-mcn-clarification.png` |
| GSM-004 | POC的项目 | 未知简称不得误映射为 MNC/POE；允许给出待确认候选 | 页面说明 POC 无已确认映射，询问是否指 POE，并允许用户说明 POC 业务含义；未展示查询结果表 | 通过 | `screenshots/04-poc-clarification.png` |

## 自动化证据

`test/governed-semantic-mapping.test.mjs` 覆盖以下边界：

1. MNC 规范值绑定到“客户名称”等错误字段时，在编译前阻断；
2. MCN、POC 被模型猜成已知规范值时必须澄清；
3. POC 直接作为受治理字段源值时仍必须澄清；
4. 合法 MNC 生成 `wynai.governed-mapping-evidence/v1` 完整证据；
5. `partner` 经 Skill 同义词解析为 `Opportunity_partner`。

全量门禁：`npm test` 539/539，`npm run check` 通过。

## 技术核对

- 执行归属：Wyn + platform-validation；
- Wyn 负责：筛选、分组、聚合、排序和 Top 5；
- 样本：否；
- 替代结果：未使用；
- Trace：存在；
- 浏览器控制台：warning 0，error 0；
- 多轮上下文继承：本阶段未修改，也未作为本报告验收范围。

## 结论

本轮改动实现的是平台级证据治理，不是针对 MNC、MCN、POC 或销售问句的固定分支。已批准字典值可以执行，未知简称不能静默进入 Wyn，字段别名可以通过 Skill 解析到真实字段，错误字段绑定会在查询编译前阻断。本工作包满足关闭条件。
