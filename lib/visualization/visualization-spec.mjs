const TYPES = new Set(['line', 'column', 'bar', 'pie', 'donut', 'combo', 'stacked-column']);
const MAX_CHART_ROWS = 500;
const MARKS = new Set(['line', 'bar']);
const AXES = new Set(['left', 'right']);

export const VISUALIZATION_SPEC_SCHEMA = 'wynai.visualization-spec/v1';
export const VISUALIZATION_TYPES = Object.freeze([...TYPES]);

function unique(values) {
  return [...new Set(values.filter(value => value != null && value !== ''))];
}

function safeText(value, fallback = '', limit = 200) {
  return String(value ?? fallback).trim().slice(0, limit);
}

function fieldLabel(column, fallback) {
  return column?.displayName || column?.sourceField || fallback;
}

function isPercentage(column = {}, name = '') {
  return column.format === 'percentage' || column.resultType === 'percentage' || /率|占比|比例|同比|环比|percent|ratio/i.test([fieldLabel(column, name), name].join(' '));
}

function measureUnitFamily(column = {}, name = '', requestMeasure = null) {
  if (isPercentage(column, name)) return 'percentage';
  if (requestMeasure?.unitFamily) return requestMeasure.unitFamily;
  const label = [fieldLabel(column, name), column.sourceField, requestMeasure?.field, name].filter(Boolean).join(' ');
  if (['distinctCount', 'countRows'].includes(requestMeasure?.aggregation) || /订单数|订单量|笔数|人数|客户数|商品数|次数|count/i.test(label)) return 'count';
  if (/金额|销售额|收入|营收|利润|毛利|成本|价格|单价|费用|currency|amount|revenue|profit/i.test(label)) return 'currency';
  if (/时长|耗时|分钟|小时|天数|duration|latency/i.test(label)) return 'duration';
  if (/销量|购买数量|销售数量|件数|数量|quantity/i.test(label)) return 'quantity';
  return 'number';
}

function isTemporal(column = {}, select = {}) {
  return Boolean(select.grain || column.grain || column.type === 'date' || /日期|时间|年|季度|月份|月|周|日|period|date|time/i.test(`${fieldLabel(column, select.field)} ${select.field || ''}`));
}

function typeFromQuestion(question = '') {
  const text = String(question);
  if (/不要图表|无需图表|只(?:要|显示|看)?(?:明细)?表格/.test(text)) return 'none';
  if (/柱线|组合图|双轴/.test(text)) return 'combo';
  if (/堆叠/.test(text) && /柱|条/.test(text)) return 'stacked-column';
  if (/环形|圆环/.test(text)) return 'donut';
  if (/饼图|饼状/.test(text)) return 'pie';
  if (/横向(?:条形|柱)|条形图/.test(text)) return 'bar';
  if (/柱形图|柱状图/.test(text)) return 'column';
  if (/折线图|趋势线|曲线图/.test(text)) return 'line';
  return null;
}

function mentionedAs(question, descriptor, patterns) {
  const temporalNames = descriptor.temporal ? ['时间', '日期', '年份', '年度', '月份', '月度', '季度', '周'] : [];
  const names = unique([descriptor.field, descriptor.sourceField, descriptor.label, ...temporalNames]).filter(name => name.length >= 2);
  return names.some(name => patterns.some(pattern => pattern(String(question), name)));
}

function categoryRequested(question, descriptor) {
  return mentionedAs(question, descriptor, [
    (text, name) => new RegExp(`(?:以|用|把)${name}(?:作为|当作|放在|为)(?:横轴|X轴|分类)`, 'i').test(text),
    (text, name) => new RegExp(`(?:横轴|X轴|分类)(?:使用|采用|是|为)?${name}`, 'i').test(text),
    (text, name) => new RegExp(`按${name}(?:查看|看|统计|分析|展示)`, 'i').test(text),
  ]);
}

function seriesRequested(question, descriptor) {
  return mentionedAs(question, descriptor, [
    (text, name) => new RegExp(`(?:以|用|把)${name}(?:作为|当作|放在|为)(?:系列|图例)`, 'i').test(text),
    (text, name) => new RegExp(`(?:系列|图例)(?:使用|采用|是|为)?${name}`, 'i').test(text),
    (text, name) => new RegExp(`每个${name}(?:一条线|一个系列|一组柱)`, 'i').test(text),
    (text, name) => new RegExp(`(?:各|不同)${name}`, 'i').test(text),
  ]);
}

function facetRequested(question, descriptor) {
  return mentionedAs(question, descriptor, [
    (text, name) => new RegExp(`(?:以|用|把)${name}(?:作为|当作|放在|为)(?:分面|面板)`, 'i').test(text),
    (text, name) => new RegExp(`${name}.{0,8}(?:分别展示|单独展示|各自展示)`, 'i').test(text),
  ]) || /分面|多面板|分别展示|分别查看/.test(question);
}

function measureMark(question, descriptor, fallback) {
  const names = unique([descriptor.field, descriptor.label]).filter(name => name.length >= 2);
  for (const name of names) {
    if (new RegExp(`${name}.{0,8}(?:用|显示为|作为)?(?:折线|线)`, 'i').test(question)) return 'line';
    if (new RegExp(`${name}.{0,8}(?:用|显示为|作为)?(?:柱形|柱状|柱)`, 'i').test(question)) return 'bar';
  }
  return fallback;
}

function distinctCount(rows, field) {
  return unique(rows.map(row => row?.[field])).length;
}

function additiveMeasure(request, field) {
  const measure = (request?.measures || []).find(item => item.alias === field || item.field === field);
  return ['sum', 'countRows', 'distinctCount'].includes(measure?.aggregation);
}

function shareMeasure(request, descriptor) {
  const measure = (request?.measures || []).find(item => item.alias === descriptor?.field || item.field === descriptor?.field);
  return measure?.aggregation === 'share-of-total' || descriptor?.aggregation === 'share-of-total' || descriptor?.percentage === true || /占比|份额|构成|比例|share|ratio/i.test(String(descriptor?.label || descriptor?.field || ''));
}

function positiveMeasure(rows, field) {
  const values = rows.map(row => Number(row?.[field])).filter(Number.isFinite);
  return values.length > 0 && values.every(value => value >= 0);
}

function normalizeType(value, fallback = 'column') {
  return TYPES.has(value) ? value : fallback;
}

export function normalizeVisualizationSpec(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('VisualizationSpec 必须是对象');
  const type = normalizeType(input.type, null);
  if (!type) throw new Error(`VisualizationSpec 图表类型不受支持：${input.type || '空'}`);
  const category = input.encoding?.category;
  const measures = Array.isArray(input.encoding?.measures) ? input.encoding.measures : [];
  if (!category?.field) throw new Error('VisualizationSpec 缺少分类字段');
  if (!measures.length || measures.some(item => !item?.field)) throw new Error('VisualizationSpec 缺少数值字段');
  const seriesDimension = input.encoding?.seriesDimension?.field ? {
    field: safeText(input.encoding.seriesDimension.field, '', 120),
    label: safeText(input.encoding.seriesDimension.label, input.encoding.seriesDimension.field, 120),
  } : null;
  const facetDimension = input.encoding?.facetDimension?.field ? {
    field: safeText(input.encoding.facetDimension.field, '', 120),
    label: safeText(input.encoding.facetDimension.label, input.encoding.facetDimension.field, 120),
  } : null;
  return {
    schema: VISUALIZATION_SPEC_SCHEMA,
    type,
    dataRef: safeText(input.dataRef, '', 160),
    title: safeText(input.title, '分析图表', 200),
    encoding: {
      category: {
        field: safeText(category.field, '', 120),
        label: safeText(category.label, category.field, 120),
        type: category.type === 'temporal' ? 'temporal' : 'nominal',
      },
      seriesDimension,
      facetDimension,
      measures: measures.slice(0, 8).map((item, index) => ({
        field: safeText(item.field, '', 120),
        label: safeText(item.label, item.field, 120),
        mark: MARKS.has(item.mark) ? item.mark : type === 'line' ? 'line' : 'bar',
        axis: AXES.has(item.axis) ? item.axis : 'left',
        format: item.format === 'percentage' ? 'percentage' : 'number',
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      })),
    },
    options: {
      stack: Boolean(input.options?.stack || type === 'stacked-column'),
      showLegend: input.options?.showLegend !== false,
      showLabels: Boolean(input.options?.showLabels),
      categoryLimit: Math.max(0, Math.min(120, Number(input.options?.categoryLimit) || 0)),
      seriesLimit: Math.max(0, Math.min(12, Number(input.options?.seriesLimit) || 0)),
      groupRemainderAsOther: Boolean(input.options?.groupRemainderAsOther),
      dataZoom: Boolean(input.options?.dataZoom),
    },
    decision: {
      source: input.decision?.source === 'user' ? 'user' : 'automatic',
      reason: safeText(input.decision?.reason, '', 500),
      warnings: unique(input.decision?.warnings || []).slice(0, 8),
      allowedTypes: unique(input.decision?.allowedTypes || []).filter(type => TYPES.has(type)).slice(0, 8),
    },
  };
}

function descriptors({ request, resultSet }) {
  const schema = resultSet?.schema || [];
  const schemaMap = new Map(schema.map(column => [column.name, column]));
  const dimensions = (request?.select || []).map(item => {
    const column = schemaMap.get(item.alias) || {};
    return {
      field: item.alias,
      sourceField: item.field,
      label: fieldLabel(column, item.field || item.alias),
      temporal: isTemporal(column, item),
      grain: item.grain || column.grain || null,
      cardinality: distinctCount(resultSet?.rows || [], item.alias),
    };
  });
  const requestMeasureAliases = new Set((request?.measures || []).map(item => item.alias));
  const measureColumns = schema.filter(column => /measure/.test(String(column.role || '')) || requestMeasureAliases.has(column.name));
  const measures = unique(measureColumns.map(column => column.name)).map(name => {
    const column = schemaMap.get(name) || {};
    const requestMeasure = (request?.measures || []).find(item => item.alias === name);
    return {
      field: name,
      sourceField: requestMeasure?.field || column.sourceField || name,
      label: fieldLabel(column, requestMeasure?.field || name),
      percentage: isPercentage(column, name),
      unitFamily: measureUnitFamily(column, name, requestMeasure),
      aggregation: requestMeasure?.aggregation || null,
    };
  });
  return { dimensions, measures };
}

function chooseDimensionRoles(question, dimensions) {
  const explicitCategory = dimensions.find(item => categoryRequested(question, item));
  const explicitSeries = dimensions.find(item => item !== explicitCategory && seriesRequested(question, item));
  const explicitFacet = dimensions.find(item => item !== explicitCategory && item !== explicitSeries && facetRequested(question, item));
  const rest = (...excluded) => dimensions.filter(item => !excluded.includes(item)).sort((a, b) => a.cardinality - b.cardinality);
  if (explicitCategory) {
    const candidates = rest(explicitCategory, explicitSeries, explicitFacet);
    return { category: explicitCategory, series: explicitSeries || candidates[0] || null, facet: explicitFacet || candidates[1] || null, explicit: true };
  }
  if (explicitSeries) {
    const candidates = rest(explicitSeries, explicitFacet);
    return { category: candidates[0] || explicitSeries, series: explicitSeries, facet: explicitFacet || candidates[1] || null, explicit: true };
  }
  // A time filter such as "去年" often leaves one temporal member. It is a
  // scope constraint, not a useful chart axis; retain it only for explicit grouping.
  const timeGroupingRequested = /(?:按|按照|每|以|根据)(?:年|年度|年份|月|月份|季度|周|日)|年月|趋势|时间序列|逐月|逐年/.test(String(question));
  const eligible = dimensions.filter(item => !(item.temporal && item.cardinality <= 1 && !timeGroupingRequested && !categoryRequested(question, item)));
  const temporal = eligible.find(item => item.temporal);
  if (temporal) {
    const candidates = eligible.filter(item => item !== temporal).sort((a, b) => a.cardinality - b.cardinality);
    return { category: temporal, series: candidates[0] || null, facet: candidates[1] || null, explicit: false };
  }
  if (eligible.length >= 2) {
    const sorted = [...eligible].sort((a, b) => b.cardinality - a.cardinality);
    return { category: sorted[0], series: sorted[1], facet: sorted[2] || null, explicit: false };
  }
  return { category: eligible[0] || dimensions[0] || null, series: null, facet: null, explicit: false };
}

function allowedTypes({ roles, measures, pieAllowed }) {
  const values = ['line', 'column', 'bar'];
  if (roles.series) values.push('stacked-column');
  if (measures.length >= 2) values.push('combo');
  if (pieAllowed) values.push('pie', 'donut');
  return values;
}

export function decideVisualization({ metadata = null, question = '', request = {}, resultSet = {}, previous = null } = {}) {
  const rows = Array.isArray(resultSet?.rows) ? resultSet.rows : [];
  const { dimensions, measures } = descriptors({ metadata, request, resultSet });
  const requestedType = typeFromQuestion(question);
  if (requestedType === 'none') return { spec: null, decision: { source: 'user', reason: '用户明确要求只显示表格。', warnings: [], allowedTypes: [] } };
  if (!rows.length || !dimensions.length || !measures.length) return { spec: null, decision: { source: requestedType ? 'user' : 'automatic', reason: '结果缺少可绘制的分类或数值数据，保留表格展示。', warnings: [], allowedTypes: [] } };
  if (dimensions.length > 3) return { spec: null, decision: { source: requestedType ? 'user' : 'automatic', reason: '结果包含超过三个维度，分面仍不足以完整表达层次，已保留表格。', warnings: ['dimension-count-exceeded'], allowedTypes: [] } };
  if (measures.length > 3) return { spec: null, decision: { source: requestedType ? 'user' : 'automatic', reason: '结果包含超过三个指标，单图可读性不足，已保留表格。', warnings: ['measure-count-exceeded'], allowedTypes: [] } };
  if (rows.length > MAX_CHART_ROWS) return { spec: null, decision: { source: requestedType ? 'user' : 'automatic', reason: `结果包含 ${rows.length} 行，图表会隐藏大量明细，已保留可分页表格。`, warnings: ['row-count-exceeded'], allowedTypes: [] } };

  const roles = chooseDimensionRoles(question, dimensions);
  const categoryCount = roles.category.cardinality;
  const seriesCount = roles.series?.cardinality || 0;
  const facetCount = roles.facet?.cardinality || 0;
  const complete = !resultSet?.quality?.isSample && !resultSet?.quality?.isTruncated;
  // Composition results may contain both the original additive measure and its
  // derived share. Pie/donut charts bind the original measure so exact values
  // remain available; the chart engine calculates percentages.
  const pieMetric = measures.find(item => !shareMeasure(request, item)) || measures.find(item => shareMeasure(request, item)) || measures[0];
  const pieMetricIsShare = shareMeasure(request, pieMetric);
  const compositionSharePresent = measures.some(item => shareMeasure(request, item));
  const pieMeasureCountOk = measures.length === 1 || (measures.length === 2 && compositionSharePresent && !pieMetricIsShare);
  const pieAllowed = dimensions.length === 1 && pieMeasureCountOk && complete
    && (pieMetricIsShare || additiveMeasure(request, pieMetric.field)) && positiveMeasure(rows, pieMetric.field) && categoryCount >= 2 && categoryCount <= 8;
  const compositionIntent = /占比|构成|份额|比例|组成/.test(question);
  const rankingIntent = /排名|排行|前\s*(?:\d+|[一二两三四五六七八九十百]+)|top|最高|最低/.test(question);
  const knownUnitFamilies = unique(measures.map(item => item.unitFamily).filter(family => family && family !== 'number'));
  const hasMixedUnits = knownUnitFamilies.length > 1;
  const scales = measures.map(measure => rows.map(row => Math.abs(Number(row?.[measure.field]))).filter(Number.isFinite)).map(values => values.length ? Math.max(...values) : 0).filter(value => value > 0);
  const hasScaleRisk = scales.length >= 2 && Math.max(...scales) / Math.min(...scales) >= 100;
  const previousType = previous?.decision?.source === 'user' ? normalizeType(previous?.type || previous?.chartType, null) : null;
  let type = requestedType || previousType || null;
  if (!type) {
    if (compositionIntent && pieAllowed && !(compositionSharePresent && measures.length === 2 && /(?:各自|分别|和|、)/.test(question))) type = 'donut';
    else if ((hasMixedUnits || hasScaleRisk || (compositionSharePresent && measures.length === 2)) && measures.length >= 2) type = 'combo';
    else if (roles.category.temporal) type = 'line';
    else if (rankingIntent || categoryCount > 12 || roles.category.label.length > 8) type = 'bar';
    else type = 'column';
  }

  const warnings = [];
  let reason = '';
  if (knownUnitFamilies.length > 2 && !requestedType) {
    return { spec: null, decision: { source: 'automatic', reason: '结果包含超过两组计量单位，单图双轴无法同时表达，已保留分组明细表。', warnings: ['unit-family-exceeded'], allowedTypes: [] } };
  }
  if (roles.facet && facetCount > 8) {
    return { spec: null, decision: { source: requestedType ? 'user' : 'automatic', reason: '分面成员超过 8 个，单页面板会过度拥挤，已保留可筛选明细表。', warnings: ['facet-count-exceeded'], allowedTypes: [] } };
  }
  if (['pie', 'donut'].includes(type) && !pieAllowed) {
    const canGroupOther = dimensions.length === 1 && measures.length === 1 && complete
      && (pieMetricIsShare || additiveMeasure(request, pieMetric.field)) && positiveMeasure(rows, pieMetric.field) && categoryCount <= 30;
    if (!canGroupOther) {
      warnings.push('饼图要求完整、非负、可加且低基数的单指标结果，已自动改用条形图。');
      type = categoryCount > 12 ? 'bar' : 'column';
    }
  }
  if (type === 'combo' && measures.length < 2) {
    warnings.push('组合图需要同一分类轴上的多个指标，已自动选择可读性更高的图表。');
    type = roles.category.temporal ? 'line' : 'column';
  }
  if (type === 'stacked-column' && !roles.series) {
    warnings.push('堆叠图需要第二个维度作为系列，已自动改用柱形图。');
    type = 'column';
  }
  if (type === 'column' && categoryCount > 12 && !requestedType) {
    warnings.push('分类项超过 12 个，已改为更适合长列表的横向条形图。');
    type = 'bar';
  }
  if (categoryCount > 200) return { spec: null, decision: { source: requestedType ? 'user' : 'automatic', reason: '分类点超过 200 个，图表交互和比较成本过高，已保留可分页表格。', warnings: ['category-count-exceeded'], allowedTypes: [] } };

  const categoryLimit = ['pie', 'donut'].includes(type) && categoryCount > 8 ? 7 : type === 'bar' && categoryCount > 20 && rankingIntent ? 20 : 0;
  const seriesLimit = seriesCount > 8 ? 6 : 0;
  if (categoryLimit) warnings.push(`图表仅展示前 ${categoryLimit} 项，完整结果保留在明细表中。`);
  if (seriesLimit) warnings.push(`系列成员较多，图表仅展示贡献度最高的 ${seriesLimit} 个系列，完整结果保留在明细表中。`);
  if (roles.facet && seriesCount * Math.max(1, facetCount) * measures.length > 24) warnings.push('分面与系列组合较多，图表优先保留高贡献系列，完整结果保留在明细表中。');
  const dataZoom = categoryCount > 24 && !['pie', 'donut'].includes(type);
  if (dataZoom) warnings.push(`${roles.category.temporal ? '时间点' : '分类项'}较多，已启用缩放浏览。`);
  if (hasScaleRisk && type === 'combo') warnings.push('指标数值量级差异较大，已使用独立坐标轴保持可读性。');

  const defaultMark = type === 'line' ? 'line' : 'bar';
  const primaryUnitFamily = measures[0]?.unitFamily || 'number';
  const encodedMeasures = measures.map((item, index) => {
    let mark = defaultMark;
    let axis = 'left';
    if (type === 'combo') {
      const secondaryUnit = item.unitFamily !== primaryUnitFamily && item.unitFamily !== 'number';
      mark = secondaryUnit ? 'line' : 'bar';
      axis = secondaryUnit ? 'right' : 'left';
    }
    mark = measureMark(question, item, mark);
    return { field: item.field, label: item.label, mark, axis, format: item.percentage ? 'percentage' : 'number', order: index };
  });

  const typeLabel = value => value === 'bar' ? '横向条形图' : value === 'column' ? '柱形图' : value === 'donut' ? '环形图' : value === 'stacked-column' ? '堆叠柱形图' : value === 'combo' ? '组合图' : value === 'pie' ? '饼图' : '折线图';
  if (requestedType && requestedType === type) reason = `用户明确要求${typeLabel(type)}，并已通过数据适用性校验。`;
  else if (requestedType) reason = `用户要求${typeLabel(requestedType)}，数据适用性校验后自动改为${typeLabel(type)}。`;
  else if (previousType && previousType === type) reason = `延续上一轮用户选择的${typeLabel(type)}，并已通过当前结果适用性校验。`;
  else if (type === 'combo') reason = '结果包含不同计量单位的指标，自动选择双轴柱线组合图。';
  else if (type === 'line') reason = roles.category.temporal ? '时间维度适合在连续分类轴上展示变化趋势。' : '折线图适合展示当前分类序列的数值变化。';
  else if (['pie', 'donut'].includes(type)) reason = '问题关注构成关系，且结果满足完整、非负、低基数条件。';
  else if (type === 'bar') reason = rankingIntent ? '问题关注排名，横向条形图更利于比较类别名称和数值。' : '分类项较多或名称较长，横向条形图更利于阅读。';
  else if (type === 'stacked-column') reason = '结果包含可比较的分类与系列，堆叠柱形图适合展示总量及构成。';
  else reason = roles.facet ? '结果包含三个维度，已将主要粒度作为分类、低基数字段作为系列、另一维度拆分为分面。' : roles.series ? '结果包含多个维度，已将主要分析粒度作为分类、低基数字段作为系列。' : '分类数量适中，柱形图适合进行类别比较。';
  if (roles.explicit) reason += ' 分类、系列与分面角色依据用户自然语言指定。';

  const pieRenderable = pieAllowed || (['pie', 'donut'].includes(type) && complete && dimensions.length === 1 && pieMeasureCountOk);
  const allowed = allowedTypes({ roles, measures, pieAllowed: pieRenderable });
  const spec = normalizeVisualizationSpec({
    type,
    dataRef: resultSet.id,
    title: safeText(question, '分析图表'),
    encoding: {
      category: { field: roles.category.field, label: roles.category.label, type: roles.category.temporal ? 'temporal' : 'nominal' },
      seriesDimension: roles.series ? { field: roles.series.field, label: roles.series.label } : null,
      facetDimension: roles.facet ? { field: roles.facet.field, label: roles.facet.label } : null,
      measures: ['pie', 'donut'].includes(type) ? encodedMeasures.filter(item => item.field === pieMetric.field) : encodedMeasures,
    },
    options: {
      stack: type === 'stacked-column',
      showLegend: Boolean(roles.series || measures.length > 1),
      showLabels: ['bar', 'pie', 'donut'].includes(type),
      categoryLimit,
      seriesLimit,
      groupRemainderAsOther: ['pie', 'donut'].includes(type) && categoryCount > 8,
      dataZoom,
    },
    decision: { source: requestedType ? 'user' : 'automatic', reason, warnings, allowedTypes: allowed },
  });
  return { spec, decision: spec.decision };
}
