import { createHash } from 'node:crypto';
import { normalizeCanonicalResultSet } from '../result-normalizer.mjs';

function stableHash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export class DatasetNoneAdapter {
  id = 'wyn-dataset-none-json';
  version = 'canonical-v1';
  capabilities = Object.freeze({
    modes: ['mining'],
    maximumRows: 20000,
    serverProjection: false,
    serverFiltering: false,
  });

  canExecute(request) {
    return request.mode === 'mining'
      && !request.filters.length
      && !request.fieldComparisons.length
      && !request.resultFilters.length
      && !request.measures.length
      && request.limit <= this.capabilities.maximumRows;
  }

  estimate(request) {
    return { cost: 1, expectedRows: request.limit, serverAggregation: false };
  }

  compile(request) {
    if (!this.canExecute(request)) throw new Error('NONE 样本不能执行带筛选条件的业务查询');
    const warnings = [];
    if (request.select.length) warnings.push('NONE JSON 不支持服务端列裁剪，响应后仅保留查询需求声明的字段');
    return {
      id: `xp-${request.id}-${this.id}`,
      requestId: request.id,
      adapter: this.id,
      adapterVersion: this.version,
      fallbackAdapters: [],
      compiledPayloadHash: stableHash({ queryType: 'NONE', query: '' }),
      compiled: { queryType: 'NONE', query: '' },
      timeoutMs: 90_000,
      rowLimit: request.limit,
      cachePolicy: 'no-shared-detail-cache',
      permissionContext: 'server-identity-claims',
      status: 'ready',
      warnings,
    };
  }

  async execute(executionPlan, context) {
    const startedAt = Date.now();
    const raw = await context.executeDatasetQuery(context.request.dataset.id, {
      queryType: executionPlan.compiled.queryType,
      query: executionPlan.compiled.query,
      rowLimit: executionPlan.rowLimit,
    });
    const fields = context.request.select.map(item => item.field);
    const projected = raw.rows.map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
    return {
      ...raw,
      rows: projected,
      sourceRowCount: raw.rows.length,
      isSample: true,
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
