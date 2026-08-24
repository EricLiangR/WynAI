import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const sales = '2b445034-38fe-4350-9cab-b7684c28b5f8';
const retail = '8875ab24-8d24-4a9e-be39-01e44a5678a9';
const cases = [];
async function json(pathname, options) { const response = await fetch(`${baseUrl}${pathname}`, options); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || ''}`); return payload; }
async function run(id, title, action) { const started = Date.now(); try { const evidence = await action(); cases.push({ id, title, status: 'passed', durationMs: Date.now() - started, evidence }); console.log(`PASS ${id} ${title}`); } catch (error) { cases.push({ id, title, status: 'failed', durationMs: Date.now() - started, error: error.message }); console.error(`FAIL ${id} ${title} - ${error.message}`); process.exitCode = 1; } }

let conversation;
await run('UAT-P3-01', '创建多数据集独立问数会话', async () => {
  conversation = await json('/api/smart-query/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetIds: [sales, retail] }) });
  assert.equal(conversation.schema, 'wynai.smart-query-conversation/v1');
  assert.deepEqual(conversation.datasets.map(item => item.id), [sales, retail]);
  return { conversationId: conversation.id, datasets: conversation.datasets };
});

await run('UAT-P3-02', '多数据集首轮问数生成统一 InsightDocument', async () => {
  const result = await json(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '比较两个数据集的区域销售额，并给出趋势和重点发现。' }) });
  assert.equal(result.response.status, 'ok');
  assert.equal(result.response.document.schema, 'wynai.insight-document/v1');
  assert.deepEqual(result.response.document.scope.datasets, [sales, retail]);
  assert.equal(result.response.documents.length, 2);
  assert.ok(result.response.document.blocks.length > 0);
  return { blockCount: result.response.document.blocks.length, documentCount: result.response.documents.length, scope: result.response.document.scope };
});

await run('UAT-P3-03', '会话连续追问继承结构化上下文', async () => {
  const result = await json(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '继续按区域下钻，并查看当前结果范围。' }) });
  assert.equal(result.response.status, 'ok');
  assert.ok(result.conversation.messages.length >= 4);
  assert.ok(result.conversation.resultSetIds.length > 0);
  assert.ok(result.response.document.scope.datasets.length === 2);
  return { messages: result.conversation.messages.length, resultSetIds: result.conversation.resultSetIds, activeMetrics: result.conversation.activeMetrics, activeDimensions: result.conversation.activeDimensions };
});

await run('UAT-P3-04', '非法原始查询和空会话被拒绝', async () => {
  const raw = await fetch(`${baseUrl}/api/smart-query/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetIds: [sales], sql: 'select 1' }) });
  assert.equal(raw.status, 400);
  const created = await json('/api/smart-query/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetIds: [sales] }) });
  const empty = await fetch(`${baseUrl}/api/smart-query/conversations/${created.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wax: 'EVALUATE' }) });
  assert.equal(empty.status, 400);
  return { rawCreateStatus: raw.status, invalidMessageStatus: empty.status };
});

const artifact = { schema: 'wynai.uat-result/v1', phase: 'phase-3-smart-query', finishedAt: new Date().toISOString(), status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed', summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length }, cases, knownLimitations: ['当前会话在服务端使用非严格分析路径；外部 LLM 不可达时使用明确的确定性降级，严格 LLM UAT 仍受网络环境阻断。', '图表和表格块在会话文档中引用 ResultSet，当前轻量会话 UI 展示其引用和摘要，完整 ECharts 由 AI 分析工作区渲染。'] };
const dir = join('test', 'uat-artifacts', 'phase3'); await mkdir(dir, { recursive: true }); const file = `phase3-${artifact.finishedAt.replace(/[:.]/g, '-')}.json`; await writeFile(join(dir, file), `${JSON.stringify(artifact, null, 2)}\n`); await writeFile(join(dir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`); console.log(`PHASE 3 UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`); if (process.exitCode) process.exit(process.exitCode);
