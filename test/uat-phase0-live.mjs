import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const targetDatasetId = process.env.PHASE0_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8';
const startedAt = new Date();
const cases = [];

async function jsonRequest(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} 返回 ${response.status}: ${payload.message || '未知错误'}`);
  return { response, payload };
}

async function runCase(id, title, action) {
  const caseStarted = Date.now();
  try {
    const evidence = await action();
    const item = { id, title, status: 'passed', durationMs: Date.now() - caseStarted, evidence };
    cases.push(item);
    console.log(`PASS ${id} ${title} (${item.durationMs}ms)`);
  } catch (error) {
    const item = { id, title, status: 'failed', durationMs: Date.now() - caseStarted, error: error.message };
    cases.push(item);
    console.error(`FAIL ${id} ${title} - ${error.message}`);
    process.exitCode = 1;
  }
}

async function createRun(filters, goal) {
  return (await jsonRequest('/api/analysis-agent/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId: targetDatasetId, rowLimit: 5000, filters, goal }),
  })).payload;
}

let datasets = [];
let metadata;
let baseline;

await runCase('UAT-P0-01', 'Wyn 与服务运行状态', async () => {
  const { payload } = await jsonRequest('/api/health');
  assert.equal(payload.connected, true);
  assert.equal(payload.status, 200);
  return { wynStatus: payload.status, llmConfigured: payload.llmConfigured, llmModel: payload.llmModel };
});

await runCase('UAT-P0-02', '真实数据集目录和元数据', async () => {
  const catalog = (await jsonRequest('/api/datasets')).payload;
  datasets = catalog.datasets;
  assert.ok(datasets.some(item => item.id === targetDatasetId));
  const summaries = [];
  for (const dataset of datasets) {
    const item = (await jsonRequest(`/api/datasets/${dataset.id}/metadata`)).payload;
    assert.ok(item.fieldCount > 0);
    assert.ok(item.roles.measure.length > 0);
    summaries.push({ id: item.id, name: item.name, revision: item.revision, indexed: item.indexed, fieldCount: item.fieldCount, roles: Object.fromEntries(Object.entries(item.roles).map(([key, values]) => [key, values.length])) });
    if (item.id === targetDatasetId) metadata = item;
  }
  assert.equal(metadata.id, targetDatasetId);
  return { datasetCount: datasets.length, datasets: summaries };
});

await runCase('UAT-P0-03', '受控 WAX 与 NONE 样本范围', async () => {
  baseline = await createRun([], 'Phase 0 完整聚合、分组和样本范围验证');
  assert.equal(baseline.status, 'completed');
  assert.ok(baseline.analysis.profile.rowCount > 5000);
  assert.equal(baseline.analysis.profile.sampleRowCount, 5000);
  assert.equal(baseline.analysis.profile.sourceLimitReached, true);
  assert.equal(baseline.analysis.profile.sourceTruncationConfidence, 'possible');
  assert.equal(baseline.analysis.execution.sampleQueryType, 'NONE');
  assert.equal(baseline.analysis.execution.waxQueryCount, 5);
  assert.ok(baseline.analysis.kpis.some(item => item.rawValue > 0));
  assert.ok(baseline.analysis.charts.length >= 3);
  return {
    runId: baseline.id,
    fullRows: baseline.analysis.profile.rowCount,
    sampleRows: baseline.analysis.profile.sampleRowCount,
    sourceLimitReached: baseline.analysis.profile.sourceLimitReached,
    truncationConfidence: baseline.analysis.profile.sourceTruncationConfidence,
    waxQueryCount: baseline.analysis.execution.waxQueryCount,
    chartTitles: baseline.analysis.charts.map(item => item.title),
  };
});

await runCase('UAT-P0-04', '字符串过滤与分组聚合', async () => {
  const run = await createRun([{ field: '客户地区', operator: 'eq', value: '华东' }], '验证华东区域聚合和分组结果');
  assert.equal(run.status, 'completed');
  assert.ok(run.analysis.profile.rowCount > 0 && run.analysis.profile.rowCount < baseline.analysis.profile.rowCount);
  assert.ok(run.analysis.insights.some(item => /华东/.test(`${item.title} ${item.statement}`)));
  return { runId: run.id, rows: run.analysis.profile.rowCount, filters: run.analysis.execution.filters, evidenceCount: run.analysis.evidence.length };
});

await runCase('UAT-P0-05', '日期、数值和集合过滤', async () => {
  const probes = [
    { name: 'date', filters: [{ field: '订购日期', operator: 'gte', value: '2024-01-01' }] },
    { name: 'number', filters: [{ field: '购买数量', operator: 'gt', value: 5 }] },
    { name: 'in', filters: [{ field: '客户地区', operator: 'in', value: ['华东', '华北'] }] },
  ];
  const results = [];
  for (const probe of probes) {
    const run = await createRun(probe.filters, `Phase 0 ${probe.name} 过滤验证`);
    assert.equal(run.status, 'completed');
    assert.ok(run.analysis.profile.rowCount > 0);
    assert.ok(run.analysis.profile.rowCount <= baseline.analysis.profile.rowCount);
    results.push({ name: probe.name, runId: run.id, rows: run.analysis.profile.rowCount, filters: run.analysis.execution.filters });
  }
  return results;
});

await runCase('UAT-P0-06', '原始查询和越权字段被拒绝', async () => {
  const raw = await fetch(`${baseUrl}/api/analysis-agent/v2/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId: targetDatasetId, sql: 'select * from source' }) });
  const unknown = await fetch(`${baseUrl}/api/analysis-agent/query-plans/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId: targetDatasetId, filters: [{ field: '不存在字段', operator: 'eq', value: 'x' }] }) });
  assert.equal(raw.status, 400);
  assert.equal(unknown.status, 400);
  return { rawQueryStatus: raw.status, unknownFieldStatus: unknown.status };
});

await runCase('UAT-P0-07', '正式报告导出与范围披露', async () => {
  const response = await fetch(`${baseUrl}/api/analysis-agent/runs/${baseline.id}/report?format=html`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /WYN GOVERNED INTELLIGENCE REPORT/);
  assert.match(html, /达到读取上限/);
  assert.doesNotMatch(html, /WYN_TOKEN|LLM_API_KEY|token=/i);
  return { runId: baseline.id, bytes: Buffer.byteLength(html), rangeDisclosure: true };
});

const finishedAt = new Date();
const artifact = {
  schema: 'wynai.uat-result/v1',
  phase: 'phase-0',
  targetDatasetId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
  summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length },
  cases,
  knownLimitations: [
    '当前使用固定服务端 Token，未提供第二个受限用户 Token，因此终端用户身份代理和行级权限对照尚不能实测。',
    '当前目录中的真实数据集均需按 indexed 元数据分别记录；没有可用非索引对照数据集时，非索引精确聚合只能保留为待验证项。',
  ],
};
const artifactDir = join('test', 'uat-artifacts', 'phase0');
await mkdir(artifactDir, { recursive: true });
const timestamp = finishedAt.toISOString().replace(/[:.]/g, '-');
await writeFile(join(artifactDir, `phase0-${timestamp}.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
await writeFile(join(artifactDir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`PHASE 0 UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`);
if (process.exitCode) process.exit(process.exitCode);
