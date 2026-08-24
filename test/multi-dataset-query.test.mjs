import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiDatasetQueryService, combineCanonicalResultSets } from '../lib/query/multi-dataset.mjs';

const metadata = {
  id: 'dataset-sales-v1', name: '销售数据', revision: 1, indexed: true,
  fields: [
    { name: '日期', role: 'time', type: 'Date', rawType: 'DateTime', valueKind: 'temporal' },
    { name: '区域', role: 'dimension', type: 'String', valueKind: 'categorical' },
    { name: '销售额', role: 'measure', type: 'Number', rawType: 'Double', valueKind: 'continuous' },
  ],
};

test('多数据集查询服务逐个执行 Canonical 请求并记录缓存与预算', async () => {
  const calls = [];
  const service = new MultiDatasetQueryService({
    loadMetadata: async id => ({ ...metadata, id }),
    executeDatasetQuery: async (id, options) => {
      calls.push({ id, options });
      return { rows: [{ group1: '华东', sales: 100 }], truncated: false, limitReached: false };
    },
  });
  const request = { id: 'qry-sales', datasetId: 'dataset-sales-v1', mode: 'aggregate', select: [{ field: '区域', alias: 'region' }], measures: [{ field: '销售额', aggregation: 'sum', alias: 'sales' }], limit: 10 };
  const first = await service.execute({ requests: [request] });
  const second = await service.execute({ requests: [request] });
  assert.equal(first.resultSets[0].rows[0].sales, 100);
  assert.equal(second.audits[0].cache, 'hit');
  assert.equal(calls.length, 1);
});

test('多数据集结果只能按声明维度对齐合并并保留样本边界', () => {
  const merged = combineCanonicalResultSets({
    keyFields: ['period'],
    resultSets: [
      { id: 'rs-a', scope: { datasetId: 'dataset-a' }, schema: [{ name: 'period', role: 'dimension' }, { name: 'sales', role: 'measure' }], rows: [{ period: '2026-01', sales: 100 }], quality: { isSample: false, isTruncated: false, isEstimated: false, warnings: [] } },
      { id: 'rs-b', scope: { datasetId: 'dataset-b' }, schema: [{ name: 'period', role: 'dimension' }, { name: 'target', role: 'measure' }], rows: [{ period: '2026-01', target: 120 }], quality: { isSample: true, isTruncated: false, isEstimated: false, warnings: [] } },
    ],
  });
  assert.equal(merged.rows[0].period, '2026-01');
  assert.equal(merged.rows[0]['dataset-a__sales'], 100);
  assert.equal(merged.rows[0]['dataset-b__target'], 120);
  assert.equal(merged.quality.isSample, true);
  assert.match(merged.quality.warnings.join(' '), /明细级 Join/);
});
