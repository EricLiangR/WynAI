import test from 'node:test';
import assert from 'node:assert/strict';
import { InsightRunStore } from '../lib/data-insights/insight-run-store.mjs';

class MemoryPersistence {
  constructor() { this.items = new Map(); }
  async init() { return [...this.items.values()]; }
  async save(run) { this.items.set(run.id, structuredClone(run)); }
}

test('InsightRun interpret 生命周期可创建、完成、重试并持久化恢复', async () => {
  const persistence = new MemoryPersistence();
  const store = new InsightRunStore({ persistence, idFactory: () => 'ir-test-0001' });
  await store.init();
  const created = await store.create({ mode: 'interpret', insightId: 'ins-0001', question: '分析销售下降原因' });
  assert.equal(created.status, 'queued');
  await store.transition(created.id, 'planning', { plan: { mode: 'interpret' } });
  await store.transition(created.id, 'running', { toolCalls: [{ id: 'tool-1' }] });
  const completed = await store.complete(created.id, { document: { schema: 'wynai.insight-document/v1' }, evidenceIds: ['ev-1'] });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.evidenceIds[0], 'ev-1');
  const retry = await store.retry(created.id);
  assert.equal(retry.status, 'planning');
  assert.equal(retry.attempt, 2);
  const restored = new InsightRunStore({ persistence });
  await restored.init();
  assert.equal(restored.get(created.id).status, 'planning');
});

test('InsightRun explore 必须绑定数据集，非法状态转换被拒绝', async () => {
  const store = new InsightRunStore({ idFactory: () => 'ir-test-0002' });
  await assert.rejects(() => store.create({ mode: 'explore' }), /至少需要一个数据集/);
  const run = await store.create({ mode: 'explore', datasetIds: ['dataset-sales'], question: '经营诊断' });
  await assert.rejects(() => store.transition(run.id, 'completed'), /不能从 queued 转为 completed/);
});

test('InsightRun 中断可持久化并创建独立重试 attempt', async () => {
  const persistence = new MemoryPersistence();
  const store = new InsightRunStore({ persistence, idFactory: () => 'ir-test-0010' });
  await store.init();
  const run = await store.create({ mode: 'interpret', insightId: 'ins-0010', question: '中断测试' });
  await store.transition(run.id, 'planning');
  await store.transition(run.id, 'running');
  const interrupted = await store.interrupt(run.id, 'process-restart');
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.attempts.length, 1);
  assert.equal(interrupted.attempts[0].status, 'interrupted');
  assert.equal(interrupted.interruption.reason, 'process-restart');
  const retried = await store.retry(run.id);
  assert.equal(retried.status, 'planning');
  assert.equal(retried.attempt, 2);
  assert.notEqual(retried.attemptId, interrupted.attemptId);
  assert.equal(retried.attempts.length, 2);
  assert.equal(retried.attempts[0].status, 'interrupted');
  assert.equal(retried.attempts[1].status, 'planning');
});

test('InsightRun 启动恢复会将所有非终态运行标记为 interrupted', async () => {
  const store = new InsightRunStore({ idFactory: () => 'ir-test-0011' });
  const run = await store.create({ mode: 'explore', datasetIds: ['dataset-sales'], question: '恢复测试' });
  await store.transition(run.id, 'planning');
  const recovered = await store.recoverUnfinished('process-restart');
  assert.equal(recovered.length, 1);
  assert.equal(store.get(run.id).status, 'interrupted');
});
