# 销售商机数据字典

本文件是 `sales-opportunity-a53` Skill 的可维护字典源文件。表格完整迁移自旧数据集 `a53ec17a-a8e7-43ce-8552-ec4805071efa` 的数据集描述，包含没有简称的项和原始重复项。服务启动时会解析表格并生成运行时值映射；维护时只需更新本文件。

## 项目状态映射

<!-- dictionary
id: xssl
version: 1.0.0
field: xssl
concept: xssl
sourceColumn: 数据集实际值
canonicalColumn: 数据集实际值
aliasColumn: 用户称呼
matchMode: exact
multiValue: false
-->

| 用户称呼 | 数据集实际值 |
| --- | --- |
| x-ssl | 1 |
| xssl | 1 |
| X-SSL | 1 |

## PSM 状态映射

<!-- dictionary
id: psm
version: 1.0.0
field: is_subcode
concept: psm
sourceColumn: 数据集实际值
canonicalColumn: 数据集实际值
aliasColumn: 用户称呼
matchMode: exact
multiValue: false
-->

| 用户称呼 | 数据集实际值 |
| --- | --- |
| PSM | 1 |
| PSM项目 | 1 |
| PSM来源 | 1 |

## 客户类型

<!-- dictionary
id: customer-type
version: 1.1.0
field: 客户类型
concept: customerType
sourceColumn: 类型编码
canonicalColumn: 类型全称
aliasColumn: 类型简称
matchMode: containsAny
multiValue: true
-->

| 类型编码 | 类型全称 | 类型简称 |
| --- | --- | --- |
| tiger-106 | Private Enterprise |  |
| 111 | Other |  |
| TORDER | TORDER |  |
| State-Owned Enterprise（SOE） | State-Owned Enterprise（SOE） | SOE |
| Specialized Enterprise (SE/央企) | Specialized Enterprise (SE/央企) | SE/央企 |
| Public Entity | Public Entity |  |
| Private Equity Investee | Private Equity Investee |  |
| Private Equity | Private Equity |  |
| Private Entity（POE） | Private Entity（POE） | POE |
| Non-Profit Organization (NPO) | Non-Profit Organization (NPO) | NPO |
| Joint Venture | Joint Venture |  |
| Governmental Organization (GO) | Governmental Organization (GO) | GO |
| Non-Government Organization | Non-Government Organization |  |
| Multinational Corporation（MNC） | Multinational Corporation（MNC） | MNC |
| State-Owned Financial Enterprise (SOFE) | State-Owned Financial Enterprise (SOFE) | SOFE |

维护规则：用户输入客户类型全称或简称时，先映射到本表“类型全称”中的数据集实际成员文本，再按 `客户类型` 字段的多值字符串成员匹配。`类型编码` 保留为原始描述和维护核对信息，不作为本数据集的查询值。多个候选成员使用“包含任一”，只生成对应成员的字符串包含条件，不枚举源数据中可能出现的组合值。数据集实际值以 Wyn 返回值为准。

## recurring

<!-- dictionary
id: recurring
version: 1.0.0
field: recurring
concept: recurring
sourceColumn: 数据值
canonicalColumn: 数据值
aliasColumn: 含义
matchMode: containsAny
multiValue: false
-->

| 数据值 | 含义 |
| --- | --- |
| Yes - Continuous | 老客户、老合同续约 |
| Yes - New Win | 老客户、新合同 |
| No | 不是 recurring |

维护规则：用户说“recurring”时按 `recurring` 字段做模糊筛选，条件为包含 `Yes`；用户明确老客户、老合同续约时使用 `Yes - Continuous`，明确老客户、新合同时使用 `Yes - New Win`，明确不是 recurring 时使用 `No`。不得把 recurring 映射为商机来源，也不得把用户词直接作为枚举值。

## 产品大类

<!-- dictionary
id: product-category
version: 1.0.0
field: 产品大类
concept: productCategory
sourceColumn: 数据值
canonicalColumn: 数据值
aliasColumn: 用户称呼
matchMode: exact
multiValue: false
-->

| 数据值 | 用户称呼 |
| --- | --- |
| Consumer & Retail |  |
| Finance |  |
| Healthcare |  |
| Manufacturing |  |
| Digital Technology |  |

## 产品小类

<!-- dictionary
id: product-subcategory
version: 1.0.0
field: 产品小类
concept: productSubcategory
sourceColumn: 数据值
canonicalColumn: 数据值
aliasColumn: 用户称呼
matchMode: exact
multiValue: false
-->

| 数据值 | 用户称呼 |
| --- | --- |
| Smart Operations |  |
| Organizational Optimization |  |
| Product Development |  |
| Talent Development |  |
| Operational Efficiency |  |
| Investment & Financing |  |
| Risk Management | 风险管理 |
| Financial Management |  |
| Supply Chain Collaboration |  |
| Strategic M&A |  |
| Strategy Planning |  |
| Ecosystem Collaboration |  |

## 客户所属行业

<!-- dictionary
id: customer-industry
version: 1.0.0
field: 客户所属行业
concept: customerIndustry
sourceColumn: 客户所属行业
canonicalColumn: 客户所属行业
aliasColumn: 行业简称
matchMode: exact
multiValue: false
-->

| 客户所属行业 | 行业简称 |
| --- | --- |
| Aggregates & Cement |  |
| Base Metals |  |
| Bulks |  |
| Commodity Trading |  |
| Diversified Miners |  |
| Government & Public Sector | GPS |
| Life Sciences | LS |
| Managed Health Care |  |
| Physician Groups |  |
| Stores, Mass Merch, Discountrs |  |
| Exclusively Online Retail |  |
| Grocery, Convenience, Sprmrket |  |
| Infrastrctr & Public Transport |  |
| National Security & Defense |  |
| Public Financial Management |  |
| Agencies |  |
| tbd - LS |  |
| Steel |  |
| Consumer Durables |  |
| Food & Beverage |  |
| Agribusiness |  |
| Apparel, Footwear, Accessories |  |
| Education |  |
| Federal, Natl & Intl Govt |  |
| Hospitality, Gaming, Restrnts |  |
| Insurance Agents & Brokers |  |
| Cable / MVPD |  |
| Integrated Telecommunications |  |
| Wireless Communication Svcs |  |
| Auto Dstrbtn,Dealer,Aftersales |  |
| Basic, Inorganic & Petro Chemicals |  |
| Pulp, Paper & Packaging Materials |  |
| Machinery & Electrical Systms |  |
| Industrial Conglomerates |  |
| Passenger Vehicle Man'facturrs |  |
| Personal Services |  |
| Professional Service Firms |  |
| Rental & Leasing Services |  |
| Travel Services |  |
| Automotive Finance |  |
| Logistics |  |
| Shipping |  |
| Beverage |  |
| Food |  |
| Retail |  |
| Energy Trading |  |
| Gaming |  |
| Hospitality & Tourism |  |
| Restaurant |  |
| Fleet, Rental & Leasing |  |
| Mobility-as-a-Service |  |
| Crop Protection & Seed Solutions |  |
| Household & Personal Care (HPC) |  |
| Grocery |  |
| Hardlines |  |
| Softlines |  |
| Specialty Products & Advanced Materials |  |
| Agrochemicals |  |
| Real Estate Services |  |
| To Be Determined |  |
| Asset Managers |  |
| Private Equity |  |
| Ag Processors |  |
| Critical Minerals |  |
| tbd - CP |  |
| tbd - Retail |  |
| Consumer Products |  |
| Retail |  |
| Data Centers |  |
| Aluminium |  |
| Health | Health |
| Private Equity | PE |
| Health Care Distributors/Vendors |  |
| Non-acute care facilities |  |
| Health-Other |  |
| Satellite |  |
| tbd - M&M |  |
| tbd - P&U |  |
| To Be Determined |  |
| Commercial Vehicle Manufctrrs |  |
| Custodians & Depositories |  |
| Financial Mkts Infrastructure |  |
| Consumer Banking |  |
| Household & Personal Care |  |
| Tobacco |  |
| Primary & Community HC Orgs |  |
| International Development |  |
| Private Equity Funds |  |
| State & Local Government |  |
| Health Insurers |  |
| Internet & Social Commerce |  |
| Towers & Infrastructure |  |
| Wireline Communication Svs |  |
| Reinsurers |  |
| Entertainment Networks (Broadcast, Cable, Streaming) |  |
| Water & Waste Services |  |
| Development: Commercial, Residential & Mixed Use |  |
| Real Estate Investment Trusts |  |
| RE Funds & Investment Mgmt |  |
| IT Services / Cloud Platforms |  |
| Semiconductors |  |
| Entertainment Content (Film, Gaming, Music, TV) |  |
| Publishing |  |
| Sports / Live / Experiential |  |
| Oil Field Services |  |
| Medical Devices & Diagnostics |  |
| Pharma Mfg & Wholesalers |  |
| Integrated Energy Utilities |  |
| Aerospace & Defense Mfg |  |
| Composite Insurers |  |
| Health Service Providers |  |
| Downstream |  |
| Integrated Companies |  |
| Midstream |  |
| National Oil Company (NOC) |  |
| Upstream |  |
| tbd - M&E |  |
| tbd - WAM |  |
| tbd - Mobility |  |
| Renewable Energy |  |
| Construction & Engineering |  |
| Independent Power Producers |  |
| Indstrl & Mechn'cl Components |  |
| Networking & Comms Equipment |  |
| Computers & Electronics |  |
| Software, SaaS, Apps |  |
| Airlines |  |
| Mining Services |  |
| Business Services |  |
| Precious Metals |  |
| Data & Information Services |  |
| Central Banks & Regulatory Authorities |  |
| Cable / MVPDs |  |
| Corporate, Commercial & SME Banking |  |
| Oil & Gas | O&G |
| Health Research & Testing |  |
| Rail |  |
| Technology | Tech |
| Consumer Products & Retail | CPR |
| Life Insurers |  |
| Property & Casualty Insurers |  |
| Regulated Funds |  |
| Wholesalers & Distribution |  |
| tbd - O&G |  |
| Operations & Orgnztnl Change |  |
| Social Services & Pensions |  |
| Tech & Digital Government |  |
| Health Payers, Commissioners |  |
| Pharmaceuticals & Contract Mfg |  |
| Alternative Investments |  |
| Component Suppliers |  |
| Hospitals & Academic Hlth Ctrs |  |
| Public Transportation |  |
| Insurance | Ins |
| Banking & Capital Markets | Bank & CM |
| tbd - PFS |  |
| tbd - Health |  |
| Energy Networks |  |
| Energy Retailers |  |
| Asset Servicing, Svc Providers |  |
| Pension Funds & SWFs |  |
| Mobility | Mob |
| Mining & Metals | M&M |
| Professional Firms & Services | PFS |
| Telecommunications | Telecom |
| Hedge Funds |  |
| Broker Dealers |  |
| Homebuilders |  |
| Depts of Health / Governments |  |
| Payments |  |
| Restaurants |  |
| tbd - BCM |  |
| tbd - AM |  |
| tbd - GPS |  |
| tbd - Ins |  |
| Cruise Lines, Attractions & Travel |  |
| tbd - CP&R |  |
| Wealth & Asset Management | WAM |
| tbd - RHC |  |
| Investment Bkg & Capital Mkts |  |
| tbd - Tech |  |
| tbd - Tele |  |
| Private Households |  |
| Wealth & Private Banking |  |
| Biotechnology |  |
| Advanced Manufacturing | AMM |
| Private Households | PH |
| RE, Hospitality & Construction | RHC |
| Media & Entertainment | M&E |
| Power & Utilities | P&U |
| Health Care Services |  |
| Consumer Products & Retail | CPR |
| Advanced Manufacturing | AMM |
