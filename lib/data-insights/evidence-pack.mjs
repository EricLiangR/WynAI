const VERSION = 'wynai.evidence-pack/v1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function present(value) { return value !== null && value !== undefined && value !== ''; }
function numeric(values) { return values.map(Number).filter(Number.isFinite); }
function quantile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function isTimeField(field) {
  return field?.role === 'time' || ['date', 'datetime'].includes(field?.type) || /日期|时间|月份|月度|年度|年份|period|date|time/i.test(String(field?.name || ''));
}

function isMeasureField(field) {
  return field?.role === 'measure' || ['number', 'integer'].includes(field?.type);
}

function metricSemantics(field) {
  const semanticType = field?.semanticType || (field?.formula ? 'derived' : field?.role === 'identifier' ? 'identifier' : isMeasureField(field) ? 'measure' : field?.role || 'attribute');
  const aggregation = field?.aggregation || (semanticType === 'identifier' ? 'distinctCount' : field?.formula ? 'none' : isMeasureField(field) ? 'sum' : 'none');
  const additivity = field?.additivity || (field?.formula || ['ratio', 'yoy', 'share', 'rate', 'average'].some(token => String(semanticType).toLowerCase().includes(token)) ? 'non-additive' : ['sum', 'count', 'distinctCount'].includes(aggregation) ? 'additive' : 'non-additive');
  return { semanticType, aggregation, additivity, metricId: field?.metricId || null, derivedFrom: field?.derivedFrom || null, formula: field?.formula || null, isPreAggregated: Boolean(field?.isPreAggregated) };
}

function periodKey(value) {
  if (value === null || value === undefined || value === '') return '(空时间)';
  const text = String(value).trim();
  const chineseMonth = text.match(/^(\d{4})年\s*(\d{1,2})月/);
  if (chineseMonth) return `${chineseMonth[1]}-${String(chineseMonth[2]).padStart(2, '0')}`;
  const chineseYear = text.match(/^(\d{4})年$/);
  if (chineseYear) return chineseYear[1];
  const iso = text.match(/^(\d{4})[-/]?(\d{1,2})(?:[-/]?(\d{1,2}))?/);
  if (iso) return iso[3] ? `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}` : `${iso[1]}-${String(iso[2]).padStart(2, '0')}`;
  return text;
}

function aggregateGrouping(rows, dimensions, measures, maxGroups = 500) {
  const groups = new Map();
  for (const row of rows) {
    const values = dimensions.map(field => isTimeField(field) ? periodKey(row[field.name]) : (row[field.name] ?? '(空)'));
    const key = JSON.stringify(values);
    const current = groups.get(key) || { ...Object.fromEntries(dimensions.map((field, index) => [field.name, values[index]])), recordCount: 0 };
    current.recordCount += 1;
    for (const field of measures) {
      const semantics = metricSemantics(field);
      const value = Number(row[field.name]);
      if (!Number.isFinite(value) || semantics.additivity === 'non-additive' || semantics.additivity === 'derived' || semantics.aggregation === 'none') continue;
      if (semantics.aggregation === 'distinctCount' && !semantics.isPreAggregated) {
        current[`__distinct__${field.name}`] ||= new Set();
        current[`__distinct__${field.name}`].add(String(row[field.name]));
      } else if (semantics.aggregation === 'count') current[field.name] = (current[field.name] || 0) + 1;
      else current[field.name] = (current[field.name] || 0) + value;
    }
    groups.set(key, current);
  }
  const all = [...groups.values()].map(row => {
    const output = { ...row };
    for (const field of measures) {
      const key = `__distinct__${field.name}`;
      if (output[key]) { output[field.name] = output[key].size; delete output[key]; }
    }
    return output;
  });
  const sortField = measures[0]?.name;
  if (sortField) all.sort((left, right) => Number(right[sortField] || 0) - Number(left[sortField] || 0));
  return { rows: all.slice(0, maxGroups), totalGroups: all.length, resultLimited: all.length > maxGroups };
}

function compactRows(rows, maxRows) {
  if (!Array.isArray(rows) || rows.length <= maxRows) return rows;
  const head = Math.ceil(maxRows / 2);
  const tail = Math.floor(maxRows / 2);
  return [...rows.slice(0, head), ...rows.slice(-tail)];
}

function groupingsFor(resultSet, { maxGroups = 500 } = {}) {
  const schema = resultSet.schema || [];
  const rows = resultSet.rows || [];
  const dimensions = schema.filter(field => field?.role === 'dimension' || (!isTimeField(field) && !isMeasureField(field)));
  const times = schema.filter(isTimeField);
  const measures = schema.filter(isMeasureField);
  if (!rows.length || !measures.length) return [];
  const specs = [];
  for (const field of times) specs.push([field]);
  for (const field of dimensions) specs.push([field]);
  if (times.length && dimensions.length) specs.push([times[0], dimensions[0]]);
  if (times.length && dimensions.length > 1) specs.push([times[0], ...dimensions.slice(0, 4)]);
  if (!times.length && dimensions.length > 1) specs.push(dimensions.slice(0, 4));
  const seen = new Set();
  return specs.filter(spec => {
    const key = spec.map(field => field.name).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(spec => {
    const grouping = aggregateGrouping(rows, spec, measures, maxGroups);
    return {
      id: spec.map(field => field.name).join('-by-').replace(/[^A-Za-z0-9\u4e00-\u9fff_-]/g, '-').slice(0, 100),
      dimensions: spec.map(field => ({ name: field.name, role: field.role || (isTimeField(field) ? 'time' : 'dimension'), grain: isTimeField(field) ? 'month' : null })),
      measures: measures.map(field => field.name),
      rows: grouping.rows,
      totalGroups: grouping.totalGroups,
      resultLimited: grouping.resultLimited,
      aggregated: true,
    };
  });
}

function resultPack(resultSet, options = {}) {
  const schema = resultSet.schema || [];
  const rows = resultSet.rows || [];
  const columns = schema.map(field => field.name);
  const statistics = {};
  for (const field of schema) {
    const values = rows.map(row => row[field.name]);
    const presentValues = values.filter(present);
    const nums = numeric(presentValues);
    const semantics = metricSemantics(field);
    const item = { field: field.name, type: field.type, role: field.role || null, ...semantics, nullCount: values.length - presentValues.length, distinctCount: new Set(presentValues.map(value => JSON.stringify(value))).size };
    if (nums.length) Object.assign(item, { count: nums.length, average: nums.reduce((a, b) => a + b, 0) / nums.length, min: Math.min(...nums), max: Math.max(...nums), p25: quantile(nums, 0.25), median: quantile(nums, 0.5), p75: quantile(nums, 0.75) });
    if (nums.length && semantics.additivity !== 'non-additive' && semantics.additivity !== 'derived' && semantics.aggregation !== 'none') item.sum = nums.reduce((a, b) => a + b, 0);
    if (semantics.additivity === 'non-additive' || semantics.additivity === 'derived') item.sumSuppressed = true;
    if (field.role === 'dimension' || field.role === 'time' || field.type === 'string' || field.type === 'date' || field.type === 'datetime') {
      const counts = new Map();
      for (const value of presentValues) counts.set(String(value), (counts.get(String(value)) || 0) + 1);
      item.topValues = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count }));
    }
    statistics[field.name] = item;
  }
  const derived = [];
  for (const field of schema) {
    const item = statistics[field.name];
    if (!item) continue;
    if (rows.length) derived.push({ id: `ev-${resultSet.id}-field-${schema.indexOf(field)}-null-rate`, title: `${field.name} 空值率`, value: item.nullCount / rows.length * 100, unit: '%', formula: `${item.nullCount}/${rows.length}*100`, scope: resultSet.scope || null });
  }
  const timeField = schema.find(isTimeField);
  const additiveMeasures = schema.filter(field => isMeasureField(field) && ['additive', 'semi-additive'].includes(metricSemantics(field).additivity));
  if (timeField && additiveMeasures.length) {
    const periodGrouping = aggregateGrouping(rows, [timeField], additiveMeasures, 500).rows;
    for (const field of additiveMeasures) {
      const points = periodGrouping.filter(row => Number.isFinite(Number(row[field.name]))).sort((a, b) => String(a[timeField.name]).localeCompare(String(b[timeField.name])));
      for (let index = 1; index < points.length; index += 1) {
        const current = Number(points[index][field.name]);
        const previous = Number(points[index - 1][field.name]);
        if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) continue;
        derived.push({ id: `ev-${resultSet.id}-yoy-${field.name}-${index}`, title: `${field.name} 期间变化率`, value: (current - previous) / Math.abs(previous) * 100, unit: '%', formula: `(${current}-${previous})/${previous}*100`, scope: { ...(resultSet.scope || {}), timeField: timeField.name, period: points[index][timeField.name], previousPeriod: points[index - 1][timeField.name] } });
      }
    }
  }
  const sampleIndexes = [...new Set([0, 1, 2, Math.floor(rows.length / 2), Math.max(0, rows.length - 3), Math.max(0, rows.length - 2), Math.max(0, rows.length - 1)])].filter(index => index >= 0 && index < rows.length);
  return {
    id: resultSet.id,
    scope: clone(resultSet.scope || {}),
    quality: clone(resultSet.quality || {}),
    statistics: { rowCount: rows.length, columnCount: columns.length, fields: statistics, groupings: groupingsFor(resultSet, options), derived },
    samples: sampleIndexes.map(index => ({ index, row: clone(rows[index]) })),
  };
}

function compactEvidence(evidence, maxRows) {
  return (evidence || []).slice(0, 100).map(item => {
    if (!Array.isArray(item?.value) || item.value.length <= maxRows) return clone(item);
    const value = compactRows(item.value, maxRows).map(clone);
    return { ...clone(item), value, scope: { ...(item.scope || {}), resultLimited: true, sourceRowCount: item.value.length, representedRowCount: value.length, omissionReason: 'high-cardinality' } };
  });
}

function complexityFor(input, resultSets) {
  const first = resultSets[0];
  const fields = input.resultSets?.[0]?.schema || [];
  const dimensions = fields.filter(field => field?.role === 'dimension' || field?.role === 'time' || ['date', 'datetime'].includes(field?.type)).length;
  const groups = first?.statistics?.groupings?.reduce((sum, item) => sum + Number(item.totalGroups || 0), 0) || 0;
  const level = dimensions > 2 || Number(first?.statistics?.rowCount || 0) > 500 || groups > 1000 ? 'high-cardinality' : dimensions > 0 ? 'compact' : 'scalar';
  return { level, rowCount: first?.statistics?.rowCount || 0, dimensionCount: dimensions, groupingCount: groups };
}

function withBudget(pack, maxTokens) {
  const estimatedTokens = Math.ceil(JSON.stringify(pack).length / 4);
  return { ...pack, budget: { maxTokens, estimatedTokens, withinBudget: estimatedTokens <= maxTokens } };
}

export function buildEvidencePack(input = {}, { maxTokens = 20000, maxGroups = 40, maxEvidenceRows = 24 } = {}) {
  const resultSets = (input.resultSets || []).slice(0, 8).map(resultSet => resultPack(resultSet, { maxGroups }));
  const pack = {
    schema: VERSION,
    title: input.title || null,
    source: clone(input.source || null),
    datasets: clone(input.datasets || []),
    scope: clone(input.scope || {}),
    quality: clone(input.quality || {}),
    evidence: compactEvidence(input.evidence, maxEvidenceRows),
    resultSets,
    policy: { rawRowsToLlm: false, sampleStrategy: 'boundary-and-middle', maxSamplesPerResultSet: 7 },
  };
  pack.complexity = complexityFor(input, resultSets);
  pack.coverage = {
    sourceRows: pack.complexity.rowCount,
    representedGroups: resultSets.flatMap(resultSet => resultSet.statistics.groupings || []).reduce((sum, item) => sum + Math.min(Number(item.totalGroups || 0), item.rows.length), 0),
    omittedGroups: resultSets.flatMap(resultSet => resultSet.statistics.groupings || []).reduce((sum, item) => sum + Math.max(0, Number(item.totalGroups || 0) - item.rows.length), 0),
    reason: pack.complexity.level === 'high-cardinality' ? 'high-cardinality' : null,
  };
  return withBudget(pack, maxTokens);
}

export const evidencePackVersion = VERSION;
