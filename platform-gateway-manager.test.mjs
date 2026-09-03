import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformGatewayManager } from './platform-gateway-manager.mjs';

function fakeGateway({ delay = 0, value = { ok: true }, error = null } = {}) {
  return {
    enabled: true,
    async completeJson(_messages, { signal, onEvent } = {}) {
      if (delay) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delay); signal?.addEventListener('abort', () => { clearTimeout(timer); const item = new Error('aborted'); item.code = 'REQUEST_ABORTED'; reject(item); }, { once: true }); });
      await onEvent?.({ type: 'gateway.attempt', operation: 'test' });
      if (error) throw error;
      return value;
    },
    snapshot: () => ({ providers: [{ id: 'fake', open: false }], lastCall: null }),
  };
}

test('平台 Gateway Manager 为模块事件增加治理上下文并保留结果', async () => {
  const events = [];
  const manager = createPlatformGatewayManager({ gateways: { exploration: fakeGateway() }, operationBudgets: { exploration: 2_000 } });
  const result = await manager.completeJson('exploration', [{ role: 'user', content: '{}' }], { onEvent: event => events.push(event) });
  assert.deepEqual(result, { ok: true });
  assert.equal(events[0].platformGateway, 'exploration');
  assert.equal(events[0].absoluteBudgetMs, 2_000);
});

test('平台 Gateway Manager 对跨重试的绝对预算产生统一错误码', async () => {
  const manager = createPlatformGatewayManager({ gateways: { intent: fakeGateway({ delay: 1_100 }) }, operationBudgets: { intent: 1_000 } });
  await assert.rejects(() => manager.completeJson('intent', [], {}), error => error.code === 'LLM_TOTAL_DEADLINE_EXCEEDED' && error.status === 504);
});

test('平台 Gateway Manager 聚合模块快照但不合并模块操作预算', () => {
  const manager = createPlatformGatewayManager({ gateways: { exploration: fakeGateway(), intent: fakeGateway() }, operationBudgets: { exploration: 45_000, intent: 15_000 } });
  const snapshot = manager.snapshot();
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.operationBudgets.exploration, 45_000);
  assert.equal(snapshot.operationBudgets.intent, 15_000);
  assert.deepEqual(Object.keys(snapshot.operations).sort(), ['exploration', 'intent']);
});
