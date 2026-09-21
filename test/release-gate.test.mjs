import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReleaseCase, normalizeReleaseGatePack, summarizeReleaseGate } from '../lib/evaluation/release-gate.mjs';

const baseCase = {
  id: 'AY-033',
  question: '按产品大类统计财年26的总商机金额，并筛选总金额大于1000万',
  expected: {
    status: 'ok',
    metrics: ['Opportunity_amount_CNY'],
    filters: [{ field: '赢单财年', operator: 'eq', value: '26' }],
    forbiddenFilters: [{ field: '赢单日期', operator: 'gte' }],
    postAggregateFilters: [{ field: 'revenue', operator: 'gt', value: 10000000 }],
    rows: 2,
    adapter: 'wyn-wax-controlled',
    values: [{ field: 'revenue', value: 1897687040 }],
  },
};

function passingActual() {
  return {
    status: 'ok', traceId: 'trace-1', adapter: 'wyn-wax-controlled', fallback: false,
    canonical: {
      metrics: [{ field: 'Opportunity_amount_CNY' }],
      filters: [{ field: '赢单财年', operator: 'eq', value: '26' }],
      postAggregateFilters: [{ field: 'revenue', operator: 'gt', value: 10000000 }],
    },
    rows: [
      { product: 'Digital Technology', revenue: 1897687040 },
      { product: 'Manufacturing', revenue: 66184542.28 },
    ],
    resultContract: {
      returnedRowCount: 2, totalRowCount: 2, isSample: false,
      isTruncated: false, isEstimated: false, limitReached: false,
    },
  };
}

test('发布门禁验证 Wyn 筛选、聚合后条件、来源、Trace、完整性和关键值', () => {
  const result = evaluateReleaseCase(baseCase, passingActual());
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter(item => !item.passed)));
});

test('发布门禁拒绝重复日期范围和截断结果', () => {
  const actual = passingActual();
  actual.canonical.filters.push({ field: '赢单日期', operator: 'gte', value: '2025-06-01' });
  actual.resultContract.isTruncated = true;
  const result = evaluateReleaseCase(baseCase, actual);
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(item => item.name === 'forbiddenFilters').passed, false);
  assert.equal(result.checks.find(item => item.name === 'isTruncated').passed, false);
});

test('发布门禁按业务概念解析模型生成的动态结果别名', () => {
  const actual = passingActual();
  actual.rows = [{ product: 'Digital Technology', revenue_cny: 1897687040 }, { product: 'Manufacturing', revenue_cny: 66184542.28 }];
  actual.valueAliases = { revenue: ['revenue_cny'] };
  assert.equal(evaluateReleaseCase(baseCase, actual).passed, true);
});

test('发布门禁按统一业务日期解析排他日期上界', () => {
  const testCase = {
    id: 'AY-003', question: '截止目前',
    expected: { status: 'ok', filters: [{ field: '赢单日期', operator: 'lt', value: { $relativeDate: 'businessDate', offsetDays: 1 } }] },
  };
  const actual = { status: 'ok', traceId: 'trace-date', fallback: false, rows: [{ value: 1 }], canonical: {
    filters: [{ field: '赢单日期', operator: 'lt', value: '2026-09-22' }],
  }, resultContract: { returnedRowCount: 1, totalRowCount: 1, isSample: false, isTruncated: false, isEstimated: false, limitReached: false } };
  assert.equal(evaluateReleaseCase(testCase, actual, { currentDate: '2026-09-21' }).passed, true);
});

test('发布门禁允许显式声明的完整零结果', () => {
  const testCase = { id: 'AY-034', question: '零结果', expected: { status: 'ok', rows: 0, allowZeroRows: true } };
  const actual = {
    status: 'ok', traceId: 'trace-0', fallback: false, rows: [],
    resultContract: { returnedRowCount: 0, totalRowCount: 0, isSample: false, isTruncated: false, isEstimated: false, limitReached: false },
  };
  assert.equal(evaluateReleaseCase(testCase, actual).passed, true);
});

test('发布门禁允许能力不可用澄清且不要求查询 Trace', () => {
  const testCase = { id: 'SEM-004', question: '不存在字段', expected: { status: 'needs_clarification', clarification: true } };
  assert.equal(evaluateReleaseCase(testCase, { status: 'needs_clarification', fallback: false, rows: [] }).passed, true);
});

test('发布门禁包要求用例 ID 唯一并保留截图策略', () => {
  const pack = normalizeReleaseGatePack({ id: 'sales-ay-release', datasetId: 'dataset-1', cases: [{ id: 'A', question: 'q', screenshot: 'overview-only' }] });
  assert.equal(pack.cases[0].screenshot, 'overview-only');
  assert.throws(() => normalizeReleaseGatePack({
    id: 'sales-ay-release', datasetId: 'dataset-1',
    cases: [{ id: 'A', question: 'q1' }, { id: 'A', question: 'q2' }],
  }), /ID 必须唯一/);
});

test('发布门禁汇总把缺失执行用例判为失败', () => {
  const pack = { id: 'sales-ay-release', datasetId: 'dataset-1', cases: [{ id: 'A', question: 'q' }, { id: 'B', question: 'q' }] };
  const result = summarizeReleaseGate(pack, [{ id: 'A', passed: true, checks: [] }]);
  assert.deepEqual(
    { total: result.total, passed: result.passed, failed: result.failed, releaseReady: result.releaseReady },
    { total: 2, passed: 1, failed: 1, releaseReady: false },
  );
});
