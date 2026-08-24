import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const datasetId = process.env.PHASE0_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8';
const cases = [];
async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || 'request failed'}`);
  return payload;
}
async function runCase(id, title, action) {
  try {
    const evidence = await action();
    cases.push({ id, title, status: 'passed', evidence });
    console.log(`PASS ${id} ${title}`);
  } catch (error) {
    cases.push({ id, title, status: 'failed', error: error.message });
    console.error(`FAIL ${id} ${title}: ${error.message}`);
    process.exitCode = 1;
  }
}

let conversation;
await runCase('UAT-P3-01', '会话创建与 Skill 目录', async () => {
  const catalog = await request('/api/smart-query/skills');
  assert.ok(catalog.items.some(item => item.id === 'sales-baseline'));
  conversation = await request('/api/smart-query/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId }) });
  assert.equal(conversation.schema, 'wynai.smart-query-conversation/v1');
  return { conversationId: conversation.id, skillCount: catalog.total };
});

await runCase('UAT-P3-02', '首轮问数生成组合 InsightDocument', async () => {
  const response = await request(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '查看销售额趋势' }) });
  assert.equal(response.response.schema, 'wynai.ai-interaction-response/v1');
  assert.equal(response.response.status, 'ok');
  assert.equal(response.response.document.schema, 'wynai.insight-document/v1');
  const types = new Set(response.response.document.blocks.map(block => block.type));
  assert.ok(types.has('kpi') && types.has('text') && types.has('chart') && types.has('table'));
  assert.ok(response.conversation.loadedSkillRefs.includes('sales-baseline@1.0.0'));
  return { blocks: response.response.document.blocks.length, blockTypes: [...types], skillRefs: response.conversation.loadedSkillRefs };
});

await runCase('UAT-P3-03', '多轮追问继承上下文并更新结果引用', async () => {
  const response = await request(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '继续按客户地区下钻' }) });
  assert.equal(response.response.status, 'ok');
  assert.equal(response.conversation.messages.length, 4);
  assert.ok(response.conversation.resultSetIds.length > 0);
  assert.ok(response.conversation.activeDimensions.length > 0);
  return { messages: response.conversation.messages.length, resultSetIds: response.conversation.resultSetIds, activeDimensions: response.conversation.activeDimensions };
});

await runCase('UAT-P4-01', 'Skill 安全边界和原始查询拒绝', async () => {
  const response = await request('/api/smart-query/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ id: 'qry-safe-skill', datasetId, mode: 'aggregate', select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], limit: 5 }] }) });
  assert.equal(response.schema, 'wynai.multi-dataset-query-result/v1');
  const raw = await fetch(`${baseUrl}/api/smart-query/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ id: 'qry-raw', datasetId, mode: 'aggregate', query: 'EVALUATE ROW()' }] }) });
  assert.equal(raw.status, 400);
  return { safeSchema: response.schema, rawQueryStatus: raw.status };
});

const artifact = {
  schema: 'wynai.uat-result/v1', phase: 'phase-3-4-conversation-skills', finishedAt: new Date().toISOString(),
  status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
  summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length },
  cases,
  knownLimitations: ['Skill 管理页面、审批流和用户级外部身份映射尚未实现。', '会话结果不持久化完整明细，仅持久化结构化状态和文档引用。'],
};
const directory = join('test', 'uat-artifacts', 'phase3-4');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`PHASE 3-4 UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`);
if (process.exitCode) process.exit(process.exitCode);
