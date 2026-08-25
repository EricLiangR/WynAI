import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const datasetId = process.env.UAT_SALES_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8';
const adminToken = process.env.UAT_ADMIN_TOKEN || '';
const cases = [];
const adminHeaders = adminToken ? { 'X-Wyn-Skill-Admin-Token': adminToken } : {};
async function json(pathname, options = {}) { const response = await fetch(`${baseUrl}${pathname}`, options); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || ''}`); return payload; }
async function run(id, title, action) { const startedAt = Date.now(); try { const evidence = await action(); cases.push({ id, title, status: 'passed', durationMs: Date.now() - startedAt, evidence }); console.log(`PASS ${id} ${title}`); } catch (error) { cases.push({ id, title, status: 'failed', durationMs: Date.now() - startedAt, error: error.message }); console.error(`FAIL ${id} ${title} - ${error.message}`); process.exitCode = 1; } }

let conversation;
let first;
let second;
let feedback;

await run('UAT-RL-01', '三个正式领域 Skill 可见且草稿不进入公开目录', async () => {
  const catalog = await json('/api/smart-query/skills');
  const refs = catalog.items.map(item => `${item.id}@${item.version}`);
  for (const ref of ['sales-baseline@1.0.0', 'laboratory-baseline@1.0.0', 'retail-baseline@1.0.0']) assert.ok(refs.includes(ref));
  assert.ok(catalog.items.every(item => item.status === 'approved'));
  return { refs };
});

await run('UAT-RL-02', '低风险完整问题使用确定性快路径', async () => {
  conversation = await json('/api/smart-query/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId }) });
  first = await json(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '2025年销售收入总额是多少' }) });
  assert.equal(first.response.status, 'ok');
  assert.equal(first.response.planningDiagnostics.riskAssessment.level, 'low');
  assert.equal(first.response.planningDiagnostics.llmAttempted, false);
  assert.ok(first.response.trace.traceId.startsWith('trace-'));
  return { conversationId: conversation.id, trace: first.response.trace, planning: first.response.planningDiagnostics, rows: first.response.resultSets[0].rows };
});

await run('UAT-RL-03', '同比问题进入中风险 LLM 复核或受控回退', async () => {
  second = await json(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '过去五年，每年的销售收入和同比增长率' }) });
  assert.equal(second.response.status, 'ok');
  assert.equal(second.response.planningDiagnostics.riskAssessment.level, 'medium');
  assert.equal(second.response.planningDiagnostics.llmAttempted, true);
  assert.ok(['hybrid-llm-validated', 'deterministic-risk-fallback'].includes(second.response.planningDiagnostics.route));
  assert.equal(second.response.resultSets[0].rows.length, 5);
  return { trace: second.response.trace, planning: second.response.planningDiagnostics, rows: second.response.resultSets[0].rows };
});

await run('UAT-RL-04', '日志 API 可完整回放用户操作与查询阶段', async () => {
  assert.ok(adminToken, 'UAT_ADMIN_TOKEN 未配置');
  const replay = await json(`/api/smart-query/operation-events/${second.response.trace.traceId}`, { headers: adminHeaders });
  const events = replay.items.map(item => item.event);
  for (const required of ['request.accepted', 'turn.received', 'skill.resolved', 'planning.completed', 'query.executed', 'result.validated', 'response.composed', 'turn.completed', 'request.completed']) assert.ok(events.includes(required), `缺少事件 ${required}`);
  assert.deepEqual(replay.items.map(item => item.sequence), [...replay.items.map((_, index) => index + 1)]);
  return { traceId: replay.traceId, events, risk: replay.items.find(item => item.event === 'planning.completed')?.details?.diagnostics?.riskAssessment };
});

await run('UAT-RL-05', '普通用户口径纠正生成待审核 Skill 候选', async () => {
  feedback = await json(`/api/smart-query/conversations/${conversation.id}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'wrong_metric', correction: '销售收入应使用不含税金额口径', turnId: second.response.trace.turnId, traceId: second.response.trace.traceId }) });
  assert.equal(feedback.candidate.kind, 'skill-rule');
  assert.equal(feedback.candidate.status, 'pending_review');
  return feedback;
});

await run('UAT-RL-06', '管理员可审核候选且审核不会自动发布 Skill', async () => {
  const before = await json('/api/smart-query/skills');
  const reviewed = await json(`/api/smart-query/learning-candidates/${feedback.candidate.id}/reject`, { method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'UAT 夹具，不发布生产口径' }) });
  assert.equal(reviewed.status, 'rejected');
  const after = await json('/api/smart-query/skills');
  assert.deepEqual(after.items.map(item => `${item.id}@${item.version}`), before.items.map(item => `${item.id}@${item.version}`));
  const replay = await json(`/api/smart-query/operation-events/${second.response.trace.traceId}`, { headers: adminHeaders });
  assert.ok(replay.items.some(item => item.event === 'feedback.received'));
  return { candidateId: reviewed.id, status: reviewed.status, productionSkillCount: after.total, feedbackEventRecorded: true };
});

const artifact = { schema: 'wynai.uat-result/v1', phase: 'risk-routing-learning', finishedAt: new Date().toISOString(), status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed', summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length }, cases };
const dir = join('test', 'uat-artifacts', 'risk-learning-2026-08-25');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`RISK LEARNING UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`);
if (process.exitCode) process.exit(process.exitCode);

