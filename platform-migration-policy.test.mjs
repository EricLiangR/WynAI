import test from 'node:test';
import assert from 'node:assert/strict';
import { createMigrationRoutingPolicy, evaluateGoldenBaselineReport, evaluateMigrationPromotion, normalizeMigrationMode } from './platform-migration-policy.mjs';

const passingGates = { automatedTests: true, contractValidation: true, goldenBaseline: true, uatEvidence: true, rollbackReady: true };
test('迁移模式未知值回退 legacy', () => { assert.equal(normalizeMigrationMode('unexpected'), 'legacy'); });
test('所有门禁通过且无阻断差异时允许 canary 晋级', () => { const result = evaluateMigrationPromotion({ mode: 'canary', gates: passingGates }); assert.equal(result.canPromote, true); assert.equal(result.rollbackMode, 'legacy'); });
test('核心差异或 P1 缺陷阻断 platform 晋级并保留回滚模式', () => { const result = evaluateMigrationPromotion({ mode: 'platform', gates: passingGates, comparisons: [{ passed: false, differences: [{ blocking: true, kind: 'numeric-results' }] }], openDefects: [{ severity: 'P1' }] }); assert.equal(result.canPromote, false); assert.equal(result.rollbackMode, 'legacy'); assert.equal(result.blockingComparisonCount, 1); assert.equal(result.blockingDefectCount, 1); });

test('迁移路由按模块、主体和比例确定性灰度，未命中回到 legacy', () => {
  const policy = createMigrationRoutingPolicy({ defaultMode: 'legacy', moduleModes: { 'smart-query-request': 'canary' }, percentage: 0, users: ['user-allow'] });
  const allow = policy.resolve({ module: 'smart-query-request', identity: { userId: 'user-allow', organizationId: 'org-1' } });
  const outside = policy.resolve({ module: 'smart-query-request', identity: { userId: 'user-other', organizationId: 'org-1' } });
  assert.equal(allow.mode, 'canary');
  assert.equal(allow.reason, 'allow-list');
  assert.equal(outside.mode, 'legacy');
  assert.equal(outside.reason, 'outside-rollout');
});

test('迁移路由百分比在同一主体上稳定且不暴露主体名单', () => {
  const policy = createMigrationRoutingPolicy({ defaultMode: 'shadow', percentage: 50, salt: 'test-salt', users: ['u-1'] });
  const first = policy.resolve({ module: 'data-insight-input', identity: { userId: 'u-2', organizationId: 'o-1' } });
  const second = policy.resolve({ module: 'data-insight-input', identity: { userId: 'u-2', organizationId: 'o-1' } });
  assert.deepEqual(first, second);
  assert.equal(policy.snapshot().allowListConfigured.users, true);
  assert.equal(Object.hasOwn(policy.snapshot(), 'users'), false);
});

test('黄金基线报告必须逐用例证明比较、生命周期和真实生成均通过', () => {
  const report = {
    schema: 'wynai.platform-golden-uat/v1',
    summary: { total: 2 },
    results: [
      { id: 'DI-GOLD-001', comparison: { passed: true, differenceCount: 0 }, lifecycle: { valid: true, openAttempts: 0 }, generate: { status: 'completed', provider: 'llm-orchestrated' } },
      { id: 'DI-GOLD-002', comparison: { passed: true, differenceCount: 0 }, lifecycle: { valid: true, openAttempts: 0 }, generate: { status: 'completed-partial', provider: 'llm-orchestrated' } },
    ],
  };
  assert.equal(evaluateGoldenBaselineReport(report, { requiredCaseIds: ['DI-GOLD-001', 'DI-GOLD-002'] }).passed, true);
  assert.equal(evaluateGoldenBaselineReport({ ...report, results: [{ ...report.results[0], comparison: { passed: false, differenceCount: 1 } }], summary: { total: 1 } }, { requiredCaseIds: ['DI-GOLD-001', 'DI-GOLD-002'] }).passed, false);
});

test('发布门禁使用黄金报告结果覆盖手工 goldenBaseline 标志', () => {
  const report = { schema: 'wynai.platform-golden-uat/v1', summary: { total: 1 }, results: [{ id: 'case-1', comparison: { passed: false, differenceCount: 1 }, lifecycle: { valid: true, openAttempts: 0 }, generate: { status: 'completed', provider: 'llm-orchestrated' } }] };
  const decision = evaluateMigrationPromotion({ mode: 'canary', gates: passingGates, goldenReport: report, goldenCaseIds: ['case-1'] });
  assert.equal(decision.canPromote, false);
  assert.equal(decision.goldenBaseline.passed, false);
  assert.ok(decision.reasons.some(reason => reason.includes('goldenBaseline')));
});
