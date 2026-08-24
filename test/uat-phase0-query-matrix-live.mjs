import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const datasetId = process.env.PHASE0_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8';
const cases = [];

async function query(request) {
  const response = await fetch(`${baseUrl}/api/smart-query/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ ...request, datasetId }] }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${payload.message || 'query failed'}`);
  return payload.resultSets[0];
}

async function runCase(id, title, request, verify) {
  try {
    const result = await query(request);
    verify(result);
    cases.push({ id, title, status: 'passed', evidence: { rows: result.statistics.rowCount, schema: result.schema, quality: result.quality, scope: result.scope } });
    console.log(`PASS ${id} ${title}`);
  } catch (error) {
    cases.push({ id, title, status: 'failed', error: error.message });
    console.error(`FAIL ${id} ${title}: ${error.message}`);
    process.exitCode = 1;
  }
}

await runCase('UAT-P0-Q-01', '月度时间粒度', {
  id: 'qry-p0-monthly', mode: 'compare', select: [{ field: '订购日期', alias: 'period', grain: 'month' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], orderBy: [{ field: 'period', direction: 'asc' }], limit: 100,
}, result => {
  assert.ok(result.rows.length > 1);
  assert.ok(result.rows.every(row => /^\d{4}-\d{2}-01T/.test(row.period)));
  assert.equal(result.quality.isTruncated, false);
});

await runCase('UAT-P0-Q-02', '季度时间粒度', {
  id: 'qry-p0-quarterly', mode: 'compare', select: [{ field: '订购日期', alias: 'period', grain: 'quarter' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], orderBy: [{ field: 'period', direction: 'asc' }], limit: 100,
}, result => {
  assert.ok(result.rows.length > 1);
  assert.ok(result.rows.every(row => /^\d{4}-(01|04|07|10)-01T/.test(row.period)));
});

await runCase('UAT-P0-Q-03', '年度时间粒度', {
  id: 'qry-p0-yearly', mode: 'compare', select: [{ field: '订购日期', alias: 'period', grain: 'year' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], orderBy: [{ field: 'period', direction: 'asc' }], limit: 100,
}, result => {
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every(row => /^\d{4}-01-01T/.test(row.period)));
});

await runCase('UAT-P0-Q-04', '区域降序排序', {
  id: 'qry-p0-region-sort', mode: 'aggregate', select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], orderBy: [{ field: 'revenue', direction: 'desc' }], limit: 20,
}, result => {
  assert.ok(result.rows.length > 1);
  const values = result.rows.map(row => Number(row.revenue));
  assert.ok(values.every((value, index) => index === 0 || value <= values[index - 1]));
});

await runCase('UAT-P0-Q-05', '类别聚合', {
  id: 'qry-p0-category', mode: 'aggregate', select: [{ field: '类别名称', alias: 'category' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], orderBy: [{ field: 'revenue', direction: 'desc' }], limit: 20,
}, result => {
  assert.ok(result.rows.length > 1);
  assert.ok(result.rows.every(row => row.category != null && Number.isFinite(Number(row.revenue))));
});

await runCase('UAT-P0-Q-06', '数值字段比较', {
  id: 'qry-p0-field-comparison', mode: 'aggregate', select: [], measures: [{ aggregation: 'countRows', alias: 'records' }], fieldComparisons: [{ left: '订单金额', operator: 'gt', right: '订单利润' }], limit: 1,
}, result => {
  assert.equal(result.rows.length, 1);
  assert.ok(Number(result.rows[0].records) >= 0);
  assert.equal(result.scope.fieldComparisons[0].valueType, 'number');
});

const filterCases = [
  ['string-eq', [{ field: '客户地区', operator: 'eq', value: '华东' }]],
  ['number-gt', [{ field: '购买数量', operator: 'gt', value: 5 }]],
  ['date-gte', [{ field: '订购日期', operator: 'gte', value: '2024-01-01' }]],
  ['set-in', [{ field: '客户地区', operator: 'in', value: ['华东', '华北'] }]],
  ['not-null', [{ field: '订单金额', operator: 'isNotNull' }]],
];
for (const [name, filters] of filterCases) {
  await runCase(`UAT-P0-Q-${name}`, `${name} 过滤`, {
    id: `qry-p0-filter-${name}`, mode: 'aggregate', select: [], measures: [{ aggregation: 'countRows', alias: 'records' }], filters, limit: 1,
  }, result => {
    assert.equal(result.rows.length, 1);
    assert.ok(Number(result.rows[0].records) >= 0);
  });
}

const artifact = {
  schema: 'wynai.uat-result/v1', phase: 'phase-0-query-matrix', datasetId,
  status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
  summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length },
  cases,
  knownLimitations: ['Wyn 没有返回确定性截断标志，因此达到 RowLimit 只标记为 limitReached/possible。', '分页和 Arrow 尚未纳入第一阶段执行路径。'],
};
const directory = join('test', 'uat-artifacts', 'phase0');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'query-matrix-latest.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`PHASE 0 QUERY MATRIX ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`);
if (process.exitCode) process.exit(process.exitCode);
