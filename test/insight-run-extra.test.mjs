import test from 'node:test';
import assert from 'node:assert/strict';
import { InsightRunStore } from '../lib/data-insights/insight-run-store.mjs';

test('InsightRun 保存父运行关联', async () => {
  const store = new InsightRunStore({ idFactory: () => 'ir-test-0003' });
  const run = await store.create({ mode: 'explore', datasetIds: ['dataset-sales'], parentRunId: 'ir-parent-0001' });
  assert.equal(run.parentRunId, 'ir-parent-0001');
});
