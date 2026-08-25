import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeInsightInput, InsightInputError } from '../lib/data-insights/insight-input.mjs';
import { DataInsightStore } from '../lib/data-insights/insight-store.mjs';
import { adaptWynQueryResult, WynQueryInsightAdapter } from '../lib/data-insights/wyn-query-adapter.mjs';

function input(overrides = {}) {
  return { schema: 'wynai.insight-input/v1', title: '区域销售额', resultSets: [{ id: 'regional-sales', schema: [{ name: '区域', type: 'string', role: 'dimension' }, { name: '销售额', type: 'number', role: 'measure' }], rows: [{ 区域: '华东', 销售额: 100 }, { 区域: '华南', 销售额: 80 }] }], ...overrides };
}

test('InsightInput v1 JSON Schema 与运行时协议版本一致', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/wynai.insight-input.v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schema.const, 'wynai.insight-input/v1');
  assert.deepEqual(schema.required, ['schema', 'title', 'resultSets']);
});

test('InsightInput v1 规范化并补齐未知质量范围', () => {
  const normalized = normalizeInsightInput(input());
  assert.equal(normalized.schema, 'wynai.insight-input/v1');
  assert.equal(normalized.scope.coverage, 'unknown');
  assert.equal(normalized.quality.accuracy, 'unknown');
  assert.equal(normalized.resultSets[0].quality.accuracy, 'unknown');
});

test('InsightInput v1 拒绝 Schema 与行字段或类型不一致', () => {
  assert.throws(() => normalizeInsightInput(input({ resultSets: [{ id: 'bad', schema: [{ name: '销售额', type: 'number' }], rows: [{ 其他字段: 1 }] }] })), error => error instanceof InsightInputError && error.code === 'ROW_SCHEMA_MISMATCH');
  assert.throws(() => normalizeInsightInput(input({ resultSets: [{ id: 'bad', schema: [{ name: '销售额', type: 'number' }], rows: [{ 销售额: '100' }] }] })), error => error instanceof InsightInputError && error.code === 'ROW_TYPE_MISMATCH');
});

test('DataInsightStore 以 source.type/sourceId 幂等更新并返回 insightId', () => {
  const store = new DataInsightStore({ idFactory: (() => { let index = 0; return () => `ins-test-${++index}`; })() });
  const first = store.register(input({ source: { type: 'wyn-query', sourceId: 'view-1' } }));
  const second = store.register(input({ title: '更新后的区域销售额', source: { type: 'wyn-query', sourceId: 'view-1' } }));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.record.insightId, first.record.insightId);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(first.record.insightId).input.title, '更新后的区域销售额');
});

test('Wyn 适配器只把私有聚合结构转换后注册标准输入', () => {
  const record = { viewId: 'view-12345678', topic: '区域销售', datasetId: 'dataset-1', aggregationResult: { resultSet: { rows: [{ 区域: '华东', 销售额: 120 }], columns: ['区域', '销售额'] } } };
  const adapted = adaptWynQueryResult(record, { chart: { query: { name: '区域销售' } } });
  assert.equal(adapted.schema, 'wynai.insight-input/v1');
  assert.equal(adapted.source.type, 'wyn-query');
  assert.equal(adapted.source.sourceId, record.viewId);
  assert.deepEqual(adapted.resultSets[0].rows, [{ 区域: '华东', 销售额: 120 }]);
  const registered = [];
  const adapter = new WynQueryInsightAdapter({ register: value => { registered.push(value); return value; } });
  adapter.capture(record.viewId, { aggregationResult: record.aggregationResult, topic: record.topic, datasetId: record.datasetId });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].source.sourceId, record.viewId);
});
