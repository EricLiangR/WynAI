import test from 'node:test';
import assert from 'node:assert/strict';

import { QueryRouter } from '../lib/query/router.mjs';
import { ControlledWaxAdapter } from '../lib/query/adapters/controlled-wax.mjs';
import { DatasetNoneAdapter } from '../lib/query/adapters/dataset-none.mjs';

const metadata = {
  id: 'generic-indexed-dataset',
  name: 'Generic Dataset',
  revision: 1,
  indexed: true,
  fields: [
    { name: 'project', role: 'dimension', type: 'String' },
    { name: 'customer_type', role: 'dimension', type: 'String' },
    { name: 'fiscal_year', role: 'dimension', type: 'String' },
    { name: 'amount', role: 'measure', type: 'Number' },
    { name: 'occurred_at', role: 'time', type: 'Date' },
  ],
};

const router = new QueryRouter([new ControlledWaxAdapter(), new DatasetNoneAdapter()]);
const detail = {
  id: 'qry-filtered-records',
  mode: 'projection',
  purpose: 'filtered records',
  dataset: { id: metadata.id },
  select: [{ field: 'project', alias: 'project_name' }, { field: 'amount', alias: 'amount' }],
  measures: [],
  filters: [
    { field: 'customer_type', operator: 'containsAny', value: ['POE'] },
    { field: 'fiscal_year', operator: 'eq', value: '26' },
  ],
};

test('server filters before projection and result cap, retaining all matching raw rows', async () => {
  const calls = [];
  const matching = Array.from({ length: 7 }, (_, index) => ({
    project_name: index < 4 ? 'Project A' : 'Project B',
    amount: index + 1,
  }));
  const execution = await router.execute(detail, {
    metadata,
    executeDatasetQuery: async (_id, options) => {
      calls.push(options);
      return options.rowLimit === 1 ? { rows: [{ total_rows: 7 }] } : { rows: matching };
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.queryType === 'WAX'));
  assert.match(calls[0].query, /COUNTROWS\(FILTER\(/);
  assert.match(calls[1].query, /SELECTCOLUMNS\(FILTER\(/);
  assert.match(calls[1].query, /FIND\("POE"/);
  assert.equal(calls[1].rowLimit, 20000);
  assert.equal(execution.resultSet.rows.length, 7);
  assert.deepEqual([...new Set(execution.resultSet.rows.map(row => row.project_name))], ['Project A', 'Project B']);
  assert.equal(execution.resultSet.quality.isComplete, true);
  assert.equal(execution.resultSet.scope.sourceFiltering, 'wyn');
});

test('over-cap filtered detail refuses before fetching any partial records', async () => {
  const calls = [];
  await assert.rejects(router.execute(detail, {
    metadata,
    executeDatasetQuery: async (_id, options) => {
      calls.push(options);
      return { rows: [{ total_rows: 20001 }] };
    },
  }), error => error.code === 'QUERY_RESULT_EXCEEDS_LIMIT' && error.status === 422);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].queryType, 'WAX');
});

test('a zero-row answer needs an exact server count and never samples NONE', async () => {
  const calls = [];
  const execution = await router.execute(detail, {
    metadata,
    executeDatasetQuery: async (_id, options) => {
      calls.push(options);
      return { rows: [{ total_rows: 0 }] };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(execution.resultSet.rows, []);
  assert.equal(execution.resultSet.statistics.totalRowCount, 0);
  assert.equal(execution.resultSet.quality.isComplete, true);
});

test('an explicit top N detail request compares returned rows against N, not the full match count', async () => {
  const calls = [];
  const execution = await router.execute({
    ...detail,
    id: 'qry-top-three-records',
    limit: 3,
    limitSource: 'user-limit',
    orderBy: [{ field: 'amount', direction: 'desc' }],
  }, {
    metadata,
    executeDatasetQuery: async (_id, options) => {
      calls.push(options);
      return options.rowLimit === 1
        ? { rows: [{ total_rows: 7 }] }
        : { rows: [7, 6, 5].map(amount => ({ project_name: 'Project A', amount })) };
    },
  });
  assert.match(calls[1].query, /TOPN\(3,/);
  assert.equal(execution.resultSet.rows.length, 3);
  assert.equal(execution.resultSet.statistics.totalRowCount, 7);
  assert.equal(execution.resultSet.quality.isComplete, true);
  assert.equal(execution.resultSet.quality.userLimitApplied, true);
});

test('server count and projected rows must agree before an answer is accepted', async () => {
  await assert.rejects(router.execute(detail, {
    metadata,
    executeDatasetQuery: async (_id, options) => options.rowLimit === 1
      ? { rows: [{ total_rows: 7 }] }
      : { rows: [{ project_name: 'Project A', amount: 1 }, { project_name: 'Project B', amount: 2 }] },
  }), error => error.code === 'QUERY_RESULT_INCOMPLETE');
});

test('post-aggregation filtering cannot use the first 20,000 of more than 20,000 groups', async () => {
  const request = {
    id: 'qry-filtered-groups',
    mode: 'aggregate',
    dataset: { id: metadata.id },
    select: [{ field: 'project', alias: 'project_name' }],
    measures: [{ field: 'amount', alias: 'revenue', aggregation: 'sum' }],
    resultFilters: [{ field: 'revenue', operator: 'gt', value: 100 }],
  };
  await assert.rejects(router.execute(request, {
    metadata,
    executeDatasetQuery: async (_id, options) => options.rowLimit === 1
      ? { rows: [{ total_rows: 20001 }] }
      : { rows: Array.from({ length: 20000 }, (_, index) => ({ group1: String(index), revenue: index })),
        limitReached: true },
  }), error => ['QUERY_RESULT_EXCEEDS_LIMIT', 'QUERY_RESULT_INCOMPLETE'].includes(error.code));
});

test('exactly 20,000 source groups can produce a smaller complete post-filter result', async () => {
  const request = {
    id: 'qry-exact-cap-groups',
    mode: 'aggregate',
    dataset: { id: metadata.id },
    select: [{ field: 'project', alias: 'project_name' }],
    measures: [{ field: 'amount', alias: 'revenue', aggregation: 'sum' }],
    resultFilters: [{ field: 'revenue', operator: 'gt', value: 19997 }],
  };
  const execution = await router.execute(request, {
    metadata,
    executeDatasetQuery: async (_id, options) => options.rowLimit === 1
      ? { rows: [{ total_rows: 2 }] }
      : { rows: [{ group1: '19998', revenue: 19998 }, { group1: '19999', revenue: 19999 }],
        limitReached: false },
  });
  assert.equal(execution.resultSet.rows.length, 2);
  assert.equal(execution.resultSet.statistics.totalRowCount, 2);
  assert.equal(execution.resultSet.scope.sourceTotalRowCount, 2);
  assert.equal(execution.resultSet.quality.isComplete, true);
});

test('non-additive averages across a time grain must fail rather than approximate', async () => {
  await assert.rejects(router.execute({
    id: 'qry-monthly-average',
    mode: 'aggregate',
    dataset: { id: metadata.id },
    select: [{ field: 'occurred_at', alias: 'month', grain: 'month' }],
    measures: [{ field: 'amount', alias: 'average_amount', aggregation: 'average' }],
  }, {
    metadata,
    executeDatasetQuery: async () => { throw new Error('should not query'); },
  }), /没有适配器/);
});

test('filtered non-indexed data cannot fall back to NONE and fabricate completeness', async () => {
  await assert.rejects(router.execute(detail, {
    metadata: { ...metadata, indexed: false },
    executeDatasetQuery: async () => { throw new Error('should not query'); },
  }), /没有适配器/);
});
