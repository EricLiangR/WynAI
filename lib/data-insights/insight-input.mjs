const INPUT_SCHEMA = 'wynai.insight-input/v1';
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'object', 'array', 'unknown']);
const FIELD_ROLES = new Set(['dimension', 'measure', 'identifier', 'attribute', 'time', 'unknown']);
const RESULT_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const TOP_LEVEL_FIELDS = new Set(['schema', 'title', 'source', 'datasets', 'context', 'scope', 'quality', 'evidence', 'resultSets']);
const RESULT_SET_FIELDS = new Set(['id', 'schema', 'rows', 'scope', 'quality', 'statistics']);
const FIELD_FIELDS = new Set(['name', 'type', 'role', 'displayName', 'sourceField', 'format', 'unit', 'grain', 'metricId', 'aggregation', 'semanticType', 'additivity', 'derivedFrom', 'formula', 'calculationScope', 'isPreAggregated']);
const FIELD_AGGREGATIONS = new Set(['sum', 'average', 'min', 'max', 'count', 'distinctCount', 'none']);
const FIELD_ADDITIVITY = new Set(['additive', 'semi-additive', 'non-additive', 'derived', 'none']);

export class InsightInputError extends Error {
  constructor(message, { code = 'INVALID_INSIGHT_INPUT', path = '', status = 422 } = {}) {
    super(message);
    this.name = 'InsightInputError';
    this.code = code;
    this.path = path;
    this.status = status;
  }
}

function fail(message, path, code = 'INVALID_INSIGHT_INPUT') {
  throw new InsightInputError(message, { path, code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonClone(value, path) {
  try {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  } catch {
    fail('字段必须是可序列化的 JSON 数据', path);
  }
}

function text(value, path, { required = false, max = 200 } = {}) {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string') fail('字段必须是字符串', path);
  const normalized = value.trim();
  if (required && !normalized) fail('字段不能为空', path);
  if (normalized.length > max) fail(`字段长度不能超过 ${max}`, path);
  return normalized;
}

function rejectUnknownFields(input, allowed, path) {
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) fail(`不支持字段 ${unknown}`, path ? `${path}.${unknown}` : unknown, 'UNKNOWN_FIELD');
}

function normalizeQuality(input, path) {
  if (input == null) return { accuracy: 'unknown', isSample: null, isTruncated: null, isEstimated: null, warnings: [] };
  if (!isPlainObject(input)) fail('quality 必须是对象', path);
  const quality = jsonClone(input, path);
  const accuracy = quality.accuracy ?? 'unknown';
  if (!['exact', 'sample', 'estimated', 'unknown'].includes(accuracy)) fail('accuracy 值无效', `${path}.accuracy`);
  for (const key of ['isSample', 'isTruncated', 'isEstimated']) {
    if (quality[key] != null && typeof quality[key] !== 'boolean') fail(`${key} 必须是布尔值或 null`, `${path}.${key}`);
  }
  if (quality.warnings != null && (!Array.isArray(quality.warnings) || quality.warnings.some(item => typeof item !== 'string'))) {
    fail('warnings 必须是字符串数组', `${path}.warnings`);
  }
  return {
    ...quality,
    accuracy,
    isSample: quality.isSample ?? null,
    isTruncated: quality.isTruncated ?? null,
    isEstimated: quality.isEstimated ?? null,
    warnings: (quality.warnings || []).slice(0, 50),
  };
}

function matchesFieldType(value, type) {
  if (value == null || type === 'unknown') return true;
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'date') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) && !Number.isNaN(Date.parse(value));
  if (type === 'datetime') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
  return false;
}

function normalizeField(input, resultIndex, fieldIndex) {
  const path = `resultSets[${resultIndex}].schema[${fieldIndex}]`;
  if (!isPlainObject(input)) fail('Schema 字段必须是对象', path);
  rejectUnknownFields(input, FIELD_FIELDS, path);
  const name = text(input.name, `${path}.name`, { required: true });
  const type = text(input.type, `${path}.type`, { required: true, max: 40 });
  if (!FIELD_TYPES.has(type)) fail(`不支持字段类型 ${type}`, `${path}.type`, 'UNSUPPORTED_FIELD_TYPE');
  if (input.role != null && !FIELD_ROLES.has(input.role)) fail(`不支持字段角色 ${input.role}`, `${path}.role`);
  if (input.aggregation != null && !FIELD_AGGREGATIONS.has(input.aggregation)) fail(`不支持字段聚合 ${input.aggregation}`, `${path}.aggregation`);
  if (input.additivity != null && !FIELD_ADDITIVITY.has(input.additivity)) fail(`不支持字段可加性 ${input.additivity}`, `${path}.additivity`);
  if (input.formula != null && !isPlainObject(input.formula)) fail('formula 必须是对象', `${path}.formula`);
  if (input.calculationScope != null && !isPlainObject(input.calculationScope)) fail('calculationScope 必须是对象', `${path}.calculationScope`);
  if (input.isPreAggregated != null && typeof input.isPreAggregated !== 'boolean') fail('isPreAggregated 必须是布尔值', `${path}.isPreAggregated`);
  return {
    name,
    type,
    ...(input.role ? { role: input.role } : {}),
    ...(input.displayName != null ? { displayName: text(input.displayName, `${path}.displayName`) } : {}),
    ...(input.sourceField != null ? { sourceField: text(input.sourceField, `${path}.sourceField`) } : {}),
    ...(input.format != null ? { format: text(input.format, `${path}.format`, { max: 80 }) } : {}),
    ...(input.unit != null ? { unit: text(input.unit, `${path}.unit`, { max: 80 }) } : {}),
    ...(input.grain != null ? { grain: text(input.grain, `${path}.grain`, { max: 40 }) } : {}),
    ...(input.metricId != null ? { metricId: text(input.metricId, `${path}.metricId`, { max: 100 }) } : {}),
    ...(input.aggregation != null ? { aggregation: input.aggregation } : {}),
    ...(input.semanticType != null ? { semanticType: text(input.semanticType, `${path}.semanticType`, { max: 80 }) } : {}),
    ...(input.additivity != null ? { additivity: input.additivity } : {}),
    ...(input.derivedFrom != null ? { derivedFrom: jsonClone(input.derivedFrom, `${path}.derivedFrom`) } : {}),
    ...(input.formula != null ? { formula: jsonClone(input.formula, `${path}.formula`) } : {}),
    ...(input.calculationScope != null ? { calculationScope: jsonClone(input.calculationScope, `${path}.calculationScope`) } : {}),
    ...(input.isPreAggregated != null ? { isPreAggregated: input.isPreAggregated } : {}),
  };
}

function normalizeResultSet(input, index) {
  const path = `resultSets[${index}]`;
  if (!isPlainObject(input)) fail('结果集必须是对象', path);
  rejectUnknownFields(input, RESULT_SET_FIELDS, path);
  const id = text(input.id, `${path}.id`, { required: true, max: 100 });
  if (!RESULT_SET_ID.test(id)) fail('结果集 ID 格式无效', `${path}.id`, 'INVALID_RESULT_SET_ID');
  if (!Array.isArray(input.schema) || !input.schema.length) fail('结果集 Schema 至少需要一个字段', `${path}.schema`);
  if (input.schema.length > 100) fail('结果集 Schema 最多包含 100 个字段', `${path}.schema`, 'RESULT_SET_TOO_LARGE');
  const schema = input.schema.map((field, fieldIndex) => normalizeField(field, index, fieldIndex));
  const fieldNames = new Set();
  for (const field of schema) {
    if (fieldNames.has(field.name)) fail(`Schema 字段名重复：${field.name}`, `${path}.schema`, 'DUPLICATE_FIELD');
    fieldNames.add(field.name);
  }
  if (!Array.isArray(input.rows) || !input.rows.length) fail('结果集至少需要一行数据', `${path}.rows`, 'EMPTY_RESULT_SET');
  if (input.rows.length > 20000) fail('单个结果集最多包含 20000 行', `${path}.rows`, 'RESULT_SET_TOO_LARGE');
  const schemaMap = new Map(schema.map(field => [field.name, field]));
  const rows = input.rows.map((row, rowIndex) => {
    const rowPath = `${path}.rows[${rowIndex}]`;
    if (!isPlainObject(row)) fail('数据行必须是对象', rowPath);
    for (const key of Object.keys(row)) {
      if (!schemaMap.has(key)) fail(`数据行包含 Schema 未声明字段：${key}`, `${rowPath}.${key}`, 'ROW_SCHEMA_MISMATCH');
      if (!matchesFieldType(row[key], schemaMap.get(key).type)) {
        fail(`字段 ${key} 的值不符合 ${schemaMap.get(key).type} 类型`, `${rowPath}.${key}`, 'ROW_TYPE_MISMATCH');
      }
    }
    return jsonClone(row, rowPath);
  });
  if (input.scope != null && !isPlainObject(input.scope)) fail('scope 必须是对象', `${path}.scope`);
  if (input.statistics != null && !isPlainObject(input.statistics)) fail('statistics 必须是对象', `${path}.statistics`);
  return {
    id,
    schema,
    rows,
    scope: jsonClone(input.scope || { coverage: 'unknown' }, `${path}.scope`),
    quality: normalizeQuality(input.quality, `${path}.quality`),
    ...(input.statistics ? { statistics: jsonClone(input.statistics, `${path}.statistics`) } : {}),
  };
}

export function normalizeInsightInput(input = {}) {
  if (!isPlainObject(input)) fail('InsightInput 必须是对象', '');
  rejectUnknownFields(input, TOP_LEVEL_FIELDS, '');
  if (input.schema !== INPUT_SCHEMA) {
    throw new InsightInputError(`仅支持协议 ${INPUT_SCHEMA}`, { code: 'UNSUPPORTED_SCHEMA', path: 'schema', status: 400 });
  }
  const title = text(input.title, 'title', { required: true });
  if (!Array.isArray(input.resultSets) || !input.resultSets.length) fail('至少需要一个结果集', 'resultSets', 'EMPTY_RESULT_SETS');
  if (input.resultSets.length > 8) fail('一次最多接收 8 个结果集', 'resultSets', 'TOO_MANY_RESULT_SETS');
  const resultSets = input.resultSets.map(normalizeResultSet);
  const ids = new Set();
  for (const resultSet of resultSets) {
    if (ids.has(resultSet.id)) fail(`结果集 ID 重复：${resultSet.id}`, 'resultSets', 'DUPLICATE_RESULT_SET_ID');
    ids.add(resultSet.id);
  }
  if (input.source != null && !isPlainObject(input.source)) fail('source 必须是对象', 'source');
  if (input.datasets != null && !Array.isArray(input.datasets)) fail('datasets 必须是数组', 'datasets');
  if (input.context != null && !isPlainObject(input.context)) fail('context 必须是对象', 'context');
  if (input.scope != null && !isPlainObject(input.scope)) fail('scope 必须是对象', 'scope');
  if (input.evidence != null && !Array.isArray(input.evidence)) fail('evidence 必须是数组', 'evidence');
  const source = input.source ? jsonClone(input.source, 'source') : null;
  if (source?.type != null) source.type = text(source.type, 'source.type', { required: true, max: 80 });
  if (source?.sourceId != null) source.sourceId = text(source.sourceId, 'source.sourceId', { required: true });
  if (source?.traceId != null) source.traceId = text(source.traceId, 'source.traceId');
  const datasets = (input.datasets || []).slice(0, 16).map((dataset, index) => {
    if (!isPlainObject(dataset)) fail('dataset 必须是对象', `datasets[${index}]`);
    const normalized = jsonClone(dataset, `datasets[${index}]`);
    normalized.id = text(dataset.id, `datasets[${index}].id`, { required: true });
    if (dataset.name != null) normalized.name = text(dataset.name, `datasets[${index}].name`);
    return normalized;
  });
  return {
    schema: INPUT_SCHEMA,
    title,
    resultSets,
    ...(source ? { source } : {}),
    ...(datasets.length ? { datasets } : {}),
    ...(input.context ? { context: jsonClone(input.context, 'context') } : {}),
    scope: jsonClone(input.scope || { coverage: 'unknown' }, 'scope'),
    quality: normalizeQuality(input.quality, 'quality'),
    evidence: (input.evidence || []).slice(0, 100).map((item, index) => {
      if (!isPlainObject(item)) fail('evidence 必须是对象', `evidence[${index}]`);
      return jsonClone(item, `evidence[${index}]`);
    }),
  };
}

export const insightInputVersion = INPUT_SCHEMA;
