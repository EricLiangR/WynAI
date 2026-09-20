import { createHash } from 'node:crypto';
import { compileWaxProjectionQuery, compileWaxQuery } from '../../wax-query.mjs';
import { normalizeCanonicalResultSet } from '../result-normalizer.mjs';

function stableHash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function toLegacySpec(request, rowLimit = request.limit) {
  const groupBy = request.select.map(item => item.field);
  const measures = request.measures.map(item => ({
    alias: item.alias,
    operation: item.aggregation,
    field: item.field,
  }));
  const requestedOrder = request.orderBy[0];
  let orderBy = measures[0]?.alias;
  if (requestedOrder) {
    const dimensionIndex = request.select.findIndex(item => item.alias === requestedOrder.field);
    orderBy = dimensionIndex >= 0 ? `group${dimensionIndex + 1}` : requestedOrder.field;
  } else if (groupBy.length && request.mode === 'compare') {
    orderBy = 'group1';
  }
  return {
    groupBy,
    measures,
    filters: request.filters,
    resultFilters: request.resultFilters,
    fieldComparisons: request.fieldComparisons,
    limit: rowLimit,
    orderBy,
    order: (requestedOrder?.direction || (request.mode === 'compare' ? 'asc' : 'desc')).toUpperCase(),
  };
}

export class ControlledWaxAdapter {
  id = 'wyn-wax-controlled';
  version = 'canonical-v1';
  capabilities = Object.freeze({
    modes: ['profile', 'aggregate', 'compare', 'verify', 'projection', 'mining'],
    maximumGroups: 8,
    maximumRows: 20000,
    serverAggregation: true,
  });

  canExecute(request, context) {
    const projection = ['projection', 'mining'].includes(request.mode);
    const unsupportedGrainMeasure = request.select.some(item => item.grain)
      && request.measures.some(item => ['average', 'distinctCount'].includes(item.aggregation));
    return Boolean(context?.metadata?.indexed)
      && this.capabilities.modes.includes(request.mode)
      && !unsupportedGrainMeasure
      && !request.select.some(item => item.grain)
      && (projection
        ? !request.measures.length && !request.resultFilters.length
          && request.select.length <= 64 && !request.select.some(item => item.grain)
        : request.select.length <= this.capabilities.maximumGroups);
  }

  estimate(request) {
    return { cost: request.select.length ? 2 : 1, expectedRows: request.limit, serverAggregation: true };
  }

  compile(request, context) {
    const projection = ['projection', 'mining'].includes(request.mode);
    const hasTimeGrain = request.select.some(item => item.grain);
    const rowLimit = hasTimeGrain || request.resultFilters.length ? this.capabilities.maximumRows : request.limit;
    const compiled = projection
      ? compileWaxProjectionQuery(context.metadata, request)
      : compileWaxQuery(context.metadata, toLegacySpec(request, rowLimit));
    return {
      id: `xp-${request.id}-${this.id}`,
      requestId: request.id,
      adapter: this.id,
      adapterVersion: this.version,
      fallbackAdapters: [],
      compiledPayloadHash: stableHash({ queryType: 'WAX', query: compiled.wax }),
      compiled: { queryType: 'WAX', query: compiled.wax, countQuery: compiled.countWax || null },
      timeoutMs: 90_000,
      rowLimit,
      cachePolicy: 'dataset-revision-and-query-fingerprint',
      permissionContext: 'server-identity-claims',
      status: 'ready',
      warnings: [],
    };
  }

  async execute(executionPlan, context) {
    const startedAt = Date.now();
    const request = context.request;
    const projection = ['projection', 'mining'].includes(request.mode);
    const userLimit = String(request.limitSource || '').startsWith('user-');
    const requiresFullGroups = request.resultFilters.length > 0 || request.select.some(item => item.grain);
    const readCount = async () => {
      const count = await context.executeDatasetQuery(request.dataset.id, {
        queryType: 'WAX', query: executionPlan.compiled.countQuery, rowLimit: 1,
      });
      const value = Number(count.rows?.[0]?.total_rows ?? count.rows?.[0]?.['[total_rows]']);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw Object.assign(new Error('Wyn 未返回可验证的完整结果行数'), { code: 'QUERY_RESULT_INCOMPLETE', status: 502 });
      }
      return value;
    };
    let totalRows = projection || requiresFullGroups ? await readCount() : null;
    if (projection && totalRows > this.capabilities.maximumRows && !userLimit) {
      throw Object.assign(new Error(`查询匹配 ${totalRows} 行，超过 20,000 行上限，请缩小筛选范围。`), {
        code: 'QUERY_RESULT_EXCEEDS_LIMIT', status: 422,
      });
    }
    if (projection && totalRows === 0) {
      return { rows: [], totalRows: 0, limitReached: false, filterLocation: 'wyn',
        isComplete: true, durationMs: Date.now() - startedAt, executedAt: new Date().toISOString() };
    }
    const raw = await context.executeDatasetQuery(context.request.dataset.id, {
      queryType: executionPlan.compiled.queryType,
      query: executionPlan.compiled.query,
      rowLimit: executionPlan.rowLimit,
    });
    const groupLimited = raw.limitReached && request.select.length > 0;
    if (!projection && groupLimited) {
      totalRows = await readCount();
    }
    const expectedRows = totalRows == null ? null : Math.min(totalRows, projection && userLimit ? request.limit : executionPlan.rowLimit);
    if (expectedRows != null && raw.rows.length !== expectedRows) {
      throw Object.assign(new Error('Wyn 返回行数与服务端完整计数不一致，已停止生成答案'), {
        code: 'QUERY_RESULT_INCOMPLETE', status: 502,
      });
    }
    if (!projection && totalRows != null && totalRows > this.capabilities.maximumRows && !userLimit) {
      throw Object.assign(new Error(`查询结果 ${totalRows} 行，超过 20,000 行上限，请缩小筛选范围。`), {
        code: 'QUERY_RESULT_EXCEEDS_LIMIT', status: 422,
      });
    }
    if (requiresFullGroups && totalRows != null && totalRows > raw.rows.length) {
      throw Object.assign(new Error('结果筛选或时间归并需要完整分组数据，当前查询超过可计算上限'), {
        code: 'QUERY_RESULT_INCOMPLETE', status: 422,
      });
    }
    return {
      ...raw,
      limitReached: false,
      totalRows,
      filterLocation: 'wyn',
      isComplete: true,
      durationMs: Date.now() - startedAt,
      executedAt: new Date().toISOString(),
    };
  }

  normalize(rawResult, executionPlan, context) {
    return normalizeCanonicalResultSet({
      request: context.request,
      executionPlan,
      rawResult,
      metadata: context.metadata,
    });
  }
}
