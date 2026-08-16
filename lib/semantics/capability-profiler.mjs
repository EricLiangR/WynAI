import { selectAnalysisFields } from '../analysis-core.mjs';

function findAll(fields, patterns, roles = []) {
  return fields.filter(field => (!roles.length || roles.includes(field.role))
    && patterns.some(pattern => pattern.test(`${field.name} ${field.description || ''} ${(field.synonyms || []).join(' ')}`)));
}

function uniqueNames(fields) {
  return [...new Set(fields.filter(Boolean).map(field => field.name))];
}

export function buildSemanticCapabilityProfile(metadata) {
  const fields = metadata?.fields || [];
  const selected = selectAnalysisFields(metadata);
  const measures = fields.filter(field => field.role === 'measure');
  const dimensions = fields.filter(field => ['dimension', 'geography'].includes(field.role));
  const booleanMeasures = measures.filter(field => field.valueKind === 'boolean'
    || /是否|达标|及时|准时|通过/.test(`${field.name} ${field.description || ''}`));
  const complianceMeasures = booleanMeasures.filter(field => /达标|及时|准时|通过|完成率/.test(`${field.name} ${field.description || ''}`));
  const durationMeasures = measures.filter(field => field.valueKind === 'duration'
    || (!field.valueKind
      && /TAT|耗时|时长|用时|周期|分钟|小时|天数/.test(`${field.name} ${field.description || ''}`)
      && !booleanMeasures.includes(field)))
    .filter(field => !/标准|目标|阈值/.test(field.name));
  const roles = {
    time: uniqueNames(fields.filter(field => field.role === 'time')),
    revenue: uniqueNames([selected.primaryMeasure, ...findAll(measures, [/销售额|订单金额|营业收入|收入|成交金额|金额/])]),
    profit: uniqueNames([selected.profitMeasure, ...findAll(measures, [/利润|毛利|收益/])]),
    quantity: uniqueNames([selected.quantityMeasure, ...findAll(measures, [/数量|销量|件数/])]),
    price: uniqueNames(findAll(measures, [/单价|售价|价格/]).filter(field => !/进货|成本/.test(field.name))),
    cost: uniqueNames(findAll(measures, [/成本|进货价|采购价/])) ,
    customer: uniqueNames([selected.customer, ...findAll(dimensions, [/客户|会员|买家/])]),
    product: uniqueNames([selected.product, ...findAll(dimensions, [/商品|产品|SKU/])]),
    category: uniqueNames([selected.category, ...findAll(dimensions, [/类别|品类|分类/])]),
    region: uniqueNames([selected.region, ...findAll(dimensions, [/地区|区域|省份|城市/])]),
    orderId: uniqueNames([selected.orderId]),
    duration: uniqueNames(durationMeasures),
    boolean: uniqueNames(booleanMeasures),
    flag: uniqueNames(complianceMeasures),
    status: uniqueNames(findAll(dimensions, [/状态|阶段|流程/])),
    organization: uniqueNames(findAll(dimensions, [/科室|部门|专业组|团队|机构|实验室/])),
    otherDimensions: uniqueNames(dimensions),
  };
  const described = fields.filter(field => String(field.description || '').trim()).length;
  const semanticRisks = [];
  if (!roles.revenue.length && !measures.length) semanticRisks.push('没有识别到可聚合经营指标');
  if (!roles.time.length) semanticRisks.push('没有识别到时间字段');
  if (described / Math.max(fields.length, 1) < 0.25) semanticRisks.push('字段业务描述覆盖率偏低');
  return {
    dataset: { id: metadata.id, name: metadata.name, revision: metadata.revision ?? null },
    roles,
    capabilities: {
      overview: Boolean(roles.revenue.length || measures.length),
      timeSeries: Boolean(roles.time.length && (roles.revenue.length || measures.length)),
      profitability: Boolean(roles.profit.length && (roles.revenue.length || measures.length)),
      customer: Boolean(roles.customer.length && (roles.revenue.length || measures.length)),
      product: Boolean((roles.product.length || roles.category.length) && (roles.revenue.length || measures.length)),
      geography: Boolean(roles.region.length && (roles.revenue.length || measures.length)),
      quantity: Boolean(roles.quantity.length),
      operationalEfficiency: Boolean(roles.duration.length),
      compliance: Boolean(roles.flag.length),
      processStatus: Boolean(roles.status.length),
      controlledDetail: fields.length > 0,
    },
    fieldCatalog: fields.map(field => ({
      name: field.name,
      type: field.type,
      role: field.role,
      valueKind: field.valueKind || (field.role === 'measure' ? 'continuous' : 'categorical'),
      description: field.description || '',
      synonyms: field.synonyms || [],
    })),
    semanticRisks,
  };
}

export function classifyAnalysisIntent(focus = '', profile) {
  const text = String(focus || '').trim();
  if (/TAT|耗时|时长|达标|准时|危急值|通知|科室|实验室/.test(text)) return 'open';
  if (!text || /自主|开放|全面|综合|全局|经营体检|各(?:个|类|种)?视角|驾驶舱|管理看板|运营分析|经营分析|关键指标|全景/.test(text)) return 'open';
  if (/客户|会员|复购|流失|留存|集中度|大客户|客群/.test(text)) return 'customer';
  if (/产品|商品|品类|类别|SKU|产品结构|商品结构/.test(text)) return 'product';
  if (/异常|波动|突变|骤降|骤增|反常|问题月份/.test(text)) return 'anomaly';
  if (/利润|毛利|盈利|亏损|成本|利润率|收益质量/.test(text)) return 'profitability';
  if (profile?.capabilities?.timeSeries) return 'anomaly';
  return 'open';
}
