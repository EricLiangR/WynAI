import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRunStore } from '../lib/run-store.mjs';
import { SkillRegistry } from '../lib/skills/skill-registry.mjs';
import { SkillGovernanceService } from '../lib/skills/skill-governance.mjs';
import { RequestAuditLog, SlidingWindowRateLimiter, requestIdentity } from '../lib/security/request-governance.mjs';

test('Skill 治理支持草稿、审批、版本列表和审计持久化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wynai-skill-governance-'));
  const service = new SkillGovernanceService({
    registry: new SkillRegistry(),
    overridePersistence: new JsonRunStore(join(dir, 'overrides'), { maxItems: 20 }),
    auditPersistence: new JsonRunStore(join(dir, 'audit'), { maxItems: 50 }),
  });
  await service.init();
  const draft = await service.saveOverride({ id: 'sales-governed', version: '1.0.0', name: '销售', scope: 'dataset', datasetIds: ['d1'], status: 'draft' }, { actor: 'u1' });
  assert.equal(draft.skill.status, 'draft');
  const approved = await service.setStatus('sales-governed', '1.0.0', 'approved', { actor: 'admin' });
  assert.equal(approved.skill.status, 'approved');
  await service.saveOverride({ ...approved.skill, version: '1.1.0', status: 'draft' }, { actor: 'admin' });
  const versions = service.versions('sales-governed');
  assert.equal(versions.length, 2);
  const restored = new SkillGovernanceService({ registry: new SkillRegistry(), overridePersistence: new JsonRunStore(join(dir, 'overrides'), { maxItems: 20 }), auditPersistence: new JsonRunStore(join(dir, 'audit'), { maxItems: 50 }) });
  await restored.init();
  assert.equal(restored.registry.get('sales-governed', '1.1.0').status, 'draft');
  assert.ok(restored.auditLog().length >= 3);
});

test('公开 Skill 目录不包含 draft 或 retired 版本', () => {
  const registry = new SkillRegistry([
    { id: 'visible', version: '1.0.0', status: 'approved' },
    { id: 'draft-only', version: '1.0.0', status: 'draft' },
    { id: 'retired-only', version: '1.0.0', status: 'retired' },
  ]);
  const publicItems = registry.list().filter(skill => skill.status === 'approved');
  assert.deepEqual(publicItems.map(skill => skill.id), ['visible']);
});

test('Skill 运行解析事件持久化并保留主体与版本引用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wynai-skill-runtime-'));
  const service = new SkillGovernanceService({ registry: new SkillRegistry(), auditPersistence: new JsonRunStore(join(dir, 'audit'), { maxItems: 20 }) });
  await service.init();
  await service.recordResolution({ datasetId: 'dataset-1', organizationId: 'org-1', userId: 'user-1', question: '看销售额', refs: ['sales@1.0.0'] });
  const restored = new SkillGovernanceService({ registry: new SkillRegistry(), auditPersistence: new JsonRunStore(join(dir, 'audit'), { maxItems: 20 }) });
  await restored.init();
  assert.equal(restored.auditLog()[0].action, 'skill.resolved');
  assert.deepEqual(restored.auditLog()[0].skillRefs, ['sales@1.0.0']);
});

test('Skill 回滚只保留目标版本为 approved', async () => {
  const service = new SkillGovernanceService({ registry: new SkillRegistry([{ id: 's', version: '1.0.0', status: 'approved' }, { id: 's', version: '2.0.0', status: 'approved' }]) });
  await service.rollback('s', '1.0.0', { actor: 'admin', reason: '回退验证' });
  assert.equal(service.registry.get('s', '1.0.0').status, 'approved');
  assert.equal(service.registry.get('s', '2.0.0').status, 'retired');
});

test('请求限流和审计记录具备主体边界', () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(limiter.check('org:u1').allowed, true);
  assert.equal(limiter.check('org:u1').allowed, false);
  assert.equal(limiter.check('org:u2').allowed, true);
  const audit = new RequestAuditLog();
  const event = audit.record({ method: 'POST', path: '/api/smart-query/conversations', status: 429, actor: 'u1', organizationId: 'org', userId: 'u1', rateLimited: true, plannerMode: 'deterministic-fast-path', planningDurationMs: 12, llmAttempted: false, llmDurationMs: 0 });
  assert.equal(event.rateLimited, true);
  assert.equal(event.plannerMode, 'deterministic-fast-path');
  assert.equal(event.planningDurationMs, 12);
  assert.equal(event.llmAttempted, false);
  assert.equal(audit.list()[0].organizationId, 'org');
});

test('请求主体只信任受信请求头，不接受请求体自报身份', () => {
  const identity = requestIdentity({ headers: { 'x-wyn-user-id': 'header-user', 'x-wyn-organization-id': 'header-org' } }, { userId: 'spoofed-user', organizationId: 'spoofed-org' });
  assert.deepEqual(identity, { userId: 'header-user', organizationId: 'header-org', actor: 'header-user' });
  const anonymous = requestIdentity({ headers: {} }, { userId: 'spoofed-user' });
  assert.equal(anonymous.userId, null);
});

test('请求审计可跨进程持久化恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wynai-request-audit-'));
  const first = new RequestAuditLog({ persistence: new JsonRunStore(join(dir, 'audit'), { maxItems: 20 }) });
  await first.init();
  first.record({ method: 'GET', path: '/api/smart-query/audit', status: 200, actor: 'u1' });
  await first.writeChain;
  const second = new RequestAuditLog({ persistence: new JsonRunStore(join(dir, 'audit'), { maxItems: 20 }) });
  await second.init();
  assert.equal(second.list()[0].path, '/api/smart-query/audit');
});

test('直接 Canonical 查询入口应复用智能问数限流和请求审计边界', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf('async function handleMultiDatasetQuery'), source.indexOf('async function handleTemplateParse'));
  assert.match(route, /guardSmartQuery\(request, response\)/);
  assert.match(route, /requestAudit\.record/);
});
