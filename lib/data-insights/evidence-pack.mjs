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
      const value = Number(row[field.name]);
      if (Number.isFinite(value)) current[field.name] = (current[field.name] || 0) + value;
    }
    groups.set(key, current);
  }
  const all = [...groups.values()].map(row => {
    return { ...row };
  });
  const sortField = measures[0]?.name;
  if (sortField) all.sort((left, right) => Number(right[sortField] || 0) - Number(left[sortField] || 0));
  return { rows: all.slice(0, maxGroups), totalGroups: all.length, resultLimited: all.length > maxGroups };
}

function groupingsFor(resultSet) {
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
    const grouping = aggregateGrouping(rows, spec, measures);
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

function resultPack(resultSet) {
  const schema = resultSet.schema || [];
  const rows = resultSet.rows || [];
  const columns = schema.map(field => field.name);
  const statistics = {};
  for (const field of schema) {
    const values = rows.map(row => row[field.name]);
    const presentValues = values.filter(present);
    const nums = numeric(presentValues);
    const item = { field: field.name, type: field.type, role: field.role || null, nullCount: values.length - presentValues.length, distinctCount: new Set(presentValues.map(value => JSON.stringify(value))).size };
    if (nums.length) Object.assign(item, { count: nums.length, sum: nums.reduce((a, b) => a + b, 0), average: nums.reduce((a, b) => a + b, 0) / nums.length, min: Math.min(...nums), max: Math.max(...nums), p25: quantile(nums, 0.25), median: quantile(nums, 0.5), p75: quantile(nums, 0.75) });
    if (field.role === 'dimension' || field.role === 'time' || field.type === 'string' || field.type === 'date' || field.type === 'datetime') {
      const counts = new Map();
      for (const value of presentValues) counts.set(String(value), (counts.get(String(value)) || 0) + 1);
      item.topValues = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count }));
    }
    statistics[field.name] = item;
  }
  const sampleIndexes = [...new Set([0, 1, 2, Math.floor(rows.length / 2), Math.max(0, rows.length - 3), Math.max(0, rows.length - 2), Math.max(0, rows.length - 1)])].filter(index => index >= 0 && index < rows.length);
  return {
    id: resultSet.id,
    scope: clone(resultSet.scope || {}),
    quality: clone(resultSet.quality || {}),
    statistics: { rowCount: rows.length, columnCount: columns.length, fields: statistics, groupings: groupingsFor(resultSet) },
    samples: sampleIndexes.map(index => ({ index, row: clone(rows[index]) })),
  };
}

export function buildEvidencePack(input = {}) {
  const resultSets = (input.resultSets || []).slice(0, 8).map(resultPack);
  return {
    schema: VERSION,
    title: input.title || null,
    source: clone(input.source || null),
    datasets: clone(input.datasets || []),
    scope: clone(input.scope || {}),
    quality: clone(input.quality || {}),
    evidence: clone(input.evidence || []).slice(0, 100),
    resultSets,
    policy: { rawRowsToLlm: false, sampleStrategy: 'boundary-and-middle', maxSamplesPerResultSet: 7 },
  };
}

export const evidencePackVersion = VERSION;
