import { toDate, toNumber } from '../analysis-core.mjs';

const NUMBER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const PERCENT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

function formatNumber(value) {
  return NUMBER.format(value ?? 0);
}

function isDurationMeasure(measure) {
  return /TAT|耗时|时长|用时|周期|分钟|小时|天数/.test(`${measure?.field || ''} ${measure?.alias || ''}`);
}

function isTemporalMeasure(measure) {
  return /时间|日期|timestamp|datetime/i.test(`${measure?.field || ''} ${measure?.alias || ''}`);
}

function periodKey(value, grain = 'month') {
  const date = toDate(value);
  if (!date) return String(value ?? '');
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (grain === 'year') return String(year);
  if (grain === 'quarter') return `${year}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  if (grain === 'day') return `${year}-${month}-${day}`;
  return `${year}-${month}`;
}

function evidenceFromOutcome(outcome, title, value, extraScope = {}) {
  const request = outcome.request;
  const fields = [
    ...request.select.map(item => item.field),
    ...request.measures.map(item => item.field).filter(Boolean),
  ];
  return {
    id: `ev-${request.id.replace(/^qry-/, '')}`,
    title,
    fields: [...new Set(fields)],
    rowCount: outcome.resultSet.statistics.rowCount,
    value,
    method: `${outcome.executionPlan.adapter} 执行 CanonicalQueryRequest 并由确定性程序计算`,
    queryPlan: {
      id: request.id,
      purpose: request.purpose,
      mode: request.mode,
      resultSetId: outcome.resultSet.id,
    },
    scope: {
      metrics: request.measures.map(item => item.field || item.alias),
      dimensions: request.select.map(item => item.field),
      filters: request.filters,
      datasetRevision: request.dataset.revision,
      orderBy: request.orderBy,
      resultLimit: request.limit,
      resultLimited: Boolean(outcome.resultSet.quality.isTruncated),
      ...extraScope,
    },
    verification: { valid: true, errors: [] },
  };
}

function seriesForRows(rows, measures) {
  return measures.map(item => ({
    name: item.field || item.alias,
    alias: item.alias,
    values: rows.map(row => {
      if (isTemporalMeasure(item)) return null;
      const value = toNumber(row[item.alias]);
      if (isDurationMeasure(item) && value != null && value < 0) return null;
      return value ?? 0;
    }),
  })).filter(item => item.values.some(value => typeof value === 'number' && Number.isFinite(value)));
}

function metricValue(measure, value) {
  if (isTemporalMeasure(measure)) return toDate(value) ? String(value) : '无有效值';
  const numeric = toNumber(value);
  if (numeric == null) {
    const date = toDate(value);
    return date ? String(value) : '无有效值';
  }
  return measure.resultType === 'percentage' ? `${PERCENT.format(numeric * 100)}%` : formatNumber(numeric);
}

function sortableValue(value, measure) {
  if (isTemporalMeasure(measure)) return toDate(value)?.getTime() ?? 0;
  const numeric = toNumber(value);
  if (numeric != null) return numeric;
  return toDate(value)?.getTime() ?? 0;
}

function timeArtifacts(outcome) {
  const request = outcome.request;
  const time = request.select[0];
  const totals = new Map();
  for (const row of outcome.resultSet.rows) {
    const period = periodKey(row[time.alias], time.grain);
    if (!period) continue;
    if (!totals.has(period)) totals.set(period, Object.fromEntries(request.measures.map(item => [item.alias, 0])));
    const target = totals.get(period);
    for (const item of request.measures) target[item.alias] += toNumber(row[item.alias]) || 0;
  }
  const rows = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, values]) => ({ period, ...values }));
  if (!rows.length) return { charts: [], insights: [], evidence: [] };
  const series = seriesForRows(rows, request.measures);
  const primary = request.measures[0];
  const current = rows.at(-1);
  const previous = rows.at(-2);
  const change = previous && toNumber(previous[primary.alias])
    ? (toNumber(current[primary.alias]) - toNumber(previous[primary.alias])) / Math.abs(toNumber(previous[primary.alias])) * 100
    : null;
  const peak = rows.reduce((best, row) => (toNumber(row[primary.alias]) || 0) > (toNumber(best[primary.alias]) || 0) ? row : best, rows[0]);
  const rangePrefix = outcome.resultSet.quality.isTruncated ? '当前返回时间范围内，' : '';
  let statement = `${rangePrefix}${primary.field || primary.alias}在 ${peak.period} 达到序列峰值 ${metricValue(primary, peak[primary.alias])}。`;
  if (change != null) statement += ` ${outcome.resultSet.quality.isTruncated ? '返回序列末两个期间中，' : '最近期间 '}${current.period} 较 ${previous.period}${change >= 0 ? '增长' : '下降'} ${PERCENT.format(Math.abs(change))}%。`;
  if (request.measures.length >= 2 && previous) {
    const second = request.measures[1];
    const primaryRate = toNumber(previous[primary.alias]) ? (toNumber(current[primary.alias]) - toNumber(previous[primary.alias])) / Math.abs(toNumber(previous[primary.alias])) : null;
    const secondRate = toNumber(previous[second.alias]) ? (toNumber(current[second.alias]) - toNumber(previous[second.alias])) / Math.abs(toNumber(previous[second.alias])) : null;
    if (primaryRate != null && secondRate != null && Math.sign(primaryRate) !== Math.sign(secondRate)) {
      statement += ` ${primary.field || primary.alias}与${second.field || second.alias}变化方向不一致，存在规模与质量背离信号。`;
    }
  }
  const evidence = evidenceFromOutcome(outcome, request.purpose, rows, { periods: rows.map(row => row.period) });
  return {
    charts: [{
      id: `chart-${request.id.replace(/^qry-/, '')}`,
      type: 'line',
      title: request.purpose,
      xField: time.field,
      yField: primary.field || primary.alias,
      labels: rows.map(row => row.period),
      values: series[0].values,
      series,
      evidenceId: evidence.id,
      topic: request.topic,
    }],
    insights: [{
      id: `insight-${request.id.replace(/^qry-/, '')}`,
      category: request.topic === 'profitability' ? '利润诊断' : request.topic === 'anomaly' ? '异常波动' : '趋势探索',
      title: request.purpose,
      statement,
      confidence: rows.length >= 6 && !outcome.resultSet.quality.isTruncated ? 'high' : 'medium',
      evidenceIds: [evidence.id],
      topic: request.topic,
    }],
    evidence: [evidence],
  };
}

function dimensionArtifacts(outcome) {
  const request = outcome.request;
  const dimension = request.select[0];
  const primary = request.measures[0];
  const requestedOrder = request.orderBy[0];
  let rankMeasure = request.measures.find(item => item.alias === requestedOrder?.field) || primary;
  const direction = requestedOrder?.direction === 'asc' ? 'asc' : 'desc';
  const rawRows = outcome.resultSet.rows
    .map(row => ({
      label: String(row[dimension.alias] ?? ''),
      ...Object.fromEntries(request.measures.map(item => {
        if (isTemporalMeasure(item)) return [item.alias, row[item.alias] ?? null];
        const numeric = toNumber(row[item.alias]);
        return [item.alias, numeric ?? row[item.alias] ?? null];
      })),
    }))
    .filter(row => row.label);
  if (!rawRows.length) return { charts: [], insights: [], evidence: [] };
  const invalidDurationFields = request.measures
    .filter(isDurationMeasure)
    .filter(measure => rawRows.some(row => toNumber(row[measure.alias]) < 0));
  const invalidDurationValueCount = invalidDurationFields.reduce(
    (count, measure) => count + rawRows.filter(row => toNumber(row[measure.alias]) < 0).length,
    0,
  );
  if (isDurationMeasure(rankMeasure) && !rawRows.some(row => toNumber(row[rankMeasure.alias]) >= 0)) {
    rankMeasure = request.measures.find(measure => isDurationMeasure(measure)
      && rawRows.some(row => toNumber(row[measure.alias]) >= 0)) || rankMeasure;
  }
  const rankedRows = rawRows
    .filter(row => !isDurationMeasure(rankMeasure) || toNumber(row[rankMeasure.alias]) >= 0)
    .sort((a, b) => direction === 'asc' ? sortableValue(a[rankMeasure.alias], rankMeasure) - sortableValue(b[rankMeasure.alias], rankMeasure) : sortableValue(b[rankMeasure.alias], rankMeasure) - sortableValue(a[rankMeasure.alias], rankMeasure));
  const rows = isDurationMeasure(rankMeasure) ? rankedRows : [...rawRows].sort(
    (a, b) => direction === 'asc' ? sortableValue(a[rankMeasure.alias], rankMeasure) - sortableValue(b[rankMeasure.alias], rankMeasure) : sortableValue(b[rankMeasure.alias], rankMeasure) - sortableValue(a[rankMeasure.alias], rankMeasure),
  );
  const evidence = evidenceFromOutcome(outcome, request.purpose, rawRows, invalidDurationFields.length ? {
    invalidDurationFields: invalidDurationFields.map(item => item.field || item.alias),
    invalidDurationValueCount,
    durationPolicy: 'negative-values-excluded-from-ranking-and-chart',
  } : {});
  if (!rows.length) {
    return {
      charts: [],
      insights: [{
        id: `insight-${request.id.replace(/^qry-/, '')}`,
        category: '数据质量',
        title: `${request.purpose}存在负时长异常`,
        statement: `${invalidDurationFields.map(item => item.field || item.alias).join('、')}共出现 ${invalidDurationValueCount} 个负值聚合结果，当前没有可用于正常效率排名的有效值；必须先核验时间戳顺序与计算口径。`,
        confidence: 'high',
        evidenceIds: [evidence.id],
        topic: request.topic,
      }],
      evidence: [evidence],
    };
  }
  const total = rows.reduce((sum, row) => sum + row[primary.alias], 0);
  const leading = rows[0];
  const top3Share = total ? rows.slice(0, 3).reduce((sum, row) => sum + row[primary.alias], 0) / total * 100 : 0;
  const additive = ['sum', 'countRows', 'distinctCount'].includes(primary.aggregation);
  const rangePrefix = outcome.resultSet.quality.isTruncated ? '当前返回范围内，' : '';
  let statement = invalidDurationFields.length
    ? `${invalidDurationFields.map(item => item.field || item.alias).join('、')}共出现 ${invalidDurationValueCount} 个负值聚合结果，已从正常效率排名和图表中排除，需核验时间戳顺序与计算口径。 `
    : '';
  statement += `${rangePrefix}${leading.label} 的${rankMeasure.field || rankMeasure.alias}${rankMeasure.aggregation === 'average' ? '平均值' : ''}${direction === 'asc' ? '最低' : '最高'}，为 ${metricValue(rankMeasure, leading[rankMeasure.alias])}。`;
  if (additive && !outcome.resultSet.quality.isTruncated) statement += ` 前三项合计占 ${PERCENT.format(top3Share)}%。`;
  if (request.measures.length >= 2 && request.measures.slice(0, 2).every(item => item.aggregation === 'sum')) {
    const second = request.measures[1];
    const marginRows = rows.filter(row => row[primary.alias] > 0).map(row => ({ ...row, ratio: row[second.alias] / row[primary.alias] })).sort((a, b) => a.ratio - b.ratio);
    if (marginRows.length) statement += ` ${marginRows[0].label} 的${second.field || second.alias}/${primary.field || primary.alias}比率最低，为 ${PERCENT.format(marginRows[0].ratio * 100)}%。`;
  } else if (request.measures.length >= 2) {
    const second = request.measures.find(item => item.alias !== rankMeasure.alias
      && (!isDurationMeasure(item) || toNumber(leading[item.alias]) >= 0));
    if (second) statement += ` 该项${second.field || second.alias}为 ${metricValue(second, leading[second.alias])}。`;
  }
  const series = seriesForRows(rows, request.measures);
  const category = request.topic === 'customer' ? '客户经营' : request.topic === 'product' ? '产品组合' : request.topic === 'profitability' ? '利润诊断' : '结构探索';
  return {
    charts: [{
      id: `chart-${request.id.replace(/^qry-/, '')}`,
      type: 'bar',
      title: request.purpose,
      xField: dimension.field,
      yField: rankMeasure.field || rankMeasure.alias,
      labels: rows.slice(0, 20).map(row => row.label),
      values: (series.find(item => item.alias === rankMeasure.alias) || series[0]).values.slice(0, 20),
      series: series.map(item => ({ ...item, values: item.values.slice(0, 20) })),
      evidenceId: evidence.id,
      topic: request.topic,
    }],
    insights: [{
      id: `insight-${request.id.replace(/^qry-/, '')}`,
      category,
      title: request.purpose,
      statement,
      confidence: outcome.resultSet.quality.isTruncated || invalidDurationFields.length ? 'medium' : 'high',
      evidenceIds: [evidence.id],
      topic: request.topic,
    }],
    evidence: [evidence],
  };
}

function crossArtifacts(outcome) {
  const request = outcome.request;
  const [first, second] = request.select;
  const primary = request.measures[0];
  const firstIsTime = Boolean(first.grain) || outcome.resultSet.schema.find(item => item.name === first.alias)?.type === 'date';
  if (firstIsTime) {
    const periods = [...new Set(outcome.resultSet.rows.map(row => periodKey(row[first.alias], first.grain)))].filter(Boolean).sort();
    const baseline = periods.at(-2);
    const current = periods.at(-1);
    if (baseline && current) {
      const totals = new Map();
      for (const row of outcome.resultSet.rows) {
        const period = periodKey(row[first.alias], first.grain);
        if (period !== baseline && period !== current) continue;
        const entity = String(row[second.alias] ?? '');
        if (!entity) continue;
        if (!totals.has(entity)) totals.set(entity, { baseline: 0, current: 0 });
        totals.get(entity)[period === current ? 'current' : 'baseline'] += toNumber(row[primary.alias]) || 0;
      }
      const deltas = [...totals.entries()].map(([label, values]) => ({ label, value: values.current - values.baseline, ...values })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
      const top = deltas[0];
      const evidence = evidenceFromOutcome(outcome, request.purpose, deltas, { periods: [baseline, current] });
      return {
        charts: [{ id: `chart-${request.id.replace(/^qry-/, '')}`, type: 'bar', title: request.purpose, xField: second.field, yField: `${primary.field || primary.alias}变化`, labels: deltas.slice(0, 20).map(item => item.label), values: deltas.slice(0, 20).map(item => item.value), evidenceId: evidence.id, topic: request.topic }],
        insights: [{ id: `insight-${request.id.replace(/^qry-/, '')}`, category: '结果下钻', title: request.purpose, statement: `${current} 较 ${baseline} 的最大${second.field}变化项为 ${top.label}，变化 ${formatNumber(top.value)}。该查询由上一轮结果触发。`, confidence: outcome.resultSet.quality.isTruncated ? 'medium' : 'high', evidenceIds: [evidence.id], topic: request.topic }],
        evidence: [evidence],
      };
    }
  }
  const rows = outcome.resultSet.rows.map(row => ({ label: `${row[first.alias]} · ${row[second.alias]}`, value: toNumber(row[primary.alias]) || 0 })).sort((a, b) => b.value - a.value);
  if (!rows.length) return { charts: [], insights: [], evidence: [] };
  const evidence = evidenceFromOutcome(outcome, request.purpose, rows);
  return {
    charts: [{ id: `chart-${request.id.replace(/^qry-/, '')}`, type: 'bar', title: request.purpose, xField: `${first.field} × ${second.field}`, yField: primary.field || primary.alias, labels: rows.slice(0, 20).map(item => item.label), values: rows.slice(0, 20).map(item => item.value), evidenceId: evidence.id, topic: request.topic }],
    insights: [{ id: `insight-${request.id.replace(/^qry-/, '')}`, category: '交叉分析', title: request.purpose, statement: `${outcome.resultSet.quality.isTruncated ? '当前返回范围内，' : ''}${rows[0].label} 是交叉结果中的最高项，${primary.field || primary.alias}为 ${formatNumber(rows[0].value)}。`, confidence: 'medium', evidenceIds: [evidence.id], topic: request.topic }],
    evidence: [evidence],
  };
}

export function buildExplorationArtifacts(outcomes = []) {
  const result = { charts: [], insights: [], evidence: [] };
  for (const outcome of outcomes) {
    if (outcome.request.id.startsWith('qry-system-') || ['detail', 'mining'].includes(outcome.request.mode)) continue;
    let artifacts;
    if (outcome.request.select.length === 1 && outcome.request.select[0].grain) artifacts = timeArtifacts(outcome);
    else if (outcome.request.select.length === 1) artifacts = dimensionArtifacts(outcome);
    else if (outcome.request.select.length >= 2) artifacts = crossArtifacts(outcome);
    else continue;
    result.charts.push(...artifacts.charts.map(chart => ({
      ...chart,
      // InsightDocument renders charts only through an audited ResultSet reference.
      resultSetId: chart.resultSetId || outcome.resultSet.id,
    })));
    result.insights.push(...artifacts.insights);
    result.evidence.push(...artifacts.evidence);
  }
  return result;
}

export function buildDynamicReportMarkdown(analysis, planning) {
  const summaries = (analysis.kpis || []).slice(0, 5).map(item => `${item.label}：${item.value}`);
  const grouped = new Map();
  for (const insight of analysis.insights || []) {
    if (!grouped.has(insight.category)) grouped.set(insight.category, []);
    grouped.get(insight.category).push(insight);
  }
  const sections = [...grouped.entries()].flatMap(([category, insights]) => [
    `## ${category}`,
    '',
    ...insights.map(item => `- **${item.title}**：${item.statement} \`${item.evidenceIds.join(' / ')}\``),
    '',
  ]);
  return [
    '## 管理摘要',
    '',
    `- 本次采用 ${String(planning.mode).startsWith('ai-') ? 'AI 问题驱动规划' : '确定性语义降级规划'}，分析意图为 ${planning.intent}。`,
    ...summaries.map(item => `- ${item}`),
    '',
    ...sections,
    '## 分析边界与后续动作',
    '',
    `- 已执行 ${analysis.execution?.queryCount || 0} 个受控查询；Planner 模式：${planning.mode}；Critic 模式：${planning.criticMode || 'none'}。`,
    '- 结论表示统计关联与经营信号，不自动等同于因果关系；重要行动应结合业务事件和责任人复核。',
  ].join('\n');
}
