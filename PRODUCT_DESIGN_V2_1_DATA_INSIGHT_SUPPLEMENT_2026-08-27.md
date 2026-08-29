# PRODUCT_DESIGN_V2_1 数据洞察增强补充

工作台首屏同时展示标准输入、运行模式、外部模型状态、InsightDocument 结论和证据引用；用户可从 `interpret` 进入关联 `explore`，也可返回原结果。导出菜单提供 HTML、Markdown 和 InsightDocument JSON；版本栏支持生成历史与差异比较。运行失败显示可重试状态，不以固定统计摘要替代业务洞察。桌面和严格 390x844 移动布局均纳入发布门禁。

该补充与 `PRODUCT_DESIGN_V2_1.md` 同版本发布，作为 2026-08-27 阶段 5/6 设计验收记录。

## 2026-08-28 平台化可靠性设计基线

下一阶段采用 Fact-first、Skill-driven 和 Gateway 统一治理：标准输入先经过 Skill 解析、Business Fact Pack 和确定性事实引擎，再进入标准/深度 LLM 路径；LLM 超时、错误或结论无法校验时展示领域化 `degraded` 结果，不以通用摘要伪装为完成的 AI 洞察。外部 `InsightInput v1` 不变，服务继续固定使用 8787 端口。

UAT 拆分为平台级 P0-P4 与模块级 M0-M4。阶段 A 采用平台 P1/关键 P2/异常关键 P3，数据洞察模块采用 M2/销售场景 M3。详细动作、证据和级别选择规则统一见 `PLATFORM_AND_MODULE_UAT_GOVERNANCE.md`。
