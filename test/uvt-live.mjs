import assert from 'node:assert/strict';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

async function jsonRequest(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} 返回 ${response.status}: ${payload.message || '未知错误'}`);
  return { response, payload };
}

async function runCase(id, title, action) {
  const startedAt = Date.now();
  try {
    const detail = await action();
    console.log(`PASS ${id} ${title} (${Date.now() - startedAt}ms)${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    console.error(`FAIL ${id} ${title} - ${error.message}`);
    process.exitCode = 1;
  }
}

let dataset;
let datasets = [];
let metadata;
let queryBundle;
let run;
const filters = [{ field: '客户地区', operator: 'eq', value: '华东' }];

await runCase('UVT-01', '服务、Wyn 与模型连接状态', async () => {
  const { payload } = await jsonRequest('/api/health');
  assert.equal(payload.connected, true);
  assert.equal(payload.status, 200);
  return `Wyn connected, LLM ${payload.llmConfigured ? payload.llmModel : 'fallback'}`;
});

await runCase('UVT-02', '受控数据集目录', async () => {
  const { payload } = await jsonRequest('/api/datasets');
  assert.ok(payload.total > 0);
  datasets = payload.datasets;
  dataset = datasets.find(item => item.name.includes('销售')) || datasets[0];
  assert.equal(dataset.analysisReady, true);
  return `${payload.total} datasets, selected ${dataset.name}`;
});

await runCase('UVT-03', '全部数据集元数据与语义定义', async () => {
  assert.ok(dataset);
  const summaries = [];
  for (const item of datasets) {
    const result = await jsonRequest(`/api/datasets/${item.id}/metadata`);
    assert.ok(result.payload.fieldCount > 0);
    assert.ok(result.payload.roles.measure.length > 0);
    assert.equal(result.payload.assistant.enabled, true);
    if (item.id === dataset.id) metadata = result.payload;
    summaries.push(`${item.name}:${result.payload.fieldCount}`);
  }
  assert.ok(metadata.fields.some(field => field.name === filters[0].field));
  return summaries.join(', ');
});

await runCase('UVT-04', '结构化 WAX 查询计划预览与安全边界', async () => {
  const { payload } = await jsonRequest('/api/analysis-agent/query-plans/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId: dataset.id, filters }),
  });
  queryBundle = payload;
  assert.equal(queryBundle.version, 'wyn-query-bundle/v1');
  assert.deepEqual(queryBundle.plans.map(item => item.id), ['overview', 'trend', 'category', 'region', 'customer']);
  assert.ok(queryBundle.plans.every(item => item.queryType === 'WAX'));
  assert.ok(queryBundle.plans.every(item => item.sqlAllowed === false));
  assert.equal(queryBundle.capabilities.dataSourceSql, false);
  assert.equal(queryBundle.capabilities.arbitraryWax, false);
  assert.equal(queryBundle.capabilities.completeDatasetAggregation, true);
  return `${queryBundle.plans.length} governed WAX plans`;
});

await runCase('UVT-05', '带业务筛选的完整 AI 数据分析运行', async () => {
  const { payload } = await jsonRequest('/api/analysis-agent/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      datasetId: dataset.id,
      rowLimit: 5000,
      filters,
      goal: '分析华东区域的销售趋势、品类贡献、重点客户和风险，并生成管理建议。',
    }),
  });
  run = payload;
  assert.equal(run.status, 'completed');
  assert.ok(run.analysis.profile.rowCount > 0);
  assert.ok(run.analysis.profile.sampleRowCount > 0);
  assert.ok(run.analysis.profile.sampleRowCount <= 5000);
  assert.ok(run.analysis.kpis.length >= 3);
  assert.ok(run.analysis.charts.length >= 2);
  assert.ok(run.analysis.insights.length >= 3);
  assert.ok(run.analysis.evidence.length >= run.analysis.insights.length);
  assert.equal(run.analysis.validation.evidenceCoverage, 100);
  assert.equal(run.analysis.validation.sqlAllowed, false);
  assert.equal(run.analysis.validation.executionStrategy, 'wyn-wax-controlled');
  assert.equal(run.analysis.execution.sampleQueryType, 'WAX');
  assert.equal(run.analysis.execution.waxQueryCount, queryBundle.plans.length);
  assert.deepEqual(run.analysis.execution.filters.map(item => item.field), [filters[0].field]);
  return `${run.analysis.profile.rowCount} full rows, ${run.analysis.profile.sampleRowCount} quality rows, ${run.analysis.evidence.length} evidence items`;
});

await runCase('UVT-06', '持久化历史与运行结果重复读取', async () => {
  assert.ok(run?.id);
  const list = await jsonRequest('/api/analysis-agent/runs');
  assert.ok(list.payload.items.some(item => item.id === run.id));
  const detail = await jsonRequest(`/api/analysis-agent/runs/${run.id}`);
  assert.equal(detail.payload.id, run.id);
  assert.equal(detail.payload.status, 'completed');
  assert.equal(detail.payload.analysis.report.title, run.analysis.report.title);
  assert.equal(detail.payload.analysis.execution.waxStatus, 'completed');
  return `${list.payload.total} persisted runs`;
});

await runCase('UVT-07', '正式报告 HTML、Markdown 与 JSON 导出', async () => {
  const formats = ['html', 'markdown', 'json'];
  const results = {};
  for (const format of formats) {
    const response = await fetch(`${baseUrl}/api/analysis-agent/runs/${run.id}/report?format=${format}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') || '', /attachment/);
    results[format] = await response.text();
  }
  assert.match(results.html, /WYN GOVERNED INTELLIGENCE REPORT/);
  assert.match(results.html, /<svg/);
  assert.doesNotMatch(results.html, /token=/i);
  assert.match(results.markdown, new RegExp(run.id));
  assert.equal(JSON.parse(results.json).id, run.id);
  return `${results.html.length} HTML chars with embedded charts`;
});

await runCase('UVT-08', '越权字段、任意格式与非法数据集被拒绝', async () => {
  const badField = await fetch(`${baseUrl}/api/analysis-agent/query-plans/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId: dataset.id, filters: [{ field: '不存在字段', operator: 'eq', value: 'x' }] }),
  });
  assert.equal(badField.status, 400);
  const badFormat = await fetch(`${baseUrl}/api/analysis-agent/runs/${run.id}/report?format=pdf`);
  assert.equal(badFormat.status, 400);
  const badDataset = await fetch(`${baseUrl}/api/datasets/not-allowed/metadata`);
  assert.ok([400, 404].includes(badDataset.status));
  return `field ${badField.status}, format ${badFormat.status}, dataset ${badDataset.status}`;
});

if (process.exitCode) process.exit(process.exitCode);
console.log('UVT COMPLETE: all automated user verification cases passed.');
