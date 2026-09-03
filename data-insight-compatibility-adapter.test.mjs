import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataInsightCompatibilityAdapter, runDataInsightShadow } from './data-insight-compatibility-adapter.mjs';

const input = { schema: 'wynai.insight-input/v1', title: '销售额', resultSets: [{ id: 'rs-1', schema: [{ name: '销售额', type: 'number', role: 'measure' }], rows: [{ 销售额: 100 }] }] };
test('DataInsightAdapter 保持 InsightInput v1 并支持迁移模式', () => { const adapter = createDataInsightCompatibilityAdapter({ mode: 'shadow' }); const envelope = adapter.adapt(input); assert.equal(envelope.schema, 'wynai.data-insight-adapter/v1'); assert.equal(envelope.mode, 'shadow'); assert.equal(envelope.input.schema, 'wynai.insight-input/v1'); });
test('DataInsightAdapter 双跑比较器阻断核心数值差异', async () => { const result = await runDataInsightShadow({ legacy: async () => ({ value: 100 }), candidate: async () => ({ value: 101 }), legacySnapshot: item => ({ numericResults: item.value }), candidateSnapshot: item => ({ numericResults: item.value }) }); assert.equal(result.comparison.passed, false); assert.equal(result.comparison.differences[0].kind, 'numeric-results'); });
test('DataInsightAdapter 双跑比较器允许内部 trace 差异', async () => { const result = await runDataInsightShadow({ legacy: async () => ({ value: 100, traceId: 'old' }), candidate: async () => ({ value: 100, traceId: 'new' }), legacySnapshot: item => ({ numericResults: item.value }), candidateSnapshot: item => ({ numericResults: item.value }) }); assert.equal(result.comparison.passed, true); });

test('DataInsightAdapter shadow 辅助函数按基线后候选顺序执行', async () => {
  const calls = [];
  await runDataInsightShadow({
    legacy: async () => { calls.push('legacy'); return { value: 1 }; },
    candidate: async () => { calls.push('candidate'); return { value: 1 }; },
    legacySnapshot: item => ({ numericResults: item.value }),
    candidateSnapshot: item => ({ numericResults: item.value }),
  });
  assert.deepEqual(calls, ['legacy', 'candidate']);
});
