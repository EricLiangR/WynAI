const VERSION = 'wynai.business-fact-pack/v1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function finite(value) { return Number.isFinite(Number(value)); }
function num(value) { return Number(value); }
function isTimeField(field) { return field?.role === 'time' || ['date', 'datetime'].includes(field?.type) || /日期|时间|月份|月度|年度|年份|period|date|time/i.test(String(field?.name || '')); }
function periodKey(value) {
  if (value === null || value === undefined || value === '') return '(空时间)';
  const text = String(value).trim();
  const month = text.match(/^(\d{4})年\s*(\d{1,2})月/);
  if (month) return `${month[1]}-${String(month[2]).padStart(2, '0')}`;
  const year = text.match(/^(\d{4})年$/);
  if (year) return year[1];
  const iso = text.match(/^(\d{4})[-/]?(\d{1,2})(?:[-/]?(\d{1,2}))?/);
  return iso ? (iso[3] ? `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}` : `${iso[1]}-${String(iso[2]).padStart(2, '0')}`) : text;
}
function metricBinding(metrics, id, schema) {
  const metric = (metrics || []).find(item => item.id === id || item.concept === id || item.name === id);
  if (metric?.field && schema.some(field => field.name === metric.field)) return { metric, field: metric.field };
  const names = [metric?.name, ...(metric?.synonyms || [])].filter(Boolean).map(String);
  const field = schema.find(item => names.includes(item.name));
  return { metric: metric || null, field: field?.name || null };
}
function sum(rows, field) { return rows.map(row => num(row[field])).filter(Number.isFinite).reduce((total, value) => total + value, 0); }
function distinctCount(rows, field) { return new Set(rows.map(row => row[field]).filter(value => value !== null && value !== undefined && value !== '')).size; }
function fact(id, title, value, method, evidenceIds, scope = {}) { return { id, title, value, method, evidenceIds: [...new Set((evidenceIds || []).filter(Boolean))], scope }; }
function groupBy(rows, dimensions, measures) {
  const groups = new Map();
  for (const row of rows) {
    const values = dimensions.map(field => isTimeField(field) ? periodKey(row[field.name]) : (row[field.name] ?? '(空)'));
    const key = JSON.stringify(values);
    const current = groups.get(key) || { ...Object.fromEntries(dimensions.map((field, index) => [field.name, values[index]])), recordCount: 0 };
    current.recordCount += 1;
    for (const measure of measures) { const value = num(row[measure]); if (Number.isFinite(value)) current[measure] = (current[measure] || 0) + value; }
    groups.set(key, current);
  }
  return [...groups.values()];
}
function completeness(rows, schema) {
  const total = Math.max(1, rows.length * Math.max(1, schema.length));
  const present = rows.reduce((count, row) => count + schema.filter(field => row[field.name] !== null && row[field.name] !== undefined && row[field.name] !== '').length, 0);
  return Math.round(present / total * 100);
}

export function buildBusinessFactPack({ input = {}, evidencePack = {}, skills = [] } = {}) {
  const resultSet = input.resultSets?.[0] || {};
  const schema = resultSet.schema || [];
  const rows = resultSet.rows || [];
  const skill = skills.find(item => Array.isArray(item?.metrics) && item.metrics.length) || skills[0] || null;
  const metrics = skill?.metrics || [];
  const dimensions = schema.filter(field => field?.role === 'dimension' || (!isTimeField(field) && !['number', 'integer'].includes(field?.type) && field?.role !== 'measure'));
  const times = schema.filter(isTimeField);
  const facts = [];
  const evidenceIds = [];
  const quality = {
    completeness: completeness(rows, schema),
    rowCount: rows.length,
    isSample: Boolean(input.quality?.isSample || resultSet.quality?.isSample),
    isTruncated: Boolean(input.quality?.isTruncated || resultSet.quality?.isTruncated),
    coverage: clone(evidencePack.coverage || null),
    distinctCounts: Object.fromEntries([...dimensions, ...times].map(field => [field.name, distinctCount(rows, field.name)])),
  };
  facts.push(fact('data-quality', '数据质量与范围', quality, 'deterministic.profile', ['data-quality'], { timeRange: input.scope?.timeRange || null }));
  for (const metric of metrics) {
    const binding = metricBinding(metrics, metric.id, schema);
    if (!binding.field) continue;
    const fieldMeta = schema.find(field => field.name === binding.field) || {};
    const isPreAggregated = Boolean(fieldMeta.isPreAggregated || resultSet.quality?.isPreAggregated || input.quality?.isPreAggregated);
    const value = metric.aggregation === 'distinctCount' && !isPreAggregated ? distinctCount(rows, binding.field) : sum(rows, binding.field);
    const id = `${metric.id}-total`;
    facts.push(fact(id, `${metric.name || metric.id}合计`, { metricId: metric.id, field: binding.field, value, aggregation: isPreAggregated ? 'sum(pre-aggregated)' : (metric.aggregation || 'sum'), isPreAggregated }, 'deterministic.aggregate', [id, 'data-quality'], { rowCount: rows.length }));
    evidenceIds.push(id);
  }
  for (const metric of metrics.filter(item => item.formula?.operator === 'ratio')) {
    const inputs = metric.formula.inputs || [];
    const numerator = facts.find(item => item.id === `${inputs[0]}-total`)?.value?.value;
    const denominator = facts.find(item => item.id === `${inputs[1]}-total`)?.value?.value;
    if (!finite(numerator) || !finite(denominator)) continue;
    const value = denominator === 0 ? null : numerator / denominator;
    const id = metric.id === 'averageOrderValue' ? 'average-order-value' : `${metric.id}-derived`;
    facts.push(fact(id, metric.name || metric.id, { metricId: metric.id, value, numerator, denominator, formula: `${inputs[0]} / ${inputs[1]}`, zeroDivision: denominator === 0 }, 'deterministic.derived-ratio', [`${inputs[0]}-total`, `${inputs[1]}-total`], { aggregationOrder: 'aggregate-then-calculate' }));
    evidenceIds.push(id);
  }
  const measureFields = metrics.map(metric => metricBinding(metrics, metric.id, schema).field).filter(Boolean);
  if (times.length && measureFields.length) {
    const rowsByTime = groupBy(rows, [times[0]], measureFields);
    const observedPeriods = rowsByTime.map(row => row[times[0].name]).filter(value => value !== null && value !== undefined && value !== '');
    facts.push(fact('time-trend', '时间趋势', { timeField: times[0].name, rows: rowsByTime, measures: measureFields, observedPeriods }, 'deterministic.time-group', ['time-trend', 'data-quality'], {
      grain: times[0].grain || 'period',
      totalPeriods: rowsByTime.length,
      representedPeriods: rowsByTime.length,
      periodCoverageMode: input.scope?.periodCoverageMode || 'observed-records-only',
      resultLimited: false,
    }));
    evidenceIds.push('time-trend');
    const ranked = rowsByTime.filter(row => measureFields.some(field => finite(row[field]))).sort((a, b) => num(b[measureFields[0]]) - num(a[measureFields[0]]));
    if (ranked.length >= 2) facts.push(fact('time-anomaly', '时间序列高低点', { highest: ranked[0], lowest: ranked.at(-1) }, 'deterministic.extrema', ['time-trend'], { basedOn: measureFields[0] }));
  }
  if (dimensions.length && measureFields.length) {
    const contributionRows = groupBy(rows, [dimensions[0]], measureFields).sort((a, b) => num(b[measureFields[0]]) - num(a[measureFields[0]]));
    const total = contributionRows.reduce((value, row) => value + (finite(row[measureFields[0]]) ? num(row[measureFields[0]]) : 0), 0);
    const contributionRowsWithShare = contributionRows.map(row => ({
      ...row,
      share: total && finite(row[measureFields[0]]) ? num(row[measureFields[0]]) / total : null,
    }));
    facts.push(fact('dimension-contribution', `${dimensions[0].name}贡献`, { dimension: dimensions[0].name, rows: contributionRowsWithShare, measure: measureFields[0], total }, 'deterministic.dimension-group', ['dimension-contribution', 'data-quality'], { totalGroups: contributionRows.length, representedGroups: contributionRows.length, resultLimited: false }));
    evidenceIds.push('dimension-contribution');
    const top = contributionRows.slice(0, 3).reduce((value, row) => value + (finite(row[measureFields[0]]) ? num(row[measureFields[0]]) : 0), 0);
    facts.push(fact('concentration', `${dimensions[0].name}集中度`, { dimension: dimensions[0].name, topN: 3, share: total ? top / total : null, total, measure: measureFields[0] }, 'deterministic.concentration', ['dimension-contribution'], { totalGroups: contributionRows.length, resultLimited: false }));
    evidenceIds.push('concentration');
  }
  const requiredFacts = [...new Set(skills.flatMap(item => item.requiredFacts || []))];
  const requiredFactStatus = requiredFacts.map(id => ({ id, satisfied: facts.some(item => item.id === id), evidenceIds: facts.filter(item => item.id === id).flatMap(item => item.evidenceIds) }));
  const qualityGates = { completeness: quality.completeness, evidenceCoverage: requiredFactStatus.length ? Math.round(requiredFactStatus.filter(item => item.satisfied).length / requiredFactStatus.length * 100) : 100, requiredFactsSatisfied: requiredFactStatus.every(item => item.satisfied), rangeKnown: input.scope?.coverage !== 'unknown', noTruncation: !quality.isTruncated };
  const fallback = { provider: 'deterministic-fallback', title: skill?.fallbackNarrative?.[0]?.title || '可核验基础洞察', facts: facts.slice(0, 30), limitations: [quality.isTruncated ? '结果存在截断，结论仅限当前返回范围。' : null, quality.completeness < (skill?.qualityThresholds?.completeness || 80) ? '数据完整度低于领域阈值。' : null].filter(Boolean), actions: skill?.diagnostics?.flatMap(item => item.playbook || []).slice(0, 5) || [] };
  return { schema: VERSION, skillRefs: skills.map(item => `${item.id}@${item.version}`), facts, requiredFacts: requiredFactStatus, quality, qualityGates, evidenceIds: [...new Set(evidenceIds)], fallback };
}

export const businessFactPackVersion = VERSION;
