import test from 'node:test';
import assert from 'node:assert/strict';
import { composeQuestionDocument, planBusinessQuestion } from '../lib/conversation/question-planner.mjs';
import { composeInsightDocument } from '../lib/report/insight-document.mjs';

const metadata = {
  id: 'dataset-sales-v1', revision: 7, name: '销售数据', indexed: true,
  fields: [
    { name: '订购日期', role: 'time', type: 'Date', rawType: 'DateTime' },
    { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单利润', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '购买数量', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '类别名称', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '商品名称', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '客户地区', role: 'geography', type: 'String', rawType: 'String' },
  ],
};

test('去年销售排名前五的商品种类生成带年份、Top5 和排序的 CanonicalQueryRequest', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年销售排名前五的商品种类', now: new Date('2026-08-22T00:00:00+08:00') });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.request.select[0].field, '类别名称');
  assert.equal(plan.request.measures[0].field, '订单金额');
  assert.equal(plan.request.limit, 5);
  assert.deepEqual(plan.request.orderBy, [{ field: 'revenue', direction: 'desc' }]);
  assert.deepEqual(plan.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['订购日期', 'gte', '2025-01-01'],
    ['订购日期', 'lt', '2026-01-01'],
  ]);
});

test('绝对年份总额问题生成无分组的单值聚合查询', () => {
  const plan = planBusinessQuestion({ metadata, question: '2025年收入总额是多少' });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.request.select, []);
  assert.equal(plan.request.measures[0].field, '订单金额');
  assert.equal(plan.request.measures[0].aggregation, 'sum');
  assert.equal(plan.request.limit, 1);
  assert.equal(plan.request.filters.length, 2);
});

test('多轮追问继承查询上下文并只修改用户明确提出的部分', () => {
  const first = planBusinessQuestion({ metadata, question: '2025年收入总额是多少' });
  const profit = planBusinessQuestion({ metadata, question: '改成利润', previousRequest: first.request });
  assert.equal(profit.request.measures[0].field, '订单利润');
  assert.deepEqual(profit.request.filters, first.request.filters);
  const east = planBusinessQuestion({ metadata, question: '只看华东', previousRequest: profit.request });
  assert.equal(east.request.measures[0].field, '订单利润');
  assert.equal(east.request.measures[0].alias, 'profit');
  assert.equal(east.request.filters.find(item => item.field === '客户地区')?.value, '华东');
  const monthly = planBusinessQuestion({ metadata, question: '继续按月份', previousRequest: east.request });
  assert.equal(monthly.request.select[0].field, '订购日期');
  assert.equal(monthly.request.select[0].grain, 'month');
  assert.equal(monthly.request.measures[0].field, '订单利润');
  assert.equal(monthly.request.measures[0].alias, 'profit');
  assert.equal(monthly.request.filters.find(item => item.field === '客户地区')?.value, '华东');
});

test('内部 Planner 和适配器诊断不再显示为用户数据范围警告', () => {
  const document = composeInsightDocument({
    question: '测试问题',
    result: {
      analysis: { dataset: metadata, goal: '测试问题', report: { summary: ['完成'] }, execution: { filters: [] } },
      resultSets: [{ id: 'rs-test', requestId: 'qry-test', rows: [{ value: 1 }], schema: [{ name: 'value' }], quality: { isSample: false, isTruncated: false, warnings: ['NONE JSON 不支持服务端列裁剪'] } }],
      audit: { warnings: ['AI Planner 降级：fetch failed', '结果达到上限，可能不完整'] },
    },
  });
  const warnings = document.blocks.filter(block => block.type === 'warning').map(block => block.message);
  assert.deepEqual(warnings, ['结果达到上限，可能不完整']);
});

test('二维结果完整编码为分类和系列并同时保留明细表格', () => {
  const plan = planBusinessQuestion({ metadata: {
    ...metadata,
    fields: [...metadata.fields, { name: '客户省份', role: 'geography', type: 'String', rawType: 'String' }],
  }, question: '2023至2025每年各省销售额' });
  const document = composeQuestionDocument({
    metadata,
    question: '2023至2025每年各省销售额',
    plan,
    resultSet: {
      id: 'rs-two-dimensions',
      schema: [{ name: 'province' }, { name: 'period' }, { name: 'revenue' }],
      rows: [{ province: '浙江省', period: '2025-01-01T00:00:00.000Z', revenue: 100 }],
      quality: {},
    },
  });
  const chart = document.blocks.find(block => block.type === 'chart');
  assert.ok(chart);
  assert.equal(chart.visualization.type, 'line');
  assert.equal(chart.visualization.encoding.category.field, 'period');
  assert.equal(chart.visualization.encoding.seriesDimension.field, 'province');
  assert.equal(document.blocks.some(block => block.type === 'table'), true);
});
