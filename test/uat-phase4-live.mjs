import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const sales = '2b445034-38fe-4350-9cab-b7684c28b5f8';
const cases = [];
async function json(pathname, options) { const response = await fetch(`${baseUrl}${pathname}`, options); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || ''}`); return payload; }
async function run(id, title, action) { const started = Date.now(); try { const evidence = await action(); cases.push({ id, title, status: 'passed', durationMs: Date.now() - started, evidence }); console.log(`PASS ${id} ${title}`); } catch (error) { cases.push({ id, title, status: 'failed', durationMs: Date.now() - started, error: error.message }); console.error(`FAIL ${id} ${title} - ${error.message}`); process.exitCode = 1; } }

await run('UAT-P4-01', 'Skill 目录和版本可读取', async () => {
  const catalog = await json('/api/smart-query/skills');
  assert.equal(catalog.schema, 'wynai.skill-catalog/v1');
  assert.ok(catalog.items.some(item => item.id === 'sales-baseline' && item.version === '1.0.0' && item.status === 'approved'));
  return { total: catalog.total, skills: catalog.items };
});

await run('UAT-P4-02', 'Skill 按真实数据集和业务触发词加载', async () => {
  const conversation = await json('/api/smart-query/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId: sales }) });
  const response = await json(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '查看销售额和利润趋势' }) });
  assert.equal(response.response.status, 'ok');
  assert.ok(response.conversation.loadedSkillRefs?.includes('sales-baseline@1.0.0'));
  return { conversationId: conversation.id, loadedSkillRefs: response.conversation.loadedSkillRefs, queryCount: response.response.queryRequests.length };
});

await run('UAT-P4-03', '技能冲突会要求用户澄清而不静默覆盖', async () => {
  const conversation = await json('/api/smart-query/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wyn-Organization-Id': 'uat-org-conflict' }, body: JSON.stringify({ datasetId: sales }) });
  const response = await json(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '查看销售额' }) });
  assert.equal(response.response.status, 'needs_clarification');
  assert.match(response.response.diagnostics.semanticWarnings.join(' '), /skill-conflict/);
  return { status: response.response.status, queryCount: response.response.queryRequests.length, conflictPolicy: 'approved skills only; conflicts require clarification', options: response.response.clarification.options };
});

const artifact = { schema: 'wynai.uat-result/v1', phase: 'phase-4-skills', finishedAt: new Date().toISOString(), status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed', summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length }, cases, knownLimitations: ['当前真实目录只有销售 Skill；实验室和零售场景的生产 Skill 需要业务口径确认后补充。'] };
const dir = join('test', 'uat-artifacts', 'phase4'); await mkdir(dir, { recursive: true }); const file = `phase4-${artifact.finishedAt.replace(/[:.]/g, '-')}.json`; await writeFile(join(dir, file), `${JSON.stringify(artifact, null, 2)}\n`); await writeFile(join(dir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`); console.log(`PHASE 4 UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`); if (process.exitCode) process.exit(process.exitCode);
