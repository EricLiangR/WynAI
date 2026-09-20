import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { composeQuestionDocument, planBusinessQuestion, planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';
import { SmartQueryConversationStore } from '../lib/conversation/session.mjs';
import { applyQueryProgram } from '../lib/query/query-program.mjs';
import { decideVisualization } from '../lib/visualization/visualization-spec.mjs';

const metadata = {
  id: 'dataset-composition-sales', revision: 12, name: '销售数据', indexed: true,
  fields: [
    { name: '订购日期', role: 'time', type: 'Date', rawType: 'DateTime' },
    { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单利润', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '客户地区', role: 'geography', type: 'String', rawType: 'String' },
  ],
};
const now = new Date('2026-08-27T08:00:00+08:00');

function rawResult(request, rows) {
  return {
    id: 'rs-composition', requestId: request.id,
    schema: [
      ...request.select.map(item => ({ name: item.alias, sourceField: item.field, displayName: item.field, role: 'dimension', type: item.grain ? 'date' : 'string', grain: item.grain || null })),
      ...request.measures.map(item => ({ name: item.alias, sourceField: item.field, displayName: item.field, role: 'measure', type: 'number', aggregation: item.aggregation })),
    ],
    rows,
    statistics: { rowCount: rows.length, totalRowCount: rows.length },
    resultContract: {
      schema: 'wynai.query-result-contract/v1', version: 1, type: 'wyn-complete-aggregate-result',
      issuedBy: 'wyn-query-adapter', aggregate: true, isComplete: true, isSample: false,
      isTruncated: false, isEstimated: false, userLimitApplied: false,
      totalRowCount: rows.length, returnedRowCount: rows.length, countVerified: true,
    },
    quality: { isSample: false, isTruncated: false, warnings: [] },
  };
}

test('构成占比在首次提问中生成受控派生指标并隐藏内部基数指标', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年各地区销售额的占比', now });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.derivedMetrics[0].type, 'share-of-total');
  assert.equal(plan.intent.derivedMetrics[0].sourceAlias, 'revenue');
  assert.equal(plan.intent.derivedMetrics[0].shareDimensionAlias, 'region');
  assert.deepEqual(plan.intent.derivedMetrics[0].partitionBy, []);
  assert.deepEqual(plan.displayRequest.measures.map(item => item.alias), ['revenue', 'revenue_share']);
  assert.deepEqual(plan.request.measures.map(item => item.alias), ['revenue']);

  const output = applyQueryProgram(rawResult(plan.request, [
    { region: '华东', revenue: 50 },
    { region: '华南', revenue: 30 },
    { region: '华北', revenue: 20 },
  ]), plan.queryProgram);
  assert.deepEqual(output.rows.map(row => row.revenue_share), [0.5, 0.3, 0.2]);
  assert.equal(output.rows.reduce((sum, row) => sum + row.revenue_share, 0), 1);
  assert.equal(output.schema.some(column => column.name === 'revenue'), true);
  assert.equal(output.schema.find(column => column.name === 'revenue_share').format, 'percentage');
});

test('多期间构成占比按其余维度分区，每个年份分别合计为 100%', () => {
  const plan = planBusinessQuestion({ metadata, question: '过去两年，每年各地区销售额占比', now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.derivedMetrics[0].partitionBy, ['period']);
  const output = applyQueryProgram(rawResult(plan.request, [
    { period: '2024-01-01T00:00:00.000Z', region: '华东', revenue: 60 },
    { period: '2024-01-01T00:00:00.000Z', region: '华南', revenue: 40 },
    { period: '2025-01-01T00:00:00.000Z', region: '华东', revenue: 30 },
    { period: '2025-01-01T00:00:00.000Z', region: '华南', revenue: 70 },
  ]), plan.queryProgram);
  const sums = new Map();
  for (const row of output.rows) sums.set(row.period.slice(0, 4), (sums.get(row.period.slice(0, 4)) || 0) + row.revenue_share);
  assert.deepEqual([...sums.entries()], [['2024', 1], ['2025', 1]]);
});

test('未知公式指标的澄清引用真实术语，不再默认描述为同比', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年各地区销售额和成交转化率', now });
  assert.equal(plan.status, 'needs_clarification');
  assert.match(plan.clarification, /成交转化率/);
  assert.doesNotMatch(plan.clarification, /同比|环比/);
});

test('明确纠正会替换待确认意图，并在一轮内完成占比饼图', async () => {
  const events = [];
  const store = new SmartQueryConversationStore({
    loadMetadata: async () => metadata,
    runAnalysis: async () => { throw new Error('不应降级到旧分析'); },
    intentLlm: {
      enabled: true,
      async planQueryIntent({ question }) {
        return planBusinessQuestion({ metadata, question, now }).intent;
      },
    },
    executeQuery: async ({ requests }) => ({ resultSets: [rawResult(requests[0], [
      { region: '华东', revenue: 50 },
      { region: '华南', revenue: 30 },
      { region: '华北', revenue: 20 },
    ])] }),
    eventLog: { record(entry) { events.push(entry); } },
  });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: '去年各地区销售额和成交转化率' });
  assert.equal(first.response.status, 'needs_clarification');

  const correction = '你理解有问题，我的意思是用饼图展示去年各地区销售额占比分布';
  const second = await store.ask(conversation.id, { question: correction });
  assert.equal(second.response.status, 'ok');
  assert.equal(second.conversation.pendingContext, null);
  assert.equal(second.conversation.conversationState, 'ready');
  assert.equal(second.response.intentPatch.transition.mode, 'correction-replace');
  assert.equal(second.conversation.committedContext.intent.businessQuestion, correction);
  assert.deepEqual(second.conversation.committedContext.intent.derivedMetrics.map(item => item.type), ['share-of-total']);
  assert.equal(second.conversation.committedContext.intent.semanticFrame.derivedMetrics.some(item => item.alias === 'unresolved_formula_metric'), false);
  assert.ok(events.some(event => event.event === 'clarification.corrected' && event.outcome === 'success'));
  const chart = second.response.document.blocks.find(block => block.type === 'chart');
  assert.equal(chart.visualization.type, 'pie');
  assert.deepEqual(chart.visualization.encoding.measures.map(item => item.field), ['revenue']);
  assert.equal(second.response.resultSets[0].rows.reduce((sum, row) => sum + row.revenue_share, 0), 1);
});

test('占比派生类型和显式可视化意图进入版本化 Schema', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/wynai.business-query-intent.v2.schema.json', import.meta.url), 'utf8'));
  const derivedType = schema.properties.derivedMetrics.items.properties.type.enum;
  assert.ok(derivedType.includes('share-of-total'));
  assert.equal(schema.properties.visualizationIntent.properties.type.enum.includes('pie'), true);
});

test('占比字段是饼图的合法数值编码', () => {
  const request = {
    id: 'qry-share-viz', select: [{ field: '客户地区', alias: 'region' }],
    measures: [{ field: '订单金额占比', alias: 'revenue_share', aggregation: 'share-of-total', resultType: 'percentage' }],
  };
  const resultSet = {
    id: 'rs-share-viz',
    schema: [
      { name: 'region', role: 'dimension', type: 'string' },
      { name: 'revenue_share', role: 'derived-measure', type: 'number', aggregation: 'share-of-total', format: 'percentage' },
    ],
    rows: [{ region: '华东', revenue_share: 0.5 }, { region: '华南', revenue_share: 0.3 }, { region: '华北', revenue_share: 0.2 }],
    quality: { isSample: false, isTruncated: false },
  };
  const visualization = decideVisualization({ question: '用饼图展示各地区销售额占比分布', request, resultSet });
  assert.equal(visualization.spec.type, 'pie');
  assert.deepEqual(visualization.spec.encoding.measures.map(item => item.field), ['revenue_share']);
});

test('回答摘要使用可见指标名称，不重复追加占比后缀', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年各地区销售额的占比', now });
  const output = applyQueryProgram(rawResult(plan.request, [
    { region: '华东', revenue: 1 },
    { region: '华南', revenue: 1 },
  ]), plan.queryProgram);
  const document = composeQuestionDocument({ metadata, question: '去年各地区销售额的占比', plan, resultSet: output });
  const summary = document.blocks.find(block => block.id === 'answer-summary').content;
  assert.match(summary, /订单金额占比/);
  assert.doesNotMatch(summary, /订单金额占比、占比/);
});
