import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformMigrationRuntime } from './platform-migration-runtime.mjs';

test('迁移运行时支持请求级路由并在事件中记录路由决策', async () => {
  const events = [];
  const runtime = createPlatformMigrationRuntime({ mode: 'legacy', resolveMode: () => ({ mode: 'canary', reason: 'allow-list' }), onEvent: event => events.push(event) });
  const result = await runtime.run({ module: 'smart-query-request', legacy: async () => ({ path: 'legacy' }), candidate: async () => ({ path: 'candidate' }) });
  assert.equal(result.mode, 'canary');
  assert.equal(result.result.path, 'candidate');
  assert.equal(result.routing.reason, 'allow-list');
  assert.equal(events[0].routing.reason, 'allow-list');
});

test('legacy 只执行旧路径并保持用户结果', async () => {
  const calls = [];
  const runtime = createPlatformMigrationRuntime({ mode: 'legacy', onEvent: event => calls.push(event) });
  const result = await runtime.run({ module: 'data-insight-input', input: { value: 1 }, legacy: async input => ({ value: input.value }), candidate: async () => ({ value: 2 }) });
  assert.deepEqual(result.result, { value: 1 });
  assert.equal(calls[0].event, 'migration.legacy');
});

test('shadow 先执行旧路径再执行候选路径，返回旧结果并记录阻断差异', async () => {
  const events = [];
  const runtime = createPlatformMigrationRuntime({ mode: 'shadow', onEvent: event => events.push(event) });
  const result = await runtime.run({ module: 'data-insight-input', legacy: async () => ({ value: 1 }), candidate: async () => ({ value: 2 }), snapshot: value => ({ numericResults: value.value }) });
  assert.equal(result.result.value, 1);
  assert.equal(result.comparison.passed, false);
  assert.equal(result.comparison.differences[0].kind, 'numeric-results');
  assert.equal(events[0].outcome, 'blocked');
});

test('shadow 顺序执行避免相同请求并发穿透缓存', async () => {
  const calls = [];
  const runtime = createPlatformMigrationRuntime({ mode: 'shadow' });
  await runtime.run({
    module: 'data-insight-orchestration',
    legacy: async () => { calls.push('legacy-start'); await new Promise(resolve => setTimeout(resolve, 5)); calls.push('legacy-end'); return { value: 1 }; },
    candidate: async () => { calls.push('candidate'); return { value: 1 }; },
    snapshot: value => ({ numericResults: value.value }),
  });
  assert.deepEqual(calls, ['legacy-start', 'legacy-end', 'candidate']);
});

test('迁移运行时暴露候选业务编排元数据但不改变返回结果', async () => {
  const runtime = createPlatformMigrationRuntime({ mode: 'shadow' });
  const result = await runtime.run({
    module: 'data-insight-orchestration',
    legacy: async () => ({ status: 'completed', structured: { value: 1 } }),
    candidate: async () => ({ status: 'completed', structured: { value: 1 }, orchestration: { platformCandidate: { profile: 'candidate-v1' } } }),
    snapshot: value => ({ terminalStatus: value.status }),
  });
  assert.equal(result.result.structured.value, 1);
  assert.equal(result.candidateMetadata.profile, 'candidate-v1');
});

test('shadow 候选路径失败不影响旧路径结果', async () => {
  const events = [];
  const runtime = createPlatformMigrationRuntime({ mode: 'shadow', onEvent: event => events.push(event) });
  const result = await runtime.run({ module: 'data-insight-input', legacy: async () => ({ value: 1 }), candidate: async () => { throw Object.assign(new Error('candidate down'), { code: 'CANDIDATE_DOWN' }); } });
  assert.equal(result.result.value, 1);
  assert.equal(result.candidate, null);
  assert.equal(result.candidateError.code, 'CANDIDATE_DOWN');
  assert.equal(events[0].outcome, 'candidate-failed');
});

test('canary 候选失败回退 legacy，platform 候选失败直接失败', async () => {
  const canary = createPlatformMigrationRuntime({ mode: 'canary' });
  const fallback = await canary.run({ module: 'smart-query', legacy: async () => ({ status: 'ok' }), candidate: async () => { throw Object.assign(new Error('candidate down'), { code: 'CANDIDATE_DOWN' }); } });
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.result.status, 'ok');

  const platform = createPlatformMigrationRuntime({ mode: 'platform' });
  await assert.rejects(() => platform.run({ module: 'smart-query', legacy: async () => ({ status: 'ok' }), candidate: async () => { throw Object.assign(new Error('candidate down'), { code: 'CANDIDATE_DOWN' }); } }), /candidate down/);
});
