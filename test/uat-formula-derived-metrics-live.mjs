import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.env.UVT_BASE_URL || 'http://127.0.0.1:8787';
const datasetId = process.env.UAT_SALES_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8';
const artifactDir = join(process.cwd(), 'test', 'uat-artifacts', 'formula-derived-metrics-2026-08-25');
const cases = [];

async function json(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || ''}`);
  return payload;
}

async function createConversation() {
  return json('/api/smart-query/conversations', {
    method: 'POST',
    body: JSON.stringify({ datasetId }),
  });
}

async function ask(conversationId, question) {
  return json(`/api/smart-query/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}

async function run(id, title, action) {
  const startedAt = Date.now();
  try {
    const evidence = await action();
    cases.push({ id, title, status: 'passed', durationMs: Date.now() - startedAt, evidence });
    console.log(`PASS ${id} ${title}`);
  } catch (error) {
    cases.push({ id, title, status: 'failed', durationMs: Date.now() - startedAt, error: error.stack || error.message });
    console.error(`FAIL ${id} ${title} - ${error.message}`);
    process.exitCode = 1;
  }
}

function responseOf(payload) {
  assert.equal(payload.response.status, 'ok');
  assert.equal(payload.response.semanticValidation?.valid, true);
  assert.equal(payload.response.resultSets?.[0]?.quality?.isSample, false);
  return payload.response;
}

function assertRatios(rows) {
  for (const row of rows) {
    const expected = Number(row.profit) / Number(row.revenue);
    assert.ok(Number.isFinite(expected));
    assert.ok(Math.abs(Number(row.gross_margin_rate) - expected) < 1e-10, `${row.gross_margin_rate} should equal ${expected}`);
  }
}

const health = await json('/api/health');
assert.equal(health.connected, true);

await run('UAT-FDM-01', '真实 Wyn 每年销售额利润毛利率与组合图', async () => {
  const conversation = await createConversation();
  const response = responseOf(await ask(conversation.id, '分析每年的销售额、利润和毛利率'));
  const result = response.resultSets[0];
  assert.equal(result.rows.length, 9);
  assert.deepEqual(response.businessIntent.derivedMetrics.map(item => item.metricId), ['grossMarginRate']);
  assert.deepEqual(response.businessIntent.derivedMetrics[0].dependencies.map(item => item.metricId), ['profit', 'revenue']);
  assertRatios(result.rows);
  const chart = response.document.blocks.find(item => item.type === 'chart');
  assert.equal(chart.visualization.type, 'combo');
  assert.equal(chart.visualization.encoding.measures.find(item => item.field === 'gross_margin_rate').axis, 'right');
  assert.ok(['hybrid-llm-validated', 'deterministic-risk-fallback'].includes(response.planningDiagnostics.route));
  return {
    conversationId: conversation.id,
    traceId: response.trace.traceId,
    planner: response.planningDiagnostics,
    rowCount: result.rows.length,
    firstRow: result.rows[0],
    lastRow: result.rows.at(-1),
    chart: chart.visualization,
  };
});

await run('UAT-FDM-02', '仅毛利率隐藏内部依赖列', async () => {
  const conversation = await createConversation();
  const response = responseOf(await ask(conversation.id, '每年毛利率'));
  const result = response.resultSets[0];
  assert.equal(result.rows.length, 9);
  assert.deepEqual(result.schema.map(item => item.name), ['period', 'gross_margin_rate']);
  assert.ok(result.rows.every(row => !Object.hasOwn(row, 'profit') && !Object.hasOwn(row, 'revenue')));
  assert.ok(result.rows.every(row => Number.isFinite(Number(row.gross_margin_rate))));
  return { conversationId: conversation.id, traceId: response.trace.traceId, schema: result.schema, rows: result.rows };
});

await run('UAT-FDM-03', '真实 Wyn 地区分组毛利率', async () => {
  const conversation = await createConversation();
  const response = responseOf(await ask(conversation.id, '按地区分析毛利率'));
  const result = response.resultSets[0];
  assert.ok(result.rows.length >= 2);
  assert.deepEqual(result.schema.map(item => item.name), ['region', 'gross_margin_rate']);
  assert.ok(result.rows.every(row => row.region && Number.isFinite(Number(row.gross_margin_rate))));
  return { conversationId: conversation.id, traceId: response.trace.traceId, rows: result.rows };
});

await run('UAT-FDM-04', '多轮追加毛利率继承年度上下文', async () => {
  const conversation = await createConversation();
  const first = responseOf(await ask(conversation.id, '统计每年销售额'));
  const second = responseOf(await ask(conversation.id, '同时增加毛利率'));
  const result = second.resultSets[0];
  assert.equal(second.businessIntent.transition.inheritsPriorContext, true);
  assert.equal(second.businessIntent.time.grain, 'year');
  assert.deepEqual(result.schema.map(item => item.name), ['period', 'revenue', 'gross_margin_rate']);
  assert.equal(result.rows.length, first.resultSets[0].rows.length);
  assert.ok(result.rows.every(row => Number.isFinite(Number(row.gross_margin_rate))));
  return { conversationId: conversation.id, traceId: second.trace.traceId, firstSchema: first.resultSets[0].schema, secondSchema: result.schema, rows: result.rows };
});

await run('UAT-FDM-05', '销售毛利率同义词标量百分比回答', async () => {
  const conversation = await createConversation();
  const response = responseOf(await ask(conversation.id, '销售毛利率是多少'));
  const result = response.resultSets[0];
  assert.deepEqual(result.schema.map(item => item.name), ['gross_margin_rate']);
  const kpi = response.document.blocks.find(item => item.type === 'kpi');
  assert.match(String(kpi.value), /%$/);
  assert.ok(Number.isFinite(Number(result.rows[0].gross_margin_rate)));
  return { conversationId: conversation.id, traceId: response.trace.traceId, row: result.rows[0], kpi: kpi.value };
});

await run('UAT-FDM-06', '未知率指标必须澄清而不退化为基础指标', async () => {
  const conversation = await createConversation();
  const payload = await ask(conversation.id, '每年净利率');
  assert.equal(payload.response.status, 'needs_clarification');
  assert.match(payload.response.clarification.question, /指标|约束|口径/);
  assert.equal(payload.response.queryRequests.length, 0);
  return { conversationId: conversation.id, clarification: payload.response.clarification, intent: payload.response.pendingContext?.intent || null };
});

await run('UAT-FDM-07', '派生毛利率在计算后执行最高地区排名', async () => {
  const conversation = await createConversation();
  const response = responseOf(await ask(conversation.id, '毛利率最高的地区'));
  const result = response.resultSets[0];
  assert.equal(result.rows.length, 1);
  assert.equal(response.businessIntent.ranking.orderBy, 'gross_margin_rate');
  assert.equal(result.rows[0].region, '西南');
  assert.ok(Number.isFinite(Number(result.rows[0].gross_margin_rate)));
  return { conversationId: conversation.id, traceId: response.trace.traceId, ranking: response.businessIntent.ranking, row: result.rows[0] };
});

const artifact = {
  schema: 'wynai.uat-result/v1',
  phase: 'formula-derived-metrics',
  finishedAt: new Date().toISOString(),
  environment: { baseUrl, datasetId, wynConnected: health.connected, llmConfigured: health.llmConfigured },
  status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
  summary: {
    total: cases.length,
    passed: cases.filter(item => item.status === 'passed').length,
    failed: cases.filter(item => item.status === 'failed').length,
  },
  cases,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, 'api-results.json'), `${JSON.stringify(artifact, null, 2)}
`);
await writeFile(join(artifactDir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}
`);
console.log(`FORMULA DERIVED METRICS UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`);
if (process.exitCode) process.exit(process.exitCode);
