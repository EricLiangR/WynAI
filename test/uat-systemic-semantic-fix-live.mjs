import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = process.env.UAT_BASE_URL || 'http://127.0.0.1:8787';
const datasetId = '2b445034-38fe-4350-9cab-b7684c28b5f8';
const artifactDir = resolve('test/uat-artifacts/systemic-semantic-fix-2026-08-25');
await mkdir(artifactDir, { recursive: true });

async function jsonFetch(path, init = {}) {
  const response = await fetch(baseUrl + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(response.status + ' ' + (payload.message || path));
  return payload;
}

async function ask(question, conversationId = null) {
  const conversation = conversationId ? { id: conversationId } : await jsonFetch('/api/smart-query/conversations', {
    method: 'POST',
    body: JSON.stringify({ datasetId }),
  });
  const payload = await jsonFetch('/api/smart-query/conversations/' + conversation.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
  return { conversationId: conversation.id, response: payload.response };
}

function chart(response) {
  return response.document?.blocks?.find(block => block.type === 'chart')?.visualization || null;
}

const health = await jsonFetch('/api/health');
assert.equal(health.connected, true);
const skills = await jsonFetch('/api/smart-query/skills');
assert.ok(skills.items.some(item => item.id === 'sales-baseline' && item.version === '1.1.0'));

const results = [];

{
  const item = await ask('统计每年，销售排名前三的城市和销售额');
  const { response } = item;
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.businessIntent.ranking.partitionBy, ['period']);
  const rows = response.resultSets[0].rows;
  const years = new Map();
  for (const row of rows) {
    const year = String(row.period).slice(0, 4);
    years.set(year, (years.get(year) || 0) + 1);
  }
  assert.ok(years.size >= 8);
  assert.ok([...years.values()].every(count => count === 3));
  assert.ok(new Set(rows.map(row => row.city)).size > 1);
  results.push({ id: 'SSF-001', question: '统计每年，销售排名前三的城市和销售额', status: 'passed', conversationId: item.conversationId, rowCount: rows.length, years: Object.fromEntries(years), planner: response.planningDiagnostics });
}

{
  const item = await ask('逐年列出销售额最高的三个城市');
  const { response } = item;
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.businessIntent.ranking.partitionBy, ['period']);
  assert.ok(response.resultSets[0].rows.length >= 24);
  results.push({ id: 'SSF-002', question: '逐年列出销售额最高的三个城市', status: 'passed', conversationId: item.conversationId, rowCount: response.resultSets[0].rows.length, planner: response.planningDiagnostics });
}

{
  const item = await ask('统计每年销售额、利润和订单数量');
  const { response } = item;
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.businessIntent.metrics.map(metric => [metric.field, metric.aggregation]), [
    ['订单金额', 'sum'],
    ['订单利润', 'sum'],
    ['订单编号', 'distinctCount'],
  ]);
  const spec = chart(response);
  assert.equal(spec?.type, 'combo');
  assert.equal(spec.encoding.measures.find(measure => measure.field === 'order_count')?.axis, 'right');
  results.push({ id: 'SSF-003', question: '统计每年销售额、利润和订单数量', status: 'passed', conversationId: item.conversationId, rowCount: response.resultSets[0].rows.length, chartType: spec.type, planner: response.planningDiagnostics });
}

{
  const item = await ask('去年各省份的销售额和同比增长率');
  const { response } = item;
  assert.equal(response.status, 'ok');
  assert.equal(response.businessIntent.dimensions.find(dimension => dimension.grain)?.internal, true);
  assert.equal(response.resultSets[0].schema.some(column => column.name === 'period'), false);
  assert.ok(response.resultSets[0].rows.every(row => Object.hasOwn(row, 'province') && Object.hasOwn(row, 'revenue_yoy')));
  assert.equal(chart(response)?.encoding.category.field, 'province');
  results.push({ id: 'SSF-004', question: '去年各省份的销售额和同比增长率', status: 'passed', conversationId: item.conversationId, rowCount: response.resultSets[0].rows.length, chartType: chart(response)?.type || null, planner: response.planningDiagnostics });
}

{
  const item = await ask('统计去年，每个大区的销售额和销售额同比增长率');
  const { response } = item;
  assert.equal(response.status, 'ok');
  assert.equal(response.businessIntent.dimensions.find(dimension => !dimension.grain).field, '客户地区');
  assert.ok(response.resultSets[0].rows.every(row => Object.hasOwn(row, 'region') && Object.hasOwn(row, 'revenue_yoy')));
  results.push({ id: 'SSF-005', question: '统计去年，每个大区的销售额和销售额同比增长率', status: 'passed', conversationId: item.conversationId, rowCount: response.resultSets[0].rows.length, planner: response.planningDiagnostics });
}

{
  const first = await ask('统计每年销售额');
  assert.equal(first.response.status, 'ok');
  const second = await ask('同时增加利润和订单数量', first.conversationId);
  assert.equal(second.response.status, 'ok');
  assert.deepEqual(second.response.businessIntent.metrics.map(metric => metric.alias), ['revenue', 'profit', 'order_count']);
  assert.equal(second.response.businessIntent.transition.inheritsPriorContext, true);
  assert.equal(chart(second.response)?.type, 'combo');
  results.push({ id: 'SSF-006', question: '统计每年销售额 -> 同时增加利润和订单数量', status: 'passed', conversationId: first.conversationId, turns: 2, chartType: chart(second.response)?.type || null, planner: second.response.planningDiagnostics });
}

{
  const first = await ask('过去三年销售额累计排名前三的是谁');
  assert.equal(first.response.status, 'needs_clarification');
  assert.ok(first.response.clarification.options.includes('按销售经理分析'));
  const second = await ask('按销售经理分析', first.conversationId);
  assert.equal(second.response.status, 'ok');
  assert.equal(second.response.businessIntent.dimensions.find(dimension => !dimension.grain).field, '员工姓名');
  assert.ok(second.response.intentPatch.operations.some(operation => operation.path === '/dimensions'));
  results.push({ id: 'SSF-007', question: '过去三年销售额累计排名前三的是谁 -> 按销售经理分析', status: 'passed', conversationId: first.conversationId, turns: 2, clarification: first.response.clarification, planner: second.response.planningDiagnostics });
}

const artifact = {
  schema: 'wynai.uat-run/v1',
  title: '独立问数系统性语义修复真实 Wyn UAT',
  baseUrl,
  datasetId,
  startedAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter(item => item.status === 'passed').length,
  failed: results.filter(item => item.status !== 'passed').length,
  results,
};
artifact.completedAt = new Date().toISOString();
await writeFile(resolve(artifactDir, 'api-uat-results.json'), JSON.stringify(artifact, null, 2) + String.fromCharCode(10), 'utf8');
console.log(JSON.stringify({ total: artifact.total, passed: artifact.passed, failed: artifact.failed, artifact: resolve(artifactDir, 'api-uat-results.json') }, null, 2));
