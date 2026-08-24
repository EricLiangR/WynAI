import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const datasets = {
  sales: process.env.PHASE0_SALES_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8',
  laboratory: process.env.PHASE0_LAB_DATASET_ID || 'ebbbbf49-60dd-4761-9722-fa6543eac4a9',
  retail: process.env.PHASE0_RETAIL_DATASET_ID || '8875ab24-8d24-4a9e-be39-01e44a5678a9',
};
const cases = [];

async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} 返回 ${response.status}: ${payload.message || '请求失败'}`);
  return payload;
}

async function query(datasetId, requestBody) {
  const payload = await request('/api/smart-query/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ ...requestBody, datasetId }] }),
  });
  assert.equal(payload.schema, 'wynai.multi-dataset-query-result/v1');
  assert.equal(payload.resultSets.length, 1);
  return payload.resultSets[0];
}

async function runCase(id, title, action) {
  const startedAt = Date.now();
  try {
    const evidence = await action();
    cases.push({ id, title, status: 'passed', durationMs: Date.now() - startedAt, evidence });
    console.log(`PASS ${id} ${title}`);
  } catch (error) {
    cases.push({ id, title, status: 'failed', durationMs: Date.now() - startedAt, error: error.message });
    console.error(`FAIL ${id} ${title}: ${error.message}`);
    process.exitCode = 1;
  }
}

const metadataByDataset = {};

await runCase('UAT-P0-MD-01', '三个真实数据集元数据读取与索引状态', async () => {
  const catalog = await request('/api/datasets');
  const summaries = [];
  for (const [key, id] of Object.entries(datasets)) {
    assert.ok(catalog.datasets.some(item => item.id === id), `${key} 数据集不在目录中`);
    const metadata = await request(`/api/datasets/${id}/metadata`);
    metadataByDataset[key] = metadata;
    assert.equal(metadata.id, id);
    assert.ok(metadata.fieldCount > 0);
    assert.ok(metadata.roles.measure.length > 0);
    assert.equal(typeof metadata.indexed, 'boolean');
    summaries.push({ key, id, name: metadata.name, revision: metadata.revision, indexed: metadata.indexed, fieldCount: metadata.fieldCount, describedFieldCount: metadata.assistant?.describedFieldCount ?? 0, synonymCount: metadata.assistant?.synonymCount ?? 0 });
  }
  return { catalogCount: catalog.total, datasets: summaries };
});

await runCase('UAT-P0-MD-02', '实验室数据集科室总 TAT 聚合', async () => {
  const result = await query(datasets.laboratory, {
    id: 'uat-p0-lab-tat', mode: 'aggregate', purpose: '按科室查看总 TAT 平均值和记录数',
    select: [{ field: '科室名称', alias: 'department' }],
    measures: [{ field: '总TAT', aggregation: 'average', alias: 'avg_tat' }, { aggregation: 'countRows', alias: 'records' }],
    orderBy: [{ field: 'avg_tat', direction: 'desc' }], limit: 20,
  });
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every(row => row.department != null && Number.isFinite(Number(row.avg_tat)) && Number(row.records) >= 0));
  assert.equal(result.scope.datasetId, datasets.laboratory);
  assert.equal(result.quality.isSample, false);
  return { datasetId: result.scope.datasetId, rows: result.statistics.rowCount, topRows: result.rows.slice(0, 3), quality: result.quality };
});

await runCase('UAT-P0-MD-03', '零售数据集类别销售与利润聚合', async () => {
  const result = await query(datasets.retail, {
    id: 'uat-p0-retail-category', mode: 'aggregate', purpose: '按类别查看销售额和利润',
    select: [{ field: '类别名称', alias: 'category' }],
    measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }, { field: '订单利润', aggregation: 'sum', alias: 'profit' }],
    orderBy: [{ field: 'revenue', direction: 'desc' }], limit: 20,
  });
  assert.ok(result.rows.length > 1);
  assert.ok(result.rows.every(row => row.category != null && Number.isFinite(Number(row.revenue)) && Number.isFinite(Number(row.profit))));
  assert.equal(result.scope.datasetId, datasets.retail);
  assert.equal(result.quality.isSample, false);
  return { datasetId: result.scope.datasetId, rows: result.statistics.rowCount, topRows: result.rows.slice(0, 3), quality: result.quality };
});

await runCase('UAT-P0-MD-04', '三个数据集 indexed 事实与语义字段证据', async () => {
  const evidence = Object.entries(metadataByDataset).map(([key, metadata]) => ({
    key, id: metadata.id, indexed: metadata.indexed, revision: metadata.revision,
    hasTimeField: metadata.roles.time.length > 0, measureCount: metadata.roles.measure.length,
    semanticDescriptionCount: metadata.assistant?.describedFieldCount ?? 0,
  }));
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every(item => item.indexed === true));
  assert.ok(evidence.every(item => item.hasTimeField && item.measureCount > 0));
  return { evidence, statement: '本批次三个目录数据集均返回 indexed=true；非索引精确聚合仍需额外数据集验证。' };
});

const finishedAt = new Date();
const artifact = {
  schema: 'wynai.uat-result/v1', phase: 'phase-0-multi-dataset',
  startedAt: new Date(finishedAt.getTime() - cases.reduce((sum, item) => sum + item.durationMs, 0)).toISOString(),
  finishedAt: finishedAt.toISOString(), baseUrl, datasets,
  status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
  summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length },
  cases,
  knownLimitations: [
    '当前三个真实数据集均为 indexed=true，无法据此证明非索引数据集可执行精确聚合。',
    '当前使用管理员服务端 Token，尚未完成终端用户身份代理、数据集权限和行级权限对照。',
    '查询结果按当前 Wyn JSON 路径验证；Arrow 和统一分页协议仍未验证。',
  ],
};
const directory = join('test', 'uat-artifacts', 'phase0');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'multi-dataset-latest.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`PHASE 0 MULTI-DATASET UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`);
if (process.exitCode) process.exit(process.exitCode);
