import { createHash } from 'node:crypto';
import { applyCanonicalFilters } from '../../planning/query-request-schema.mjs';
import { normalizeCanonicalResultSet } from '../result-normalizer.mjs';

function stableHash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export class DatasetNoneAdapter {
  id = 'wyn-dataset-none-json';
  version = 'canonical-v1';
  capabilities = Object.freeze({
    modes: ['detail', 'mining'],
    maximumRows: 20000,
    serverProjection: false,
    serverFiltering: false,
  });

  canExecute(request) {
    return this.capabilities.modes.includes(request.mode) && request.limit <= this.capabilities.maximumRows;
  }

  estimate(request) {
    return { cost: 3, expectedRows: request.limit, serverAggregation: false };
  }

  compile(request) {
    const warnings = [];
    if (request.filters.length) warnings.push('NONE JSON 不支持服务端过滤，当前结果标记为受控样本并在服务端执行类型化过滤');
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
    const filtered = applyCanonicalFilters(raw.rows, context.metadata, context.request.filters, context.request.fieldComparisons);
    const fields = context.request.select.map(item => item.field);
    const projected = filtered.map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
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
