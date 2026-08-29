import { decideVisualization } from './visualization/visualization-spec.mjs';

export const RESULT_PRESENTATION_PLAN_SCHEMA = 'wynai.result-presentation-plan/v1';
function unique(values) { return [...new Set((values || []).filter(value => value != null && value !== ''))]; }
function columnLabel(column, fallback) { return column?.displayName || column?.sourceField || fallback; }
function explicitTimeGrouping(question = '') { return /(?:按|按照|每个?|以|根据)(?:年|年度|年份|月|月份|季度|周|日)|年月|趋势|时间序列|逐月|逐年/.test(String(question)); }
function dimensionHierarchy(descriptor) {
  const concept = descriptor?.concept || (() => {
    const text = [descriptor?.sourceField, descriptor?.label, descriptor?.field].filter(Boolean).join(' ');
    if (/大区|地区|区域/.test(text)) return 'region';
    if (/省份/.test(text)) return 'province';
    if (/城市/.test(text)) return 'city';
    if (/类别|品类|种类/.test(text)) return 'category';
    if (/商品|产品/.test(text)) return 'product';
    return '';
  })();
  const grain = descriptor?.grain || '';
  if (descriptor?.temporal || concept === 'time') return { group: 'time', rank: ({ year: 0, quarter: 1, month: 2, week: 3, day: 4 })[grain] ?? 9 };
  if (['region', 'customerProvince', 'province', 'city'].includes(concept)) {
    return { group: 'geography', rank: ({ region: 0, customerProvince: 1, province: 1, city: 2 })[concept] ?? 9 };
  }
  if (['category', 'product'].includes(concept)) return { group: 'product', rank: concept === 'category' ? 0 : 1 };
  return { group: `field:${descriptor?.field || ''}`, rank: 0 };
}
function mentionIndex(question, descriptor) {
  const text = String(question || '');
  const values = [descriptor?.sourceField, descriptor?.label, descriptor?.field].filter(value => String(value || '').length >= 2);
  const indexes = values.map(value => text.indexOf(String(value))).filter(index => index >= 0);
  if (descriptor?.temporal) {
    const temporal = [...text.matchAll(/(?:按|按照|每个?|逐|各个?)?(?:年|季度|季|月|月份|周|日)/g)].map(match => match.index ?? -1).filter(index => index >= 0);
    indexes.push(...temporal);
  }
  return indexes.length ? Math.min(...indexes) : Number.MAX_SAFE_INTEGER;
}
function orderDimensions(dimensions, question) {
  const enriched = dimensions.map((item, index) => ({ item, index, position: mentionIndex(question, item), hierarchy: dimensionHierarchy(item) }));
  const groups = new Map();
  for (const entry of enriched) {
    const current = groups.get(entry.hierarchy.group) || { first: entry.position, entries: [] };
    current.first = Math.min(current.first, entry.position);
    current.entries.push(entry);
    groups.set(entry.hierarchy.group, current);
  }
  return [...groups.values()]
    .sort((left, right) => left.first - right.first)
    .flatMap(group => group.entries.sort((left, right) => left.hierarchy.rank - right.hierarchy.rank || left.position - right.position || left.index - right.index))
    .map(entry => entry.item);
}
function orderMeasures(measures, request, question) {
  const baseOrder = new Map((request?.measures || []).map((item, index) => [item.alias || item.field, index]));
  const derivedBase = field => {
    const value = String(field || '');
    const match = value.match(/^(revenue|profit|order_count|quantity)_(?:yoy|mom|share)$/);
    return match?.[1] || null;
  };
  return measures.map((item, index) => ({ item, index, order: baseOrder.get(item.field), base: derivedBase(item.field), position: String(question || '').indexOf(item.label || item.sourceField || '') }))
    .sort((left, right) => {
      const leftOrder = left.order ?? (left.base != null && baseOrder.has(left.base) ? baseOrder.get(left.base) + 0.5 : Number.MAX_SAFE_INTEGER);
      const rightOrder = right.order ?? (right.base != null && baseOrder.has(right.base) ? baseOrder.get(right.base) + 0.5 : Number.MAX_SAFE_INTEGER);
      return leftOrder - rightOrder || left.position - right.position || left.index - right.index;
    })
    .map(entry => entry.item);
}
function buildDescriptors(request = {}, resultSet = {}, question = '') {
  const schema = resultSet?.schema || [];
  const schemaMap = new Map(schema.map(column => [column.name, column]));
  const timeGrouping = explicitTimeGrouping(question);
  const dimensions = (request.select || []).map(item => {
    const column = schemaMap.get(item.alias) || {};
    const values = unique((resultSet?.rows || []).map(row => row?.[item.alias]));
    const temporal = Boolean(item.grain || column.grain || column.type === 'date' || /日期|时间|年|月|季度|周|日|date|time/i.test(`${item.field || ''} ${columnLabel(column, item.alias)}`));
    const visible = !(temporal && values.length <= 1 && !timeGrouping && !item.internal);
    return { field: item.alias, sourceField: item.field || item.alias, label: columnLabel(column, item.field || item.alias), grain: item.grain || column.grain || null, temporal, cardinality: values.length, visible };
  });
  const requested = new Set((request.measures || []).map(item => item.alias));
  const measures = schema.filter(column => /measure/.test(String(column.role || '')) || requested.has(column.name)).map(column => {
    const requestMeasure = (request.measures || []).find(item => item.alias === column.name);
    const label = columnLabel(column, requestMeasure?.field || column.name);
    const percentage = column.format === 'percentage' || column.resultType === 'percentage' || /率|占比|比例|同比|环比|percent|ratio/i.test(`${label} ${column.name}`);
    return { field: column.name, sourceField: requestMeasure?.field || column.sourceField || column.name, label, percentage, aggregation: requestMeasure?.aggregation || column.aggregation || null, derived: column.role === 'derived-measure' || Boolean(requestMeasure?.derived) };
  });
  return { dimensions: orderDimensions(dimensions, question), measures: orderMeasures(measures, request, question) };
}
function tableColumns(descriptors) { return [...descriptors.dimensions.filter(item => item.visible), ...descriptors.measures].map(item => item.field); }
function chartColumns(visualization) { return visualization ? [visualization.encoding.category.field, visualization.encoding.seriesDimension?.field, visualization.encoding.facetDimension?.field, ...visualization.encoding.measures.map(item => item.field)].filter(Boolean) : []; }
export function buildResultPresentationPlan({ metadata = null, question = '', request = {}, resultSet = {}, previousVisualization = null } = {}) {
  const descriptors = buildDescriptors(request, resultSet, question);
  const effectiveRequest = { ...request, select: request.select?.filter(item => descriptors.dimensions.find(dimension => dimension.field === item.alias)?.visible) || [] };
  const visualizationDecision = decideVisualization({ metadata, question, request, resultSet, previous: previousVisualization });
  const visualization = visualizationDecision.spec || null;
  const table = { columns: tableColumns(descriptors), pageSize: 100, preserveAllReturnedRows: true };
  const mode = visualization ? 'chart-and-table' : 'table-only';
  const priority = visualization ? (/(各自|分别|明细|是多少|原始值|数据表|表格)/.test(question) ? 'table' : 'chart') : 'table';
  return {
    schema: RESULT_PRESENTATION_PLAN_SCHEMA,
    version: 1,
    mode,
    priority,
    dimensions: descriptors.dimensions.map(item => ({ ...item, role: visualization?.encoding.category.field === item.field ? 'category' : visualization?.encoding.seriesDimension?.field === item.field ? 'series' : visualization?.encoding.facetDimension?.field === item.field ? 'facet' : 'grouping' })),
    metrics: descriptors.measures,
    table,
    chart: visualization ? { columns: chartColumns(visualization), binding: visualization.encoding, visualization } : null,
    decision: { source: visualizationDecision.decision?.source || 'automatic', reason: visualizationDecision.decision?.reason || '结果缺少适合绘图的结构，保留表格。', warnings: visualizationDecision.decision?.warnings || [] },
    queryProjection: { visibleDimensions: effectiveRequest.select?.map(item => item.alias) || [], visibleMetrics: request.measures?.map(item => item.alias) || [] },
  };
}
