import { createHash } from 'node:crypto';
import { compileWaxQuery } from '../../wax-query.mjs';
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
    modes: ['profile', 'aggregate', 'compare', 'verify'],
    maximumGroups: 8,
    maximumRows: 20000,
    serverAggregation: true,
  });

  canExecute(request, context) {
    return Boolean(context?.metadata?.indexed)
      && this.capabilities.modes.includes(request.mode)
      && request.select.length <= this.capabilities.maximumGroups;
  }

  estimate(request) {
    return { cost: request.select.length ? 2 : 1, expectedRows: request.limit, serverAggregation: true };
  }

  compile(request, context) {
    const hasTimeGrain = request.select.some(item => item.grain);
    const rowLimit = hasTimeGrain || request.resultFilters.length ? this.capabilities.maximumRows : request.limit;
    const compiled = compileWaxQuery(context.metadata, toLegacySpec(request, rowLimit));
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
      warnings: hasTimeGrain
        ? ['WAX 原始日期分组将在标准结果集阶段按请求时间粒度归并，并在归并后应用结果上限']
        : [],
    };
  }

  async execute(executionPlan, context) {
    const startedAt = Date.now();
    const raw = await context.executeDatasetQuery(context.request.dataset.id, {
      queryType: executionPlan.compiled.queryType,
      query: executionPlan.compiled.query,
      rowLimit: executionPlan.rowLimit,
    });
    let totalRows = null;
    if (raw.limitReached && executionPlan.compiled.countQuery) {
      const count = await context.executeDatasetQuery(context.request.dataset.id, { queryType: 'WAX', query: executionPlan.compiled.countQuery, rowLimit: 1 });
      const value = Number(count.rows?.[0]?.total_rows ?? count.rows?.[0]?.['[total_rows]']);
      if (Number.isFinite(value)) totalRows = value;
    }
    return { ...raw, totalRows, durationMs: Date.now() - startedAt, executedAt: new Date().toISOString() };
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
