import { selectAnalysisFields, toDate, toNumber } from '../analysis-core.mjs';

function hypothesis(id, question, businessValue, priority, requiredEvidence) {
  return {
    id,
    question,
    businessValue,
    priority,
    status: 'candidate',
    requiredEvidence,
    parentHypothesisId: null,
    generatedBy: 'sales-analysis-skill/v1',
    stopReason: null,
  };
}

export function buildInitialHypotheses(metadata, focus = '') {
  const selected = selectAnalysisFields(metadata);
  return [
    hypothesis('hyp-baseline', focus || '当前经营规模、质量和关键结构是什么？', '建立可复核的经营分析基线', 1, ['核心指标', '数据范围', '质量样本']),
    selected.date && selected.primaryMeasure
      ? hypothesis('hyp-trend', `${selected.primaryMeasure.name}近期发生了怎样的变化？`, '识别需要进一步解释的趋势和波动', 0.95, ['时间趋势', '相邻期间比较'])
      : null,
    selected.primaryMeasure && (selected.region || selected.category)
      ? hypothesis('hyp-structure', '经营结果集中在哪些区域或类别？', '识别规模来源和集中度', 0.8, ['区域贡献', '类别贡献'])
      : null,
  ].filter(Boolean);
}

function overviewMeasures(selected) {
  return [
    { alias: 'source_rows', aggregation: 'countRows' },
    selected.primaryMeasure && { alias: 'total', aggregation: 'sum', field: selected.primaryMeasure.name },
    selected.orderId
      ? { alias: 'orders', aggregation: 'distinctCount', field: selected.orderId.name }
      : { alias: 'orders', aggregation: 'countRows' },
    selected.profitMeasure && { alias: 'profit', aggregation: 'sum', field: selected.profitMeasure.name },
    selected.date && { alias: 'date_min', aggregation: 'min', field: selected.date.name },
    selected.date && { alias: 'date_max', aggregation: 'max', field: selected.date.name },
  ].filter(Boolean);
}

export function buildBaselineQueryRequests(metadata, filters = []) {
  const selected = selectAnalysisFields(metadata);
  const dataset = { id: metadata.id, revision: metadata.revision };
  const requests = [
    {
      id: 'qry-quality-sample',
      hypothesisId: 'hyp-baseline',
      purpose: '读取受控明细样本用于数据质量和微观分析准备',
      mode: 'detail',
      dataset,
      select: (metadata.fields || []).slice(0, 64).map((field, index) => ({ field: field.name, alias: `field${index + 1}` })),
      measures: [],
      filters,
      limit: 20000,
      sensitivity: 'controlled-detail',
    },
    {
      id: 'qry-overview',
      hypothesisId: 'hyp-baseline',
      purpose: '计算完整数据集经营概览',
      mode: 'aggregate',
      dataset,
      select: [],
      measures: overviewMeasures(selected),
      filters,
      limit: 1,
      sensitivity: 'aggregate-only',
    },
  ];

  if (selected.date && selected.primaryMeasure) {
    requests.push({
      id: 'qry-trend',
      hypothesisId: 'hyp-trend',
      purpose: '识别完整数据集时间趋势并判断是否需要下钻',
      mode: 'compare',
      dataset,
      select: [{ field: selected.date.name, alias: 'period', grain: 'month' }],
      measures: [{ field: selected.primaryMeasure.name, aggregation: 'sum', alias: 'value' }],
      filters,
      orderBy: [{ field: 'period', direction: 'asc' }],
      limit: 20000,
      comparison: { type: 'period_over_period', current: 'latest_complete_period', baseline: 'previous_period' },
    });
  }
  const addBreakdown = (id, field) => {
    if (!field || !selected.primaryMeasure) return;
    requests.push({
      id: `qry-${id}`,
      hypothesisId: 'hyp-structure',
      purpose: `计算${field.name}的完整数据集贡献结构`,
      mode: 'aggregate',
      dataset,
      select: [{ field: field.name, alias: id }],
      measures: [{ field: selected.primaryMeasure.name, aggregation: 'sum', alias: 'value' }],
      filters,
      orderBy: [{ field: 'value', direction: 'desc' }],
      limit: 12,
    });
  };
  addBreakdown('category', selected.category);
  addBreakdown('region', selected.region);
  return requests;
}

function monthlyTotals(resultSet) {
  const totals = new Map();
  for (const row of resultSet?.rows || []) {
    const date = toDate(row.period);
    const value = toNumber(row.value);
    if (!date || value == null) continue;
    const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    totals.set(period, (totals.get(period) || 0) + value);
  }
  return [...totals.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
}

function monthStart(period) {
  return `${period}-01`;
}

function nextMonthStart(period) {
  const [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function planGrowthDriverQueries({ metadata, trendResultSet, filters = [] }) {
  const selected = selectAnalysisFields(metadata);
  const trend = monthlyTotals(trendResultSet);
  if (trend.length < 2 || !selected.date || !selected.primaryMeasure) {
    return { hypothesis: null, requests: [], context: null, stopReason: '至少需要两个有效时间周期才能验证增长来源' };
  }
  const current = trend.at(-1);
  const baseline = trend.at(-2);
  const delta = current.value - baseline.value;
  if (filters.length > 6) {
    return { hypothesis: null, requests: [], context: null, stopReason: '用户筛选已占满查询过滤预算，未追加期间来源下钻' };
  }
  const periodFilters = [
    { field: selected.date.name, operator: 'gte', value: monthStart(baseline.period) },
    { field: selected.date.name, operator: 'lt', value: nextMonthStart(current.period) },
  ];
  const hypothesisItem = hypothesis(
    'hyp-growth-driver',
    `${current.period} 相比 ${baseline.period} 的变化主要由哪些区域和类别驱动？`,
    '把宏观趋势转化为可行动的业务来源判断',
    0.98,
    ['时间 × 区域变化', '时间 × 类别变化', '反向贡献项'],
  );
  hypothesisItem.status = 'testing';
  hypothesisItem.parentHypothesisId = 'hyp-trend';
  const requests = [];
  const addDriver = (id, field) => {
    if (!field) return;
    requests.push({
      id: `qry-growth-${id}`,
      hypothesisId: hypothesisItem.id,
      purpose: `验证 ${current.period} 相比 ${baseline.period} 的${field.name}变化来源`,
      mode: 'verify',
      dataset: { id: metadata.id, revision: metadata.revision },
      select: [
        { field: selected.date.name, alias: 'period', grain: 'month' },
        { field: field.name, alias: id },
      ],
      measures: [{ field: selected.primaryMeasure.name, aggregation: 'sum', alias: 'value' }],
      filters: [...filters, ...periodFilters],
      limit: 20000,
      comparison: { type: 'period_over_period', current: current.period, baseline: baseline.period },
      sensitivity: 'aggregate-only',
    });
  };
  addDriver('region', selected.region);
  addDriver('category', selected.category);
  return { hypothesis: hypothesisItem, requests, context: { current, baseline, delta, measure: selected.primaryMeasure.name } };
}
