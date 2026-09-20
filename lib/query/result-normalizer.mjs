import { toDate, toNumber } from '../analysis-core.mjs';
import { decorateQueryField } from '../../field-display-labels.mjs';
import { createWynResultContract } from './result-contract.mjs';

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
      const role = item.role === 'measure' ? 'measure' : 'dimension';
      return { name: item.alias, ...decorateQueryField({ item, metadata, role }), type: fieldType(field), role, grain: item.grain || null };
    }),
    ...request.measures.map(item => ({
      name: item.alias,
      ...decorateQueryField({ item, metadata, role: 'measure' }),
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
  const rows = normalizeRows(rawResult?.rows, request, schema);
  const totalRows = rawResult?.totalRows ?? (rawResult?.isComplete === true ? rows.length : null);
  const userLimitApplied = String(request.limitSource || '').startsWith('user-');
  const sourceLimitReached = Boolean(rawResult?.truncated || rawResult?.limitReached);
  if (request.select.some(item => item.grain)) {
    throw Object.assign(new Error('当前 Wyn 适配器尚未确认时间粒度的服务端表达，平台不会在返回明细后本地归并。'), {
      code: 'QUERY_CAPABILITY_UNAVAILABLE',
      status: 422,
      details: { operation: 'time-grain', executionOwner: 'wyn' },
    });
  }
  if (!userLimitApplied && (rows.length > 20000 || (totalRows != null && totalRows > 20000))) {
    throw Object.assign(new Error('Wyn 返回结果超过 20,000 行上限，平台不会截取部分数据继续计算。'), {
      code: 'QUERY_RESULT_EXCEEDS_LIMIT',
      status: 422,
      details: { returnedRowCount: rows.length, totalRowCount: totalRows, maximumRows: 20000 },
    });
  }
  const limited = !userLimitApplied && (totalRows != null ? totalRows > rows.length : sourceLimitReached);
  const resultContract = createWynResultContract({
    request,
    rawResult: { ...rawResult, totalRows, isComplete: rawResult?.isComplete === true && !limited },
    returnedRowCount: rows.length,
  });
  const executionLedger = [{
    operationId: 'wyn-query',
    operationVersion: 1,
    executionOwner: 'wyn',
    inputContract: 'canonical-query-request/v1',
    outputContract: resultContract.type,
    changesBusinessScope: true,
    requiresCompleteAggregate: false,
    requestId: request.id,
    filters: request.filters,
    resultFilters: request.resultFilters,
    groupBy: request.select.map(item => item.alias),
    aggregations: request.measures.map(item => ({ alias: item.alias, aggregation: item.aggregation })),
    orderBy: request.orderBy,
    limit: request.limit,
    totalRowCount: resultContract.totalRowCount,
    returnedRowCount: resultContract.returnedRowCount,
    status: resultContract.isComplete ? 'executed-complete' : 'executed-limited',
  }];
  return {
    id: `rs-${request.id}`,
    requestId: request.id,
    executionPlanId: executionPlan.id,
    schema,
    rows,
    statistics: { ...resultStatistics(rows, schema), totalRowCount: totalRows, returnedRowCount: rows.length },
    scope: {
      datasetId: request.dataset.id,
      datasetRevision: request.dataset.revision,
      filters: request.filters,
      resultFilters: request.resultFilters,
      fieldComparisons: request.fieldComparisons,
      timeRange: rawResult?.timeRange || null,
      aggregationLevel: request.select.map(item => item.alias),
      timeZone: request.expectedResult?.timeZone || 'Asia/Shanghai',
      sourceFiltering: rawResult?.filterLocation || (request.filters.length || request.fieldComparisons.length ? 'unknown' : 'none'),
      sourceTotalRowCount: rawResult?.totalRows ?? null,
    },
    provenance: {
      adapter: executionPlan.adapter,
      adapterVersion: executionPlan.adapterVersion,
      executedAt: rawResult?.executedAt || new Date().toISOString(),
      durationMs: rawResult?.durationMs ?? null,
    },
    resultContract,
    executionLedger,
    quality: {
      isSample: Boolean(rawResult?.isSample),
      isComplete: resultContract.isComplete,
      isTruncated: limited,
      limitReached: limited,
      limitSource: userLimitApplied ? (request.limitSource || 'user-limit') : limited ? 'system-cap' : 'none',
      userLimitApplied,
      sourceLimitReached,
      truncationConfidence: limited ? (rawResult?.truncationConfidence || (rawResult?.truncated ? 'confirmed' : 'possible')) : 'none',
      isEstimated: Boolean(rawResult?.isEstimated),
      totalRowCount: totalRows,
      returnedRowCount: rows.length,
      warnings: [
        ...(executionPlan.warnings || []),
        ...(rawResult?.warnings || []),
        ...(limited ? [totalRows != null
          ? `查询结果总数据 ${totalRows} 行，实际返回 ${rows.length} 行，已达到结果上限。`
          : `已返回 ${rows.length} 行，底层总行数未知，结果完整性无法确认。`] : []),
      ],
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
