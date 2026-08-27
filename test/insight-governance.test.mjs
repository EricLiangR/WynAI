import test from 'node:test';
import assert from 'node:assert/strict';
import { InsightRunStore } from '../lib/data-insights/insight-run-store.mjs';

test('InsightRun 保存父运行关联', async () => {
  const store = new InsightRunStore({ idFactory: () => 'ir-test-0003' });
  const run = await store.create({ mode: 'explore', datasetIds: ['dataset-sales'], parentRunId: 'ir-parent-0001' });
  assert.equal(run.parentRunId, 'ir-parent-0001');
});
import { InsightGovernanceService, redactInsightInput } from '../lib/data-insights/insight-governance.mjs';

test('数据洞察治理限制配额/并发并记录脱敏审计', async () => {
  const service = new InsightGovernanceService({ maxGenerations: 1, maxConcurrent: 1 });
  const release = service.beginGeneration({ actor: 'u1', organizationId: 'o1' });
  assert.throws(() => service.beginGeneration({ actor: 'u1', organizationId: 'o1' }), error => error.code === 'INSIGHT_CONCURRENCY_LIMIT');
  release();
  assert.throws(() => service.beginGeneration({ actor: 'u1', organizationId: 'o1' }), error => error.code === 'INSIGHT_QUOTA_EXCEEDED');
  const redacted = redactInsightInput({ resultSets: [{ rows: [{ phone: '138', amount: 20 }] }] }, ['phone']);
  assert.equal(redacted.input.resultSets[0].rows[0].phone, '[REDACTED]');
  const audit = service.record({ actor: 'u1', organizationId: 'o1', action: 'insight.generate', status: 'failed', prompt: 'secret prompt', stageAudit: [{ stage: 'planner', status: 'failed' }], externalDataPolicy: redacted.policy });
  assert.equal(audit.externalDataPolicy.rawRowsToLlm, false);
  assert.equal(audit.promptHash.length, 64);
  assert.equal(audit.stageAudit[0].stage, 'planner');
  assert.equal(service.list({ actor: 'u1', organizationId: 'o1' }).length, 1);
});
