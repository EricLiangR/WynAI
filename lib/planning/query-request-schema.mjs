import { isGroupableField, toDate, toNumber } from '../analysis-core.mjs';

const MODES = new Set(['profile', 'aggregate', 'detail', 'compare', 'mining', 'verify']);
const AGGREGATIONS = new Set(['sum', 'average', 'min', 'max', 'countRows', 'distinctCount']);
const GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'isNotNull']);
const RESULT_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);
const MAX_FILTERS = 8;
const MAX_SELECT_FIELDS = 64;
const MAX_MEASURES = 8;
const MAX_AGGREGATE_ROWS = 5000;
const MAX_DETAIL_ROWS = 5000;
const TOPICS = new Set(['baseline', 'quality', 'profitability', 'customer', 'product', 'anomaly', 'open']);

function queryError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeId(value, label = '查询 ID') {
  const id = String(value || '').trim();
  if (!/^[a-z][a-z0-9-]{1,79}$/i.test(id)) throw queryError(`${label} 无效`);
  return id;
}

function normalizeAlias(value, fallback) {
  const alias = String(value || fallback || '').trim();
  if (!/^[a-z][a-z0-9_]{0,40}$/i.test(alias)) throw queryError(`无效的结果别名：${alias}`);
  return alias;
}

export function findCatalogField(metadata, fieldName) {
  const name = String(fieldName || '').trim();
  const field = (metadata?.fields || []).find(item => item.name === name);
  if (!field) throw queryError(`字段不在数据集语义目录中：${name}`);
  return field;
}

function isNumericField(field) {
  return field?.role === 'measure' || /number|decimal|double|float|int|long/i.test(`${field?.type} ${field?.rawType}`);
}

function isTimeField(field) {
  return field?.role === 'time' || /date|time/i.test(`${field?.type} ${field?.rawType}`);
}

function normalizeScalarFilterValue(field, value) {
  if (isNumericField(field)) {
    const numeric = toNumber(value);
    if (numeric == null) throw queryError(`字段“${field.name}”需要数字筛选值`);
    return numeric;
  }
  if (isTimeField(field)) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/);
    if (!match || !toDate(text)) {
      throw queryError(`字段“${field.name}”需要 YYYY-MM-DD 日期`);
    }
    return match[1];
  }
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim();
  if (!text) throw queryError(`字段“${field.name}”的筛选值不能为空`);
  if (text.length > 200) throw queryError(`字段“${field.name}”的筛选值过长`);
  return text;
}

function normalizeFilterValue(field, value, operator) {
  if (operator === 'isNotNull') return null;
  if (operator !== 'in') return normalizeScalarFilterValue(field, value);
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.length > 50) throw queryError(`字段“${field.name}”的 in 筛选需要 1 至 50 个值`);
  return [...new Set(values.map(item => normalizeScalarFilterValue(field, item)))];
}

function normalizeResultFilters(input = [], measures = []) {
  if (!Array.isArray(input)) throw queryError('结果筛选条件必须是数组');
  if (input.length > 4) throw queryError('结果筛选条件最多 4 个');
  const aliases = new Set(measures.map(item => item.alias));
  return input.map(item => {
    const field = String(item?.field || '').trim();
    if (!aliases.has(field)) throw queryError(`结果筛选字段不是指标别名：${field}`);
    const operator = String(item?.operator || 'eq');
    if (!RESULT_OPERATORS.has(operator)) throw queryError(`不支持的结果筛选操作符：${operator}`);
    const values = operator === 'in' ? (Array.isArray(item.value) ? item.value : [item.value]) : [item.value];
    if (!values.length || values.length > 50) throw queryError(`结果筛选“${field}”的值数量无效`);
    const normalized = values.map(value => {
      const numeric = toNumber(value);
      if (numeric == null) throw queryError(`结果筛选“${field}”需要数字`);
      return numeric;
    });
    return { field, operator, value: operator === 'in' ? [...new Set(normalized)] : normalized[0] };
  });
}

function normalizeFieldComparisons(metadata, input = []) {
  if (!Array.isArray(input)) throw queryError('字段比较条件必须是数组');
  if (input.length > 4) throw queryError('字段比较条件最多 4 个');
  return input.map(item => {
    const left = findCatalogField(metadata, item?.left || item?.field);
    const right = findCatalogField(metadata, item?.right || item?.value);
    const operator = String(item?.operator || 'eq');
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(operator)) throw queryError(`不支持的字段比较操作符：${operator}`);
    const bothTime = isTimeField(left) && isTimeField(right);
    const bothNumeric = isNumericField(left) && isNumericField(right);
    if (!bothTime && !bothNumeric && left.role !== right.role) throw queryError(`字段“${left.name}”与“${right.name}”类型不兼容`);
    return { left: left.name, operator, right: right.name, valueType: bothTime ? 'time' : bothNumeric ? 'number' : 'string' };
  });
}

export function normalizeCanonicalFilters(metadata, input = []) {
  if (!Array.isArray(input)) throw queryError('筛选条件必须是数组');
  if (input.length > MAX_FILTERS) throw queryError(`筛选条件最多 ${MAX_FILTERS} 个`);
  return input.map(item => {
    const field = findCatalogField(metadata, item?.field);
    const operator = String(item?.operator || 'eq');
    if (!OPERATORS.has(operator)) throw queryError(`不支持的筛选操作符：${operator}`);
    return {
      field: field.name,
      operator,
      value: normalizeFilterValue(field, item?.value, operator),
      fieldType: field.role,
    };
  });
}

function compareValue(field, actual, expected, operator) {
  if (operator === 'isNotNull') return actual != null && actual !== '';
  if (operator === 'in') return expected.some(value => compareValue(field, actual, value, 'eq'));
  let left = actual;
  let right = expected;
  if (isNumericField(field)) {
    left = toNumber(actual);
    right = toNumber(expected);
  } else if (isTimeField(field)) {
    left = toDate(actual)?.getTime() ?? null;
    right = toDate(expected)?.getTime() ?? null;
  } else {
    left = actual == null ? '' : String(actual);
    right = String(expected);
  }
  if (left == null || right == null) return false;
  if (operator === 'eq') return left === right;
  if (operator === 'neq') return left !== right;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  return left <= right;
}

export function applyCanonicalFilters(rows, metadata, filters = [], fieldComparisons = []) {
  if (!filters.length && !fieldComparisons.length) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const literalsMatch = filters.every(filter => {
      const field = findCatalogField(metadata, filter.field);
      return compareValue(field, row[field.name], filter.value, filter.operator);
    });
    const fieldsMatch = fieldComparisons.every(comparison => {
      const left = findCatalogField(metadata, comparison.left);
      return compareValue(left, row[left.name], row[comparison.right], comparison.operator);
    });
    return literalsMatch && fieldsMatch;
  });
}

export function normalizeCanonicalQueryRequest(metadata, input = {}) {
  if (!metadata?.id) throw queryError('缺少数据集语义目录');
  if (['wax', 'sql', 'query', 'payload', 'pivotPayload'].some(key => input[key] != null)) {
    throw queryError('CanonicalQueryRequest 禁止包含 WAX、SQL 或原始执行 Payload');
  }
  const datasetId = String(input.dataset?.id || input.datasetId || metadata.id).trim();
  if (datasetId !== metadata.id) throw queryError('查询数据集与当前语义目录不一致');
  const mode = String(input.mode || '').trim();
  if (!MODES.has(mode)) throw queryError(`不支持的查询模式：${mode}`);

  const selectInput = Array.isArray(input.select) ? input.select : [];
  const maximumSelectFields = ['detail', 'mining'].includes(mode) ? MAX_SELECT_FIELDS : 2;
  if (selectInput.length > maximumSelectFields) throw queryError(`${mode} 查询字段最多 ${maximumSelectFields} 个`);
  const aliases = new Set();
  const select = selectInput.map((item, index) => {
    const field = findCatalogField(metadata, item?.field);
    const alias = normalizeAlias(item?.alias, `dimension${index + 1}`);
    if (aliases.has(alias)) throw queryError(`查询结果别名重复：${alias}`);
    aliases.add(alias);
    const grain = item?.grain ? String(item.grain) : null;
    if (grain && (!GRAINS.has(grain) || !isTimeField(field))) {
      throw queryError(`字段“${field.name}”不支持时间粒度 ${grain}`);
    }
    const identifierVerification = !grain && field.role === 'identifier' && mode === 'verify';
    if (!grain && !isGroupableField(field) && !identifierVerification && ['aggregate', 'compare', 'verify'].includes(mode)) {
      throw queryError(`字段“${field.name}”不允许在 ${mode} 模式下直接作为分组维度`);
    }
    return { field: field.name, alias, role: field.role, grain };
  });

  const measureInput = Array.isArray(input.measures) ? input.measures : [];
  if (measureInput.length > MAX_MEASURES) throw queryError(`查询指标最多 ${MAX_MEASURES} 个`);
  const measures = measureInput.map((item, index) => {
    if (item?.formula) throw queryError('首个 V2 切片尚未开放派生公式执行');
    const aggregation = String(item?.aggregation || '').trim();
    if (!AGGREGATIONS.has(aggregation)) throw queryError(`不支持的聚合操作：${aggregation}`);
    if (aggregation === 'countRows' && String(item?.field || '').trim()) {
      throw queryError('countRows 只能统计筛选后的记录数，不允许指定字段');
    }
    const field = aggregation === 'countRows' ? null : findCatalogField(metadata, item?.field);
    if (field && !isNumericField(field) && !['distinctCount', 'min', 'max'].includes(aggregation)) {
      throw queryError(`字段“${field.name}”不支持 ${aggregation} 聚合`);
    }
    const alias = normalizeAlias(item?.alias, `metric${index + 1}`);
    if (aliases.has(alias)) throw queryError(`查询结果别名重复：${alias}`);
    aliases.add(alias);
    return { field: field?.name || null, aggregation, alias, resultType: item?.resultType || 'number' };
  });
  const measureSignatures = new Set();
  for (const measure of measures) {
    const signature = `${measure.field || '*'}|${measure.aggregation}`;
    if (measureSignatures.has(signature)) throw queryError(`查询包含重复聚合口径：${signature}`);
    measureSignatures.add(signature);
  }
  const resultFilters = normalizeResultFilters(input.resultFilters || [], measures);
  const fieldComparisons = normalizeFieldComparisons(metadata, input.fieldComparisons || []);

  if (['aggregate', 'compare', 'verify'].includes(mode) && !measures.length) {
    throw queryError(`${mode} 查询至少需要一个指标`);
  }
  if (['detail', 'mining'].includes(mode) && !select.length) {
    throw queryError(`${mode} 查询至少需要一个字段`);
  }

  const maximumRows = mode === 'detail' || mode === 'mining' ? MAX_DETAIL_ROWS : MAX_AGGREGATE_ROWS;
  const requestedLimit = Number(input.limit || input.expectedResult?.maximumRows || 100);
  const limit = Math.max(1, Math.min(maximumRows, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const orderByInput = Array.isArray(input.orderBy) ? input.orderBy : [];
  const orderBy = orderByInput.slice(0, 3).map(item => {
    const field = String(item?.field || '').trim();
    if (!aliases.has(field)) throw queryError(`排序字段不在查询结果中：${field}`);
    const direction = String(item?.direction || 'desc').toLowerCase();
    if (!['asc', 'desc'].includes(direction)) throw queryError('排序方向只能是 asc 或 desc');
    return { field, direction };
  });
  const topic = TOPICS.has(String(input.topic || '')) ? String(input.topic) : 'open';
  let lineage = null;
  if (input.lineage != null) {
    const parentHypothesisId = input.lineage.parentHypothesisId
      ? normalizeId(input.lineage.parentHypothesisId, '父假设 ID')
      : null;
    const triggerResultSetIds = Array.isArray(input.lineage.triggerResultSetIds)
      ? input.lineage.triggerResultSetIds.slice(0, 8).map(value => normalizeId(value, '触发结果集 ID'))
      : [];
    lineage = {
      parentHypothesisId,
      triggerResultSetIds,
      reason: String(input.lineage.reason || '').trim().slice(0, 1000),
    };
  }

  return {
    id: normalizeId(input.id),
    hypothesisId: input.hypothesisId ? normalizeId(input.hypothesisId, '假设 ID') : null,
    purpose: String(input.purpose || '').trim().slice(0, 500) || '未命名查询需求',
    mode,
    topic,
    dataset: { id: metadata.id, revision: metadata.revision ?? null },
    select,
    measures,
    filters: normalizeCanonicalFilters(metadata, input.filters || []),
    resultFilters,
    fieldComparisons,
    comparison: input.comparison || null,
    orderBy,
    limit,
    expectedResult: {
      shape: input.expectedResult?.shape || 'table',
      minimumRows: Math.max(0, Math.min(limit, Number(input.expectedResult?.minimumRows) || 0)),
      maximumRows: limit,
      requiredPeriods: [...new Set((Array.isArray(input.expectedResult?.requiredPeriods) ? input.expectedResult.requiredPeriods : []).map(String))].slice(0, 64),
      requiredMetrics: [...new Set((Array.isArray(input.expectedResult?.requiredMetrics) ? input.expectedResult.requiredMetrics : []).map(String))].slice(0, 8),
      requiredDimensions: [...new Set((Array.isArray(input.expectedResult?.requiredDimensions) ? input.expectedResult.requiredDimensions : []).map(String))].slice(0, 8),
      timeZone: String(input.expectedResult?.timeZone || 'Asia/Shanghai').slice(0, 80),
    },
    sensitivity: input.sensitivity || (['detail', 'mining'].includes(mode) ? 'controlled-detail' : 'aggregate-only'),
    lineage,
  };
}

export const canonicalQueryLimits = Object.freeze({
  maxFilters: MAX_FILTERS,
  maxSelectFields: MAX_SELECT_FIELDS,
  maxMeasures: MAX_MEASURES,
  maxAggregateRows: MAX_AGGREGATE_ROWS,
  maxDetailRows: MAX_DETAIL_ROWS,
});
