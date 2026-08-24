import { toDate, toNumber } from '../analysis-core.mjs';
import { bucketDate } from '../semantics/time-semantics.mjs';

function readCell(row, key) {
  if (row?.[key] !== undefined) return row[key];
  if (row?.[`[${key}]`] !== undefined) return row[`[${key}]`];
  const match = Object.keys(row || {}).find(item => item.replace(/^\[|\]$/g, '').toLowerCase() === key.toLowerCase());
  return match ? row[match] : null;
}

function fieldType(field) {
  if (!field) return 'unknown';
  if (field.role === 'time' || /date|time/i.test(`${field.type} ${field.rawType}`)) return 'date';
  if (field.role === 'measure' || /number|decimal|double|float|int|long/i.test(`${field.type} ${field.rawType}`)) return 'number';
  return 'string';
}

function normalizeValue(value, type) {
  if (value == null || value === '') return value == null ? null : value;
  if (type === 'number') return toNumber(value) ?? value;
  if (type === 'date') return toDate(value)?.toISOString() || value;
  return value;
}

function resultSchema(request, metadata) {
  const fields = metadata?.fields || [];
  return [
    ...request.select.map(item => {
      const field = fields.find(candidate => candidate.name === item.field);
      return { name: item.alias, sourceField: item.field, type: fieldType(field), role: 'dimension', grain: item.grain || null };
    }),
    ...request.measures.map(item => ({
      name: item.alias,
      sourceField: item.field,
      type: item.resultType === 'percentage' ? 'number' : 'number',
      role: 'measure',
      aggregation: item.aggregation,
    })),
  ];
}

function normalizeRows(rawRows, request, schema) {
  return (Array.isArray(rawRows) ? rawRows : []).map(rawRow => {
    const row = {};
    request.select.forEach((item, index) => {
      const column = schema.find(candidate => candidate.name === item.alias);
      row[item.alias] = normalizeValue(readCell(rawRow, item.alias) ?? readCell(rawRow, `group${index + 1}`) ?? readCell(rawRow, item.field), column?.type);
    });
    request.measures.forEach(item => {
      const column = schema.find(candidate => candidate.name === item.alias);
      row[item.alias] = normalizeValue(readCell(rawRow, item.alias), column?.type);
    });
    return row;
  });
}

function grainValue(value, grain, timeZone) {
  return grain ? bucketDate(value, grain, timeZone) : value;
}

function aggregateMeasure(rows, measure) {
  const values = rows.map(row => toNumber(row[measure.alias])).filter(value => value != null);
  if (!values.length) return null;
  if (measure.aggregation === 'min') return Math.min(...values);
  if (measure.aggregation === 'max') return Math.max(...values);
  if (measure.aggregation === 'average') return values.reduce((total, value) => total + value, 0) / values.length;
  return values.reduce((total, value) => total + value, 0);
}

function sortRows(rows, request) {
  const orders = request.orderBy || [];
  if (!orders.length) return rows;
  return [...rows].sort((left, right) => {
    for (const order of orders) {
      const a = left[order.field];
      const b = right[order.field];
      const comparison = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a ?? '').localeCompare(String(b ?? ''));
      if (comparison) return order.direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
}

function normalizeTimeGrains(rows, request) {
  if (!request.select.some(item => item.grain)) return rows;
  const timeZone = request.expectedResult?.timeZone || 'Asia/Shanghai';
  const groups = new Map();
  for (const row of rows) {
    const dimensions = Object.fromEntries(request.select.map(item => [item.alias, grainValue(row[item.alias], item.grain, timeZone)]));
    const key = JSON.stringify(dimensions);
    if (!groups.has(key)) groups.set(key, { dimensions, rows: [] });
    groups.get(key).rows.push(row);
  }
  const grouped = [...groups.values()].map(group => ({
    ...group.dimensions,
    ...Object.fromEntries(request.measures.map(measure => [measure.alias, aggregateMeasure(group.rows, measure)])),
  }));
  return grouped;
}

function compareResultValue(actual, expected, operator) {
  if (operator === 'in') return expected.includes(actual);
  if (operator === 'eq') return actual === expected;
  if (operator === 'neq') return actual !== expected;
  if (operator === 'gt') return actual > expected;
  if (operator === 'gte') return actual >= expected;
  if (operator === 'lt') return actual < expected;
  return actual <= expected;
}

function applyResultFilters(rows, filters = []) {
  if (!filters.length) return rows;
  return rows.filter(row => filters.every(filter => {
    const actual = toNumber(row[filter.field]);
    if (actual == null) return false;
    return compareResultValue(actual, filter.value, filter.operator);
  }));
}

function resultStatistics(rows, schema) {
  const nullCounts = {};
  const minimums = {};
  const maximums = {};
  for (const column of schema) {
    const values = rows.map(row => row[column.name]).filter(value => value !== null && value !== undefined && value !== '');
    nullCounts[column.name] = rows.length - values.length;
    if (!values.length) continue;
    if (column.type === 'number') {
      const numeric = values.map(toNumber).filter(value => value != null);
      if (numeric.length) {
        minimums[column.name] = Math.min(...numeric);
        maximums[column.name] = Math.max(...numeric);
      }
    } else if (column.type === 'date') {
      const dated = values.map(toDate).filter(Boolean).sort((a, b) => a - b);
      if (dated.length) {
        minimums[column.name] = dated[0].toISOString();
        maximums[column.name] = dated.at(-1).toISOString();
      }
    }
  }
  return { rowCount: rows.length, nullCounts, minimums, maximums };
}

export function normalizeCanonicalResultSet({ request, executionPlan, rawResult, metadata }) {
  const schema = resultSchema(request, metadata);
  const normalizedRows = normalizeRows(rawResult?.rows, request, schema);
  const grainedRows = normalizeTimeGrains(normalizedRows, request);
  const rows = sortRows(applyResultFilters(grainedRows, request.resultFilters), request).slice(0, request.limit);
  const grainWarnings = request.select.some(item => item.grain) && request.measures.some(item => item.aggregation === 'average')
    ? ['时间粒度上的 average 由原始日期分组均值再次平均，仅作为近似结果；严格分析应使用加权聚合']
    : [];
  return {
    id: `rs-${request.id}`,
    requestId: request.id,
    executionPlanId: executionPlan.id,
    schema,
    rows,
    statistics: resultStatistics(rows, schema),
    scope: {
      datasetId: request.dataset.id,
      datasetRevision: request.dataset.revision,
      filters: request.filters,
      resultFilters: request.resultFilters,
      fieldComparisons: request.fieldComparisons,
      timeRange: rawResult?.timeRange || null,
      aggregationLevel: request.select.map(item => item.alias),
      timeZone: request.expectedResult?.timeZone || 'Asia/Shanghai',
    },
    provenance: {
      adapter: executionPlan.adapter,
      adapterVersion: executionPlan.adapterVersion,
      executedAt: rawResult?.executedAt || new Date().toISOString(),
      durationMs: rawResult?.durationMs ?? null,
    },
    quality: {
      isSample: Boolean(rawResult?.isSample),
      isTruncated: Boolean(rawResult?.truncated),
      limitReached: Boolean(rawResult?.limitReached),
      truncationConfidence: rawResult?.truncationConfidence || (rawResult?.truncated ? 'confirmed' : 'none'),
      isEstimated: Boolean(rawResult?.isEstimated),
      warnings: [...(executionPlan.warnings || []), ...(rawResult?.warnings || []), ...grainWarnings],
    },
  };
}

export function summarizeResultSet(resultSet, { retainRows = true } = {}) {
  return {
    ...resultSet,
    rows: retainRows ? resultSet.rows : [],
    rowStorage: retainRows ? 'persisted' : 'not-persisted-sensitive-detail',
  };
}
