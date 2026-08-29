const INPUT_SCHEMA = 'wynai.insight-input/v1';
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'object', 'array', 'unknown']);
const FIELD_ROLES = new Set(['dimension', 'measure', 'identifier', 'attribute', 'time', 'unknown']);
const FIELD_KEYS = ['name', 'type', 'role', 'displayName', 'sourceField', 'format', 'unit', 'grain', 'metricId', 'aggregation', 'semanticType', 'additivity', 'derivedFrom', 'formula', 'calculationScope', 'isPreAggregated'];
const MAX_RESULT_SETS = 8;
const MAX_ROWS = 20000;

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

function inferredType(rows, name) {
  const types = new Set(rows.map(row => valueType(row?.[name])).filter(Boolean));
  if (!types.size) return 'unknown';
  if (types.size === 1) return [...types][0];
  if ([...types].every(type => ['integer', 'number'].includes(type))) return 'number';
  return 'unknown';
}

function normalizedField(field, rows, sourceName, name) {
  const declaredType = String(field?.type || '').toLowerCase();
  const type = FIELD_TYPES.has(declaredType) ? declaredType : inferredType(rows, sourceName);
  const normalized = { name, type };
  for (const key of FIELD_KEYS.slice(2)) {
    const value = field?.[key];
    if (value == null || value === '') continue;
    if (key === 'role') {
      if (FIELD_ROLES.has(value)) normalized.role = value;
    } else if (['derivedFrom', 'formula', 'calculationScope'].includes(key)) {
      normalized[key] = value;
    } else {
      normalized[key] = String(value);
    }
  }
  return normalized;
}

function uniqueBusinessName(field, fallbackName, usedNames) {
  const candidates = [field?.displayName, field?.sourceField, fallbackName]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const preferred = candidates.find(value => !usedNames.has(value)) || candidates[0];
  if (!preferred) return null;
  let name = preferred;
  let suffix = 2;
  while (usedNames.has(name)) name = `${preferred}（${suffix++}）`;
  usedNames.add(name);
  return name;
}

function normalizedStatistics(statistics = {}, mappings = []) {
  const nameMap = new Map(mappings.map(mapping => [mapping.sourceName, mapping.name]));
  const remap = values => Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [nameMap.get(key) || key, value]));
  return {
    ...statistics,
    ...(statistics.nullCounts ? { nullCounts: remap(statistics.nullCounts) } : {}),
    ...(statistics.minimums ? { minimums: remap(statistics.minimums) } : {}),
    ...(statistics.maximums ? { maximums: remap(statistics.maximums) } : {}),
  };
}

function safeResultSetId(value, index, usedIds) {
  const base = String(value || `independent-result-${index + 1}`)
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 90) || `independent-result-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) id = `${base.slice(0, 94)}-${suffix++}`;
  usedIds.add(id);
  return id;
}

function normalizedQuality(quality = {}, scope = {}) {
  const isSample = quality.isSample ?? scope.isSample ?? null;
  const isTruncated = quality.isTruncated ?? scope.isTruncated ?? null;
  const isEstimated = quality.isEstimated ?? null;
  const declaredAccuracy = quality.accuracy ?? scope.accuracy;
  const accuracy = ['exact', 'sample', 'estimated', 'unknown'].includes(declaredAccuracy)
    ? declaredAccuracy
    : isSample ? 'sample' : isEstimated ? 'estimated' : 'unknown';
  return {
    accuracy,
    isSample: typeof isSample === 'boolean' ? isSample : null,
    isTruncated: typeof isTruncated === 'boolean' ? isTruncated : null,
    isEstimated: typeof isEstimated === 'boolean' ? isEstimated : null,
    warnings: [...new Set(Array.isArray(quality.warnings) ? quality.warnings.filter(item => typeof item === 'string') : [])].slice(0, 50),
  };
}

function normalizedResultSets(resultSets = []) {
  const usedIds = new Set();
  return resultSets.filter(resultSet => Array.isArray(resultSet?.rows) && resultSet.rows.length)
    .slice(0, MAX_RESULT_SETS)
    .map((resultSet, index) => {
      const sourceRows = resultSet.rows;
      const rows = sourceRows.slice(0, MAX_ROWS);
      const declaredSchema = Array.isArray(resultSet.schema) ? resultSet.schema : [];
      const sourceNames = (declaredSchema.length
        ? declaredSchema.map(field => field?.name).filter(Boolean)
        : [...new Set(rows.flatMap(row => Object.keys(row || {})))])
        .slice(0, 100);
      const usedNames = new Set();
      const mappings = sourceNames.map((sourceName, fieldIndex) => ({
        sourceName,
        field: declaredSchema[fieldIndex] || { name: sourceName },
        name: uniqueBusinessName(declaredSchema[fieldIndex], sourceName, usedNames),
      })).filter(mapping => mapping.name);
      const schema = mappings.map(mapping => normalizedField(mapping.field, rows, mapping.sourceName, mapping.name));
      const normalizedRows = rows.map(row => Object.fromEntries(
        mappings.map(mapping => [mapping.name, row?.[mapping.sourceName] ?? null]),
      ));
      const quality = normalizedQuality({
        ...(resultSet.quality || {}),
        isTruncated: Boolean(resultSet.quality?.isTruncated || sourceRows.length > rows.length),
      });
      return {
        id: safeResultSetId(resultSet.id, index, usedIds),
        schema,
        rows: normalizedRows,
        scope: resultSet.scope || { coverage: 'unknown' },
        quality,
        statistics: { ...normalizedStatistics(resultSet.statistics, mappings), sourceRowCount: sourceRows.length },
      };
    })
    .filter(resultSet => resultSet.schema.length && resultSet.rows.length);
}

export function adaptIndependentQueryResult({
  conversationId,
  turnId,
  traceId = null,
  question,
  conversation = {},
  response = {},
} = {}) {
  if (!conversationId || !turnId || response.status !== 'ok') return null;
  const resultSets = normalizedResultSets(response.resultSets || []);
  if (!resultSets.length) return null;
  const document = response.document || {};
  const datasets = (conversation.datasets || (conversation.dataset ? [conversation.dataset] : []))
    .filter(dataset => dataset?.id)
    .slice(0, 16)
    .map(dataset => ({ id: dataset.id, ...(dataset.name ? { name: dataset.name } : {}), ...(dataset.revision != null ? { revision: dataset.revision } : {}) }));
  const quality = normalizedQuality(document.scope || {}, document.scope || {});
  quality.warnings = [...new Set([
    ...quality.warnings,
    ...resultSets.flatMap(resultSet => resultSet.quality.warnings || []),
  ])].slice(0, 50);
  return {
    schema: INPUT_SCHEMA,
    title: String(question || document.title || '独立问数结果').trim().slice(0, 200),
    source: {
      type: 'independent-query',
      sourceId: `${conversationId}:${turnId}`,
      ...(traceId ? { traceId } : {}),
    },
    ...(datasets.length ? { datasets } : {}),
    context: {
      question: String(question || '').trim(),
      conversationId,
      turnId,
      ...(conversation.insightDocumentId ? { documentId: conversation.insightDocumentId } : {}),
      ...(response.analysisMethod?.id ? { analysisMethod: response.analysisMethod.id } : {}),
    },
    scope: document.scope || { coverage: 'unknown' },
    quality,
    evidence: Array.isArray(document.evidence) ? document.evidence.slice(0, 100) : [],
    resultSets,
  };
}

export class IndependentQueryInsightAdapter {
  constructor({ register } = {}) {
    if (typeof register !== 'function') throw new Error('IndependentQueryInsightAdapter 缺少 register');
    this.register = register;
  }

  registerTurn(input) {
    const insightInput = adaptIndependentQueryResult(input);
    return insightInput ? this.register(insightInput) : null;
  }
}
