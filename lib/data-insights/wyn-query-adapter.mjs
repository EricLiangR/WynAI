const MAX_ROWS = 20000;

function findRowArray(value, depth = 0, candidates = []) {
  if (depth > 12 || value == null) return candidates;
  if (Array.isArray(value)) {
    if (value.length && value.some(item => item && typeof item === 'object' && !Array.isArray(item))) candidates.push(value);
    for (const item of value.slice(0, 12)) findRowArray(item, depth + 1, candidates);
  } else if (typeof value === 'object') {
    for (const child of Object.values(value)) findRowArray(child, depth + 1, candidates);
  }
  return candidates;
}

function matrixRows(value, depth = 0, candidates = []) {
  if (depth > 12 || value == null) return candidates;
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every(row => Array.isArray(row))) {
      const headers = value[0];
      if (headers.length && headers.every(header => ['string', 'number'].includes(typeof header))) candidates.push({ headers: headers.map(String), rows: value.slice(1) });
    }
    for (const item of value.slice(0, 12)) matrixRows(item, depth + 1, candidates);
  } else if (typeof value === 'object') {
    const rows = value.rows || value.dataRows || value.values;
    const columns = value.columns || value.fields || value.headers;
    if (Array.isArray(rows) && rows.length && rows.every(row => Array.isArray(row)) && Array.isArray(columns)) {
      const headers = columns.map(column => typeof column === 'string' ? column : column?.name || column?.label || column?.alias || '').filter(Boolean);
      if (headers.length) candidates.push({ headers, rows });
    }
    for (const child of Object.values(value)) matrixRows(child, depth + 1, candidates);
  }
  return candidates;
}

function unwrapValue(value, depth = 0) {
  if (depth > 5) return value;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.length === 1) return unwrapValue(value[0], depth + 1);
    return value.map(item => unwrapValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    for (const key of ['raw', 'displayValue', 'formattedValue', 'value', 'display', 'label']) {
      if (value[key] != null) return unwrapValue(value[key], depth + 1);
    }
  }
  return value;
}

export function extractWynRows(record) {
  const aggregationResult = record?.aggregationResult;
  const direct = [aggregationResult?.data, aggregationResult?.rows, aggregationResult?.result?.data, aggregationResult?.result?.rows, aggregationResult?.resultSet?.data, aggregationResult?.resultSet?.rows]
    .filter(candidate => Array.isArray(candidate) && candidate.length).sort((a, b) => b.length - a.length)[0];
  let rows = direct || [...findRowArray(aggregationResult), ...findRowArray(record?.pivotPayload)].sort((a, b) => b.length - a.length)[0];
  if (!rows) {
    const matrix = [...matrixRows(aggregationResult), ...matrixRows(record?.pivotPayload)].sort((a, b) => b.rows.length - a.rows.length)[0];
    if (matrix) rows = matrix.rows.map(row => Object.fromEntries(matrix.headers.map((header, index) => [header, row[index] ?? null])));
  }
  if (!rows?.length) return [];
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { 序号: index + 1, 值: unwrapValue(row) };
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, unwrapValue(value)]));
  });
}

function valueType(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) return 'datetime';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))) return 'date';
  return 'string';
}

function fieldType(rows, name) {
  const types = new Set(rows.map(row => valueType(row[name])).filter(Boolean));
  if (!types.size) return 'unknown';
  if (types.size === 1) return [...types][0];
  if ([...types].every(type => ['integer', 'number'].includes(type))) return 'number';
  return 'unknown';
}

function schemaFor(rows) {
  const names = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 100);
  return names.map(name => {
    const type = fieldType(rows, name);
    return { name, type, role: ['integer', 'number'].includes(type) ? 'measure' : ['date', 'datetime'].includes(type) ? 'time' : 'dimension' };
  });
}

export function adaptWynQueryResult(record, view = {}) {
  const allRows = extractWynRows(record);
  if (!allRows.length) return null;
  const rows = allRows.slice(0, MAX_ROWS);
  const schema = schemaFor(rows);
  const allowedFields = new Set(schema.map(field => field.name));
  const normalizedRows = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => allowedFields.has(key))));
  const datasetId = record.datasetId || record.aggregationResult?.datasetId || view.chart?.datasetId || '';
  const query = record.query || view.chart?.query || null;
  const title = record.topic || view.insight?.topic || query?.name || 'Wyn 分析结果';
  const truncated = allRows.length > rows.length;
  return {
    schema: 'wynai.insight-input/v1',
    title,
    source: { type: 'wyn-query', sourceId: record.viewId },
    ...(datasetId ? { datasets: [{ id: datasetId }] } : {}),
    context: { ...(query ? { query } : {}), viewId: record.viewId },
    scope: { coverage: 'unknown' },
    quality: { accuracy: 'unknown', isSample: null, isTruncated: truncated, isEstimated: null, warnings: truncated ? [`Wyn 结果超过 ${MAX_ROWS} 行，标准输入已截断`] : [] },
    resultSets: [{ id: `wyn-${record.viewId}`.slice(0, 100), schema, rows: normalizedRows, scope: { coverage: 'unknown' }, quality: { accuracy: 'unknown', isSample: null, isTruncated: truncated, isEstimated: null, warnings: [] }, statistics: { sourceRowCount: allRows.length } }],
    evidence: [],
  };
}

export class WynQueryInsightAdapter {
  constructor({ register, maxItems = 30 } = {}) {
    if (typeof register !== 'function') throw new Error('WynQueryInsightAdapter 缺少 register');
    this.register = register;
    this.maxItems = maxItems;
    this.captures = new Map();
    this.views = new Map();
  }

  updateView(viewId, view) {
    if (!viewId || !view) return null;
    this.views.set(viewId, view);
    return this.tryRegister(viewId);
  }

  capture(viewId, patch) {
    if (!viewId) return null;
    const existing = this.captures.get(viewId) || { viewId };
    this.captures.delete(viewId);
    this.captures.set(viewId, { ...existing, ...patch, viewId });
    while (this.captures.size > this.maxItems) {
      const oldest = this.captures.keys().next().value;
      this.captures.delete(oldest);
      this.views.delete(oldest);
    }
    return this.tryRegister(viewId);
  }

  tryRegister(viewId) {
    const input = adaptWynQueryResult(this.captures.get(viewId), this.views.get(viewId));
    return input ? this.register(input) : null;
  }
}
