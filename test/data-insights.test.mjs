import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeInsightInput, InsightInputError } from '../lib/data-insights/insight-input.mjs';
import { DataInsightStore } from '../lib/data-insights/insight-store.mjs';
import { adaptWynQueryResult, WynQueryInsightAdapter } from '../lib/data-insights/wyn-query-adapter.mjs';
import { adaptIndependentQueryResult, IndependentQueryInsightAdapter } from '../lib/data-insights/independent-query-adapter.mjs';
import { buildInsightDocumentExport } from '../insight-document-export.mjs';

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

test('独立问数适配器把本轮标准结果和上下文注册为 InsightInput v1', () => {
  const adapted = adaptIndependentQueryResult({
    conversationId: 'conversation-12345678',
    turnId: 'turn-12345678',
    traceId: 'trace-12345678',
    question: '2025 年各区域销售额',
    conversation: { datasets: [{ id: 'dataset-sales', name: '销售数据', revision: 3 }], insightDocumentId: 'doc-12345678' },
    response: {
      status: 'ok',
      analysisMethod: { id: 'controlled-semantic-parser' },
      document: { scope: { accuracy: 'exact', isSample: false, isTruncated: false }, evidence: [{ id: 'ev-1', value: 120 }] },
      resultSets: [{
        id: 'rs-sales',
        requestId: 'private-query-id',
        schema: [{ name: 'region', type: 'string', role: 'dimension', sourceField: '区域' }, { name: 'revenue', type: 'number', role: 'measure', displayName: '销售额', aggregation: 'sum' }],
        rows: [{ region: '华东', revenue: 120 }],
        statistics: { nullCounts: { region: 0, revenue: 0 }, minimums: { revenue: 120 }, maximums: { revenue: 120 } },
        quality: { isSample: false, isTruncated: false, isEstimated: false, warnings: [] },
      }],
    },
  });
  assert.equal(adapted.schema, 'wynai.insight-input/v1');
  assert.equal(adapted.source.type, 'independent-query');
  assert.equal(adapted.source.sourceId, 'conversation-12345678:turn-12345678');
  assert.equal(adapted.context.question, '2025 年各区域销售额');
  assert.deepEqual(adapted.resultSets[0].schema[1], { name: '销售额', type: 'number', role: 'measure', displayName: '销售额', aggregation: 'sum' });
  assert.deepEqual(adapted.resultSets[0].rows, [{ 区域: '华东', 销售额: 120 }]);
  assert.deepEqual(adapted.resultSets[0].statistics.nullCounts, { 区域: 0, 销售额: 0 });
  assert.doesNotThrow(() => normalizeInsightInput(adapted));
});

test('独立问数适配器不为澄清或空结果注册数据洞察，并按本轮幂等', () => {
  assert.equal(adaptIndependentQueryResult({ conversationId: 'conversation-12345678', turnId: 'turn-1', response: { status: 'needs_clarification', resultSets: [] } }), null);
  const store = new DataInsightStore({ idFactory: () => 'ins-independent-1' });
  const adapter = new IndependentQueryInsightAdapter({ register: value => store.register(value).record });
  const turn = {
    conversationId: 'conversation-12345678', turnId: 'turn-2', question: '总销售额是多少？',
    conversation: { dataset: { id: 'dataset-sales' } },
    response: { status: 'ok', document: { title: '总销售额', scope: { accuracy: 'exact' } }, resultSets: [{ id: 'rs-total', schema: [{ name: '销售额', type: 'number', role: 'measure' }], rows: [{ 销售额: 100 }] }] },
  };
  const first = adapter.registerTurn(turn);
  const second = adapter.registerTurn(turn);
  assert.equal(first.insightId, second.insightId);
  assert.equal(store.list().length, 1);
});

test('独立问数回答只在有 insightId 时呈现数据洞察入口', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /data-action="open-smart-insight"/);
  assert.match(app, /payload\.response\?\.dataInsight/);
  assert.match(app, /openInsightById\(insightButton\.dataset\.insightId\)/);
});

test('数据洞察预览依据 InsightInput Schema 保持问数展示格式', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const schemaMap = new Map\(\(primaryResultSet\.schema \|\| \[\]\)\.map/);
  assert.match(app, /field\.grain === 'year'/);
  assert.match(app, /field\.format === 'percentage'/);
  assert.match(app, /compactValue\(row\[column\], schemaMap\.get\(column\), timeZone\)/);
});

test('数据洞察前端对失败结果不展示确定性基础洞察', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /data\.status === 'failed'/);
  assert.doesNotMatch(app, /已返回基础洞察/);
});

test('失败重试清空当前洞察但保留历史版本', async () => {
  const store = new DataInsightStore({ idFactory: () => 'ins-retry-clear-1' });
  const created = store.register(input({ source: { type: 'test', sourceId: 'retry-clear' } }));
  await store.saveDocument(created.record.insightId, { schema: 'wynai.insight-document/v1', documentType: 'business-insight', title: '旧结果', scope: { datasetId: null, datasets: [], filters: [], timeRange: null, accuracy: 'exact', isSample: false, isTruncated: false }, blocks: [{ id: 'summary', type: 'text', content: '旧结果' }], evidence: [], nextQuestions: [] });
  const cleared = await store.clearDocument(created.record.insightId);
  assert.equal(cleared.document, null);
  assert.equal(cleared.versions.length, 1);
  assert.equal(cleared.versions[0].document.blocks[0].content, '旧结果');
});

test('历史确定性降级文档不作为当前结果暴露', async () => {
  const store = new DataInsightStore({ idFactory: () => 'ins-historical-fallback-1' });
  const created = store.register(input({ source: { type: 'test', sourceId: 'historical-fallback' } }));
  await store.saveDocument(created.record.insightId, { schema: 'wynai.insight-document/v1', documentType: 'business-insight', title: '旧基础洞察', scope: { datasetId: null, datasets: [], filters: [], timeRange: null, accuracy: 'exact', isSample: false, isTruncated: false }, blocks: [{ id: 'deterministic-warning', title: '基础洞察模式', type: 'warning', message: '历史结果' }], evidence: [], nextQuestions: [] });
  const detail = store.get(created.record.insightId);
  assert.equal(detail.document, null);
  assert.equal(detail.versions.length, 1);
});

test('InsightDocument 支持版本比较、归档恢复和统一导出', async () => {
  const store = new DataInsightStore({ idFactory: () => 'ins-version-1' });
  const created = store.register(input({ source: { type: 'test', sourceId: 'versioned' } }));
  await store.saveDocument(created.record.insightId, { schema: 'wynai.insight-document/v1', documentType: 'business-insight', title: 'v1', scope: { datasetId: null, datasets: [], filters: [], timeRange: null, accuracy: 'exact', isSample: false, isTruncated: false }, blocks: [{ id: 'summary', type: 'text', content: 'one' }], evidence: [], nextQuestions: [] });
  await store.saveDocument(created.record.insightId, { schema: 'wynai.insight-document/v1', documentType: 'business-insight', title: 'v2', scope: { datasetId: null, datasets: [], filters: [], timeRange: null, accuracy: 'exact', isSample: false, isTruncated: false }, blocks: [{ id: 'summary', type: 'text', content: 'two' }, { id: 'risk', type: 'warning', message: 'check' }], evidence: [], nextQuestions: [] });
  const comparison = store.compareVersions(created.record.insightId, 1, 2);
  assert.deepEqual(comparison.addedBlockIds, ['risk']);
  assert.deepEqual(comparison.changedBlockIds, ['summary']);
  await store.archive(created.record.insightId);
  assert.equal(store.list().length, 0);
  await store.restore(created.record.insightId);
  assert.equal(store.list().length, 1);
  const exported = buildInsightDocumentExport(store.get(created.record.insightId).document, 'markdown', { runId: 'run-1' });
  assert.match(exported.body, /# v2/);
  assert.equal(exported.filename, 'v2.md');
});
