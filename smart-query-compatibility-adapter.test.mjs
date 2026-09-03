import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmartQueryCompatibilityAdapter } from './smart-query-compatibility-adapter.mjs';

test('SmartQueryAdapter 保留多轮上下文、Skill 和 Canonical 输入契约', () => {
  const adapter = createSmartQueryCompatibilityAdapter({ mode: 'shadow' });
  const result = adapter.normalizeRequest({ datasetId: 'dataset-1', conversationId: 'conv-1', question: '追加利润', messages: [{ role: 'user', content: '看销售额' }], skills: ['retail@1.3.0'], context: { activeMetrics: ['销售额'], activeDimensions: ['月份'], activeFilters: [{ field: '地区', operator: 'eq', value: '华东' }] } });
  assert.equal(result.schema, 'wynai.smart-query-adapter/v1');
  assert.equal(result.mode, 'shadow');
  assert.equal(result.request.conversationId, 'conv-1');
  assert.deepEqual(result.request.context.activeMetrics, ['销售额']);
  assert.deepEqual(result.request.skills, ['retail@1.3.0']);
});

test('SmartQueryAdapter 拒绝原始 SQL/WAX 查询字段', () => {
  const adapter = createSmartQueryCompatibilityAdapter();
  assert.throws(() => adapter.normalizeRequest({ datasetId: 'dataset-1', question: '看销售额', query: 'SELECT 1' }), /禁止原始查询字段/);
});

test('SmartQueryAdapter 保留 Canonical 响应状态和展示文档', () => {
  const adapter = createSmartQueryCompatibilityAdapter();
  const result = adapter.normalizeResponse({ status: 'needs_clarification', clarification: { question: '请选择指标', options: ['销售额', '利润'] }, queryRequests: [] });
  assert.equal(result.response.status, 'needs_clarification');
  assert.equal(result.response.clarification.options.length, 2);
});
