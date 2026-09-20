import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWaxQuery } from '../lib/wax-query.mjs';
import { normalizeCanonicalQueryRequest } from '../lib/planning/query-request-schema.mjs';
import { normalizeCanonicalResultSet } from '../lib/query/result-normalizer.mjs';
import { createWynResultContract } from '../lib/query/result-contract.mjs';
import { PlatformDerivedCalculationGuard } from '../lib/query/platform-derived-calculation-guard.mjs';

const metadata = {
  id: 'boundary-dataset',
  revision: 1,
  name: '销售数据',
  indexed: true,
  fields: [
    { name: '类别名称', role: 'dimension', type: 'String' },
    { name: '订单金额', role: 'measure', type: 'Number' },
  ],
};

test('聚合后阈值筛选和完整计数均编译到 Wyn WAX', () => {
  const compiled = compileWaxQuery(metadata, {
    groupBy: ['类别名称'],
    measures: [{ alias: 'revenue', operation: 'sum', field: '订单金额' }],
    resultFilters: [{ field: 'revenue', operator: 'gt', value: 10000000 }],
    limit: 20000,
    orderBy: 'revenue',
    order: 'DESC',
  });
  assert.match(compiled.wax, /FILTER\(SUMMARIZECOLUMNS/);
  assert.match(compiled.wax, /\[revenue\] > 10000000/);
  assert.match(compiled.countWax, /COUNTROWS\(FILTER\(SUMMARIZECOLUMNS/);
});

test('结果规范化不再对 Wyn 返回的聚合结果本地补筛选或排序', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-boundary-normalizer',
    mode: 'aggregate',
    dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '类别名称', alias: 'category' }],
    measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
    resultFilters: [{ field: 'revenue', operator: 'gt', value: 100 }],
    orderBy: [{ field: 'revenue', direction: 'desc' }],
  });
  const result = normalizeCanonicalResultSet({
    request,
    executionPlan: { id: 'plan-boundary', adapter: 'wyn-wax-controlled', adapterVersion: 'test' },
    metadata,
    rawResult: {
      rows: [{ group1: 'A', revenue: 300 }, { group1: 'B', revenue: 50 }],
      totalRows: 2,
      isComplete: true,
    },
  });
  assert.deepEqual(result.rows.map(row => row.category), ['A', 'B']);
  assert.deepEqual(result.executionLedger[0].resultFilters, request.resultFilters);
  assert.equal(result.resultContract.isComplete, true);
});

test('派生 Guard 只接受完整 Wyn 聚合契约', () => {
  const request = { id: 'qry-derived-guard', mode: 'aggregate', limitSource: 'default' };
  const complete = createWynResultContract({
    request,
    rawResult: { totalRows: 2, isComplete: true },
    returnedRowCount: 2,
  });
  const guard = new PlatformDerivedCalculationGuard();
  const output = guard.execute({
    rows: [{ revenue: 100, profit: 20 }, { revenue: 200, profit: 50 }],
    contract: complete,
    step: {
      executionOwner: 'platform-derived',
      operationId: 'ratio',
      operationVersion: 1,
      inputAliases: ['profit', 'revenue'],
      outputAlias: 'margin',
      zeroDivision: 'null',
    },
  });
  assert.deepEqual(output.rows.map(row => row.margin), [0.2, 0.25]);
  assert.equal(output.ledgerEntry.operationId, 'ratio');
  assert.throws(() => guard.execute({
    rows: [{ revenue: 100, profit: 20 }],
    contract: createWynResultContract({
      request,
      rawResult: { totalRows: 2, isComplete: true, limitReached: true },
      returnedRowCount: 1,
    }),
    step: { executionOwner: 'platform-derived', operationId: 'ratio', operationVersion: 1, inputAliases: ['profit', 'revenue'], outputAlias: 'margin' },
  }), /完整性守卫阻断/);
});
