import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAIInteractionRequest, normalizeAIInteractionResponse, normalizeBusinessQueryIntent, normalizeInsightDocument } from '../lib/protocol/interaction-contract.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

test('v1 协议 JSON Schema 文件存在且版本标识与运行时契约一致', async () => {
  const schemaDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
  const files = [
    ['wynai.ai-interaction-request.v1.schema.json', 'wynai.ai-interaction-request/v1'],
    ['wynai.ai-interaction-response.v1.schema.json', 'wynai.ai-interaction-response/v1'],
    ['wynai.canonical-query-request.v1.schema.json', null],
    ['wynai.insight-document.v1.schema.json', 'wynai.insight-document/v1'],
  ];
  for (const [filename, schemaValue] of files) {
    const schema = JSON.parse(await readFile(join(schemaDirectory, filename), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(schema.$id.includes(filename));
    if (schemaValue) assert.equal(schema.properties.schema.const, schemaValue);
  }
});

test('BusinessQueryIntent v1 支持业务语言、多数据集和结果形状', () => {
  const intent = normalizeBusinessQueryIntent({ businessQuestion: '按区域统计本月销售额和完成率', datasetIds: ['dataset-sales-v1', 'dataset-target-v1'], expectedResult: { shape: 'grouped-table', fields: ['region', 'sales', 'completion_rate'] }, presentation: { targetBlockType: 'table', unit: '万元' } });
  assert.equal(intent.schema, 'wynai.business-query-intent/v1');
  assert.deepEqual(intent.datasets.map(item => item.id), ['dataset-sales-v1', 'dataset-target-v1']);
  assert.equal(intent.expectedResult.shape, 'grouped-table');
  assert.throws(() => normalizeBusinessQueryIntent({ businessQuestion: '', datasetIds: ['dataset-sales-v1'] }), /缺少 businessQuestion/);
});

test('AIInteractionRequest v1 规范化会话上下文并拒绝原始查询', () => {
  const request = normalizeAIInteractionRequest({ datasetId: '2b445034-38fe-4350-9cab-b7684c28b5f8', question: '看趋势', context: { previousResultSetIds: ['rs-a'] }, skills: ['sales'] });
  assert.equal(request.schema, 'wynai.ai-interaction-request/v1');
  assert.deepEqual(request.context.previousResultSetIds, ['rs-a']);
  assert.throws(() => normalizeAIInteractionRequest({ datasetId: 'dataset-sales-v1', question: 'x', wax: 'EVALUATE' }), /禁止原始查询/);
});

test('AIInteractionResponse v1 只接受 Canonical 查询请求', () => {
  const response = normalizeAIInteractionResponse({ status: 'ok', intent: { name: 'trend', confidence: 1 }, queryRequests: [{ id: 'qry-trend', mode: 'aggregate', select: [], measures: [] }] });
  assert.equal(response.schema, 'wynai.ai-interaction-response/v1');
  assert.equal(response.intent.confidence, 1);
  assert.throws(() => normalizeAIInteractionResponse({ queryRequests: [{ id: 'qry-x', query: 'raw' }] }), /禁止原始查询/);
});

test('InsightDocument v1 支持 KPI、文本、图表和表格组合页面', () => {
  const document = normalizeInsightDocument({
    title: '销售分析',
    scope: { datasetId: 'dataset-sales-v1', datasets: ['dataset-sales-v1'], accuracy: 'exact' },
    blocks: [
      { id: 'kpi-total', type: 'kpi', value: 100, evidenceIds: ['ev-total'] },
      { id: 'summary', type: 'text', content: '收入稳定', evidenceIds: ['ev-total'] },
      { id: 'trend', type: 'chart', chartType: 'line', dataRef: 'rs-trend', evidenceIds: ['ev-trend'] },
      { id: 'ranking', type: 'table', dataRef: 'rs-ranking', evidenceIds: ['ev-ranking'] },
    ],
  });
  assert.equal(document.schema, 'wynai.insight-document/v1');
  assert.equal(document.blocks.length, 4);
  assert.throws(() => normalizeInsightDocument({ scope: { datasetId: 'dataset-sales-v1' }, blocks: [{ id: 'bad', type: 'unknown' }] }), /类型不受支持/);
});
