import test from 'node:test';
import assert from 'node:assert/strict';
import { planBusinessQuestion } from '../lib/conversation/question-planner.mjs';
import { applyQueryProgram } from '../lib/query/query-program.mjs';
import { SmartQueryConversationStore } from '../lib/conversation/session.mjs';
import { SkillRegistry } from '../lib/skills/skill-registry.mjs';

const fields = [
  ['订购日期', 'time', 'Date'],
  ['订单金额', 'measure', 'Number'],
  ['订单利润', 'measure', 'Number'],
  ['购买数量', 'measure', 'Number'],
  ['客户地区', 'geography', 'String'],
  ['客户省份', 'geography', 'String'],
  ['客户城市', 'geography', 'String'],
  ['商品名称', 'dimension', 'String'],
  ['员工姓名', 'dimension', 'String'],
];
const metadata = {
  id: 'dataset-advanced-sales',
  revision: 7,
  name: '销售数据',
  fields: fields.map(([name, role, type]) => ({ name, role, type, rawType: type })),
};
const now = new Date('2026-08-24T08:00:00+08:00');

function resultSet(request, rows) {
  return {
    id: 'rs-advanced',
    requestId: request.id,
    schema: [
      ...request.select.map(item => ({ name: item.alias, role: 'dimension', type: item.grain ? 'date' : 'string', grain: item.grain || null })),
      ...request.measures.map(item => ({ name: item.alias, role: 'measure', type: 'number' })),
    ],
    rows,
    statistics: {},
    quality: { isSample: false, isTruncated: false, warnings: [] },
  };
}

test('QueryProgram 按年份分别取销售额第一的省份', () => {
  const plan = planBusinessQuestion({ metadata, question: '2023、2024、2025年销售额排名第一的省份分别是哪个', now });
  assert.equal(plan.status, 'supported');
  const raw = resultSet(plan.request, [
    { province: 'A', period: '2023-01-01T00:00:00.000Z', revenue: 10 },
    { province: 'B', period: '2023-01-01T00:00:00.000Z', revenue: 30 },
    { province: 'A', period: '2024-01-01T00:00:00.000Z', revenue: 50 },
    { province: 'B', period: '2024-01-01T00:00:00.000Z', revenue: 20 },
    { province: 'A', period: '2025-01-01T00:00:00.000Z', revenue: 40 },
    { province: 'B', period: '2025-01-01T00:00:00.000Z', revenue: 60 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows.map(row => [row.period.slice(0, 4), row.province, row.revenue]), [
    ['2023', 'B', 30], ['2024', 'A', 50], ['2025', 'B', 60],
  ]);
});

test('同比查询自动扩大基期并只投影用户要求期间', () => {
  const plan = planBusinessQuestion({ metadata, question: '2023至2025年销售额和销售额同比增长率', now });
  assert.equal(plan.request.filters.find(item => item.operator === 'gte').value, '2022-01-01');
  const raw = resultSet(plan.request, [
    { period: '2022-01-01T00:00:00.000Z', revenue: 100 },
    { period: '2023-01-01T00:00:00.000Z', revenue: 120 },
    { period: '2024-01-01T00:00:00.000Z', revenue: 90 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 135 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows.map(row => row.period.slice(0, 4)), ['2023', '2024', '2025']);
  assert.deepEqual(output.rows.map(row => row.revenue_yoy), [0.2, -0.25, 0.5]);
  assert.equal(output.schema.find(column => column.name === 'revenue_yoy').format, 'percentage');
});

test('时间分组不再被误当成显式时间范围', () => {
  const plan = planBusinessQuestion({ metadata, question: '华东地区每年销售额和同比增长率', now });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.time.scopeExplicit, false);
  assert.equal(plan.intent.time.groupingExplicit, true);
  assert.equal(plan.intent.constraints.some(item => item.type === 'time-scope'), false);
});

test('澄清状态机保留 pending，受控 IntentPatch 成功后再提交', async () => {
  const skillRegistry = new SkillRegistry([{
    id: 'sales-entities',
    version: '1.0.0',
    scope: 'dataset',
    datasetIds: [metadata.id],
    status: 'approved',
    triggers: ['销售', '销售经理'],
    businessEntities: [{ id: 'salesManager', concept: 'employee', name: '销售经理', field: '员工姓名', synonyms: ['销售经理', '销售员'] }],
  }]);
  const executeQuery = async ({ requests }) => ({
    resultSets: [resultSet(requests[0], [
      { employee: '张三', revenue: 300 },
      { employee: '李四', revenue: 200 },
      { employee: '王五', revenue: 100 },
    ])],
  });
  const store = new SmartQueryConversationStore({
    loadMetadata: async () => metadata,
    runAnalysis: async () => { throw new Error('不应降级'); },
    executeQuery,
    skillRegistry,
  });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: '过去三年销售额累计排名前三的是谁' });
  assert.equal(first.response.status, 'needs_clarification');
  assert.equal(first.conversation.conversationState, 'awaiting_clarification');
  assert.equal(first.conversation.committedContext, null);
  assert.ok(first.conversation.pendingContext.unresolvedSlots.some(slot => slot.type === 'dimension'));

  const second = await store.ask(conversation.id, { question: '我是需要按照销售经理作为维度' });
  assert.equal(second.response.status, 'ok');
  assert.equal(second.response.intentPatch.schema, 'wynai.intent-patch/v1');
  assert.ok(second.response.intentPatch.operations.some(operation => operation.path === '/dimensions'));
  assert.equal(second.conversation.pendingContext, null);
  assert.equal(second.conversation.conversationState, 'ready');
  assert.equal(second.conversation.committedContext.intent.dimensions[0].field, '员工姓名');
  assert.deepEqual(second.conversation.committedContext.intent.time.periods, [2023, 2024, 2025]);
});

test('月度环比使用上月基期并保留年度内月份', () => {
  const plan = planBusinessQuestion({ metadata, question: '2025年每月销售额和环比增长率', now });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.request.filters.find(item => item.operator === 'gte').value, '2024-12-01');
  const raw = resultSet(plan.request, [
    { period: '2024-12-01T00:00:00.000Z', revenue: 100 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 120 },
    { period: '2025-02-01T00:00:00.000Z', revenue: 90 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows.map(row => row.period.slice(0, 7)), ['2025-01', '2025-02']);
  assert.deepEqual(output.rows.map(row => row.revenue_mom), [0.2, -0.25]);
});

test('月度同比使用上年同月且筛选追问保留派生指标', () => {
  const first = planBusinessQuestion({ metadata, question: '2025年每月销售额和同比增长率', now });
  assert.equal(first.request.filters.find(item => item.operator === 'gte').value, '2024-01-01');
  const raw = resultSet(first.request, [
    { period: '2024-01-01T00:00:00.000Z', revenue: 100 },
    { period: '2024-02-01T00:00:00.000Z', revenue: 200 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 150 },
    { period: '2025-02-01T00:00:00.000Z', revenue: 180 },
  ]);
  const output = applyQueryProgram(raw, first.queryProgram);
  assert.deepEqual(output.rows.map(row => row.revenue_yoy), [0.5, -0.1]);

  const second = planBusinessQuestion({
    metadata,
    question: '只看华东',
    previousIntent: first.intent,
    previousRequest: first.displayRequest,
    now,
  });
  assert.equal(second.status, 'supported');
  assert.deepEqual(second.intent.derivedMetrics.map(item => item.alias), ['revenue_yoy']);
  assert.equal(second.intent.filters.find(item => item.field === '客户地区').value, '华东');
});

test('筛选追问继承全部复合指标，派生追问继承当前指标', () => {
  const composite = planBusinessQuestion({ metadata, question: '2023至2025年销售额、利润和销售额同比增长率', now });
  const filtered = planBusinessQuestion({ metadata, question: '只看华东', previousIntent: composite.intent, previousRequest: composite.displayRequest, now });
  assert.deepEqual(filtered.intent.metrics.map(item => item.field), ['订单金额', '订单利润']);
  assert.deepEqual(filtered.intent.derivedMetrics.map(item => item.alias), ['revenue_yoy']);

  const profit = planBusinessQuestion({ metadata, question: '2025年每月利润', now });
  const yoy = planBusinessQuestion({ metadata, question: '再看同比增长率', previousIntent: profit.intent, previousRequest: profit.displayRequest, now });
  assert.equal(yoy.status, 'supported');
  assert.deepEqual(yoy.intent.derivedMetrics.map(item => item.alias), ['profit_yoy']);
});