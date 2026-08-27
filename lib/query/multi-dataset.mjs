import { createHash } from 'node:crypto';
import { normalizeCanonicalQueryRequest } from '../planning/query-request-schema.mjs';
import { QueryRouter } from './router.mjs';
import { ControlledWaxAdapter } from './adapters/controlled-wax.mjs';
import { DatasetNoneAdapter } from './adapters/dataset-none.mjs';

function fingerprint(value) {
  return `qf-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function safeDatasetId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw Object.assign(new Error(`无效的数据集 ID：${id}`), { status: 400 });
  return id;
}

function mergeRows(resultSets, keyFields = []) {
  const keys = keyFields.length ? keyFields : resultSets.flatMap(set => set.schema.filter(column => column.role === 'dimension').map(column => column.name)).slice(0, 2);
  const groups = new Map();
  for (const resultSet of resultSets) {
    for (const row of resultSet.rows || []) {
      const key = JSON.stringify(keys.map(field => row[field] ?? null));
      const current = groups.get(key) || Object.fromEntries(keys.map(field => [field, row[field] ?? null]));
      for (const column of resultSet.schema || []) {
        if (keys.includes(column.name)) continue;
        const outputName = `${resultSet.scope?.datasetId || resultSet.requestId}__${column.name}`;
        current[outputName] = row[column.name] ?? null;
      }
      groups.set(key, current);
    }
  }
  return [...groups.values()];
}

export function combineCanonicalResultSets({ resultSets, keyFields = [], mode = 'aligned-merge' } = {}) {
  if (!Array.isArray(resultSets) || resultSets.length < 2) throw Object.assign(new Error('至少需要两个结果集才能合并'), { status: 400 });
  if (mode !== 'aligned-merge') throw Object.assign(new Error(`不支持的跨数据集合并模式：${mode}`), { status: 400 });
  const datasets = [...new Set(resultSets.map(item => item.scope?.datasetId || item.datasetId || item.requestId))];
  const rows = mergeRows(resultSets, keyFields);
  return {
    id: `rs-merged-${fingerprint({ datasets, keyFields }).slice(3)}`,
    requestId: null,
    schema: rows.length ? Object.keys(rows[0]).map(name => ({ name, sourceField: name, type: 'unknown', role: keyFields.includes(name) ? 'dimension' : 'measure' })) : [],
    rows,
    statistics: { rowCount: rows.length, sourceResultSetCount: resultSets.length },
    scope: { datasetIds: datasets, aggregationLevel: keyFields, mergeMode: mode },
    provenance: { adapter: 'wynai-result-merge/v1', sourceResultSetIds: resultSets.map(item => item.id), executedAt: new Date().toISOString() },
    quality: {
      isSample: resultSets.some(item => item.quality?.isSample),
      isTruncated: resultSets.some(item => item.quality?.isTruncated || item.quality?.limitReached),
      isEstimated: resultSets.some(item => item.quality?.isEstimated),
      warnings: [...new Set(resultSets.flatMap(item => item.quality?.warnings || [])), '跨数据集结果按声明维度对齐合并，未执行明细级 Join'],
    },
  };
}

export class MultiDatasetQueryService {
  constructor({ loadMetadata, executeDatasetQuery, adapters = [new ControlledWaxAdapter(), new DatasetNoneAdapter()], maxRequests = 12, maxDatasets = 8, cacheSize = 100 } = {}) {
    this.loadMetadata = loadMetadata;
    this.executeDatasetQuery = executeDatasetQuery;
    this.router = new QueryRouter(adapters);
    this.maxRequests = maxRequests;
    this.maxDatasets = maxDatasets;
    this.cacheSize = cacheSize;
    this.cache = new Map();
  }

  trimCache() {
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
  }

  async execute({ requests = [], merge = null, budget = {} } = {}) {
    if (!Array.isArray(requests) || !requests.length) throw Object.assign(new Error('至少需要一个查询请求'), { status: 400 });
    const maxRequests = Math.max(1, Math.min(this.maxRequests, Number(budget.maxRequests) || this.maxRequests));
    if (requests.length > maxRequests) throw Object.assign(new Error(`查询请求最多 ${maxRequests} 个`), { status: 400 });
    const datasetIds = [...new Set(requests.map(item => safeDatasetId(item?.dataset?.id || item?.datasetId)))];
    if (datasetIds.length > this.maxDatasets) throw Object.assign(new Error(`数据集最多 ${this.maxDatasets} 个`), { status: 400 });
    const maxRows = Math.max(1, Math.min(20000, Number(budget.maxRows) || 20000));
    const maxCost = Math.max(1, Math.min(maxRequests * 3, Number(budget.maxCost) || maxRequests * 3));
    const spent = { requests: 0, estimatedCost: 0 };
    const results = [];
    const audits = [];
    for (const input of requests) {
      if (++spent.requests > maxRequests) throw Object.assign(new Error('查询预算已用尽'), { status: 429 });
      const datasetId = safeDatasetId(input.dataset?.id || input.datasetId);
      const metadata = await this.loadMetadata(datasetId);
      const request = normalizeCanonicalQueryRequest(metadata, { ...input, dataset: { id: datasetId, revision: input.dataset?.revision ?? metadata.revision }, limit: Math.min(Number(input.limit) || 100, maxRows) });
      const key = fingerprint({ metadataRevision: metadata.revision, request });
      const cached = this.cache.get(key);
      if (cached) {
        results.push(cached.resultSet);
        audits.push({ requestId: request.id, datasetId, cache: 'hit', adapter: cached.executionPlan.adapter, estimatedCost: 0 });
        continue;
      }
      const candidates = this.router.route(request, { metadata, request });
      const estimatedCost = candidates[0]?.estimate?.cost || 1;
      spent.estimatedCost += estimatedCost;
      if (spent.estimatedCost > maxCost) throw Object.assign(new Error(`查询预算超出：需要 ${spent.estimatedCost}，上限 ${maxCost}`), { status: 429 });
      const execution = await this.router.execute(request, { metadata, executeDatasetQuery: this.executeDatasetQuery });
      this.cache.set(key, { resultSet: execution.resultSet, executionPlan: execution.executionPlan, createdAt: new Date().toISOString() });
      this.trimCache();
      results.push(execution.resultSet);
      audits.push({ requestId: request.id, datasetId, cache: 'miss', adapter: execution.executionPlan.adapter, estimatedCost });
    }
    const merged = merge ? combineCanonicalResultSets({ resultSets: results, keyFields: merge.keyFields || [], mode: merge.mode || 'aligned-merge' }) : null;
    return { schema: 'wynai.multi-dataset-query-result/v1', requests: requests.length, datasets: datasetIds, resultSets: results, merged, budget: { ...spent, maxRequests, maxCost }, audits };
  }
}
