import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResultPresentationPlan } from '../lib/result-presentation-plan.mjs';
import { planBusinessQuestion } from '../lib/conversation/question-planner.mjs';
import { applyQueryProgram } from '../lib/query/query-program.mjs';

const metadata = { id: 'dataset-presentation', revision: 1, indexed: true, fields: [
  { name: '订购日期', role: 'time', type: 'Date' },
  { name: '订单金额', role: 'measure', type: 'Number' },
  { name: '订单利润', role: 'measure', type: 'Number' },
  { name: '客户地区', role: 'geography', type: 'String' },
] };
function result(id, rows, schema = [{ name: 'region', role: 'dimension', type: 'string' }, { name: 'revenue', role: 'measure', type: 'number', aggregation: 'sum' }]) { return { id, schema, rows, quality: { isSample: false, isTruncated: false }, statistics: { totalRowCount: rows.length } }; }

test('ResultPresentationPlan v1 将单值时间筛选从可见维度中排除', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年各地区销售额', now: new Date('2026-08-27') });
  const output = applyQueryProgram(result('rs-presentation-scope', [{ region: '华东', revenue: 10 }], [{ name: 'region', role: 'dimension', type: 'string' }, { name: 'revenue', role: 'measure', type: 'number' }]), plan.queryProgram);
  const presentation = buildResultPresentationPlan({ metadata, question: '去年各地区销售额', request: plan.request, resultSet: output });
  assert.equal(presentation.schema, 'wynai.result-presentation-plan/v1');
  assert.deepEqual(presentation.queryProjection.visibleDimensions, ['region']);
  assert.equal(presentation.dimensions.some(item => item.temporal && item.visible), false);
});

test('ResultPresentationPlan 保留占比原始指标和派生指标，饼图绑定原始值', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年各地区销售额的占比', now: new Date('2026-08-27') });
  const output = applyQueryProgram(result('rs-presentation-share', [{ region: '华东', revenue: 60 }, { region: '华南', revenue: 40 }]), plan.queryProgram);
  const presentation = buildResultPresentationPlan({ metadata, question: '去年各地区销售额的占比', request: plan.request, resultSet: output });
  assert.deepEqual(presentation.table.columns, ['region', 'revenue', 'revenue_share']);
  assert.equal(presentation.chart.visualization.type, 'donut');
  assert.deepEqual(presentation.chart.visualization.encoding.measures.map(item => item.field), ['revenue']);
  assert.equal(presentation.mode, 'chart-and-table');
});

test('ResultPresentationPlan 对高基数结果只保留表格', () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({ region: `区域${index}`, revenue: index + 1 }));
  const presentation = buildResultPresentationPlan({ metadata, question: '各地区销售额', request: { select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', alias: 'revenue', aggregation: 'sum' }] }, resultSet: result('rs-presentation-large', rows) });
  assert.equal(presentation.mode, 'table-only');
  assert.equal(presentation.table.preserveAllReturnedRows, true);
});

test('投影中的数值字段即使保留 measure 角色也只展示一次', () => {
  const request = {
    mode: 'projection',
    select: [
      { field: '客户地区', alias: 'region', role: 'geography' },
      { field: '订单金额', alias: 'revenue', role: 'measure' },
    ],
    measures: [],
    expectedResult: { requiredDimensions: ['region', 'revenue'] },
  };
  const resultSet = result('rs-projection-measure', [{ region: '华东', revenue: 300 }]);
  const presentation = buildResultPresentationPlan({ metadata, question: '返回客户地区和订单金额', request, resultSet });
  assert.deepEqual(presentation.table.columns, ['region', 'revenue']);
});

test('产品销量不扩展为商品名称维度，时间和地理维度按用户顺序与层级展示', () => {
  const salesMetadata = { id: 'dataset-order', revision: 1, fields: [
    { name: '订购日期', role: 'time', type: 'Date' },
    { name: '订单金额', role: 'measure', type: 'Number' },
    { name: '订单利润', role: 'measure', type: 'Number' },
    { name: '订单编号', role: 'identifier', type: 'String' },
    { name: '购买数量', role: 'measure', type: 'Number' },
    { name: '客户地区', role: 'geography', type: 'String' },
    { name: '客户省份', role: 'geography', type: 'String' },
    { name: '商品名称', role: 'dimension', type: 'String' },
  ] };
  const question = '统计过去三年，每个月、地区、省份的销售收入、毛利润、同比增长率、订单数量、产品销量';
  const plan = planBusinessQuestion({ metadata: salesMetadata, question, now: new Date('2026-08-24T08:00:00+08:00') });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.time.grain, 'month');
  assert.deepEqual(plan.intent.dimensions.map(item => item.field), ['客户地区', '客户省份', '订购日期']);
  assert.equal(plan.intent.dimensions.some(item => item.field === '商品名称'), false);
  const schema = [
    ...plan.request.select.map(item => ({ name: item.alias, role: 'dimension', type: item.grain ? 'date' : 'string', grain: item.grain })),
    ...plan.request.measures.map(item => ({ name: item.alias, role: 'measure', type: 'number' })),
    ...plan.intent.derivedMetrics.map(item => ({ name: item.alias, role: 'derived-measure', displayName: item.source, sourceField: item.source, format: 'percentage' })),
  ];
  const resultSet = { id: 'rs-order', schema, rows: [
    { period: '2023-01-01', region: '华东', province: '山东省', revenue: 10, profit: 4, order_count: 2, quantity: 8, profit_yoy: 0.1 },
    { period: '2023-02-01', region: '华东', province: '山东省', revenue: 12, profit: 5, order_count: 3, quantity: 9, profit_yoy: 0.2 },
  ], quality: { isSample: false, isTruncated: false } };
  const presentation = buildResultPresentationPlan({ metadata: salesMetadata, question, request: plan.request, resultSet });
  assert.deepEqual(presentation.table.columns, ['period', 'region', 'province', 'revenue', 'profit', 'profit_yoy', 'order_count', 'quantity']);
});

test('各自是多少不被误读为年度分组', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年各地区的利润和利润占比各自是多少', now: new Date('2026-08-27') });
  assert.equal(plan.intent.time.groupingExplicit, false);
  assert.deepEqual(plan.request.select.map(item => item.alias), ['region']);
});
