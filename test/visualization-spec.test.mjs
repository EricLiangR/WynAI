import test from 'node:test';
import assert from 'node:assert/strict';
import { decideVisualization, normalizeVisualizationSpec, VISUALIZATION_SPEC_SCHEMA } from '../lib/visualization/visualization-spec.mjs';
import { composeQuestionDocument } from '../lib/conversation/question-planner.mjs';

const metadata = {
  id: 'dataset-sales-viz', revision: 1, name: '销售数据',
  fields: [
    { name: '订购日期', role: 'time', type: 'Date' },
    { name: '客户地区', role: 'dimension', type: 'String' },
    { name: '员工姓名', role: 'dimension', type: 'String' },
    { name: '订单金额', role: 'measure', type: 'Number' },
    { name: '订单利润', role: 'measure', type: 'Number' },
  ],
};

function fixture({ dimensions = [{ field: '订购日期', alias: 'period', grain: 'month' }], measures = [{ field: '订单金额', alias: 'revenue', aggregation: 'sum' }], rows = [], quality = {} } = {}) {
  const request = { id: 'qry-viz', dataset: { id: metadata.id, revision: 1 }, mode: 'aggregate', select: dimensions, measures, filters: [], orderBy: [], limit: 100 };
  const schema = [
    ...dimensions.map(item => ({ name: item.alias, sourceField: item.field, displayName: item.field, role: 'dimension', type: item.grain ? 'date' : 'string', grain: item.grain || null })),
    ...measures.map(item => ({ name: item.alias, sourceField: item.field, displayName: item.field, role: 'measure', type: 'number', format: item.format || 'number' })),
  ];
  return { request, resultSet: { id: 'rs-viz', requestId: request.id, schema, rows, quality: { isSample: false, isTruncated: false, ...quality } } };
}

const monthRows = Array.from({ length: 12 }, (_, index) => ({ period: `2025-${String(index + 1).padStart(2, '0')}-01`, revenue: (index + 1) * 100 }));

test('VisualizationSpec v1 规范化并拒绝不支持的任意图表类型', () => {
  const { request, resultSet } = fixture({ rows: monthRows });
  const spec = decideVisualization({ question: '按月查看销售额', request, resultSet }).spec;
  assert.equal(spec.schema, VISUALIZATION_SPEC_SCHEMA);
  assert.equal(spec.type, 'line');
  assert.throws(() => normalizeVisualizationSpec({ type: 'custom-javascript', encoding: { category: { field: 'x' }, measures: [{ field: 'y' }] } }), /不受支持/);
});

test('时间趋势自动选择折线图，排名自动选择横向条形图', () => {
  const trend = fixture({ rows: monthRows });
  assert.equal(decideVisualization({ question: '按月查看销售额趋势', ...trend }).spec.type, 'line');
  const ranking = fixture({
    dimensions: [{ field: '员工姓名', alias: 'employee' }],
    rows: [{ employee: '李芳', revenue: 30 }, { employee: '张雪眉', revenue: 20 }, { employee: '王伟', revenue: 10 }],
  });
  ranking.request.orderBy = [{ field: 'revenue', direction: 'desc' }];
  assert.equal(decideVisualization({ question: '销售经理销售额前三名', ...ranking }).spec.type, 'bar');
});

test('构成问题在完整非负低基数数据上选择环形图', () => {
  const input = fixture({
    dimensions: [{ field: '客户地区', alias: 'region' }],
    rows: [{ region: '华东', revenue: 50 }, { region: '华南', revenue: 30 }, { region: '华北', revenue: 20 }],
  });
  const spec = decideVisualization({ question: '各地区销售额占比构成', ...input }).spec;
  assert.equal(spec.type, 'donut');
  assert.ok(spec.decision.allowedTypes.includes('pie'));
});

test('饼图遇到样本、负值或不可加指标时降级为类别图', () => {
  const input = fixture({
    dimensions: [{ field: '客户地区', alias: 'region' }],
    measures: [{ field: '订单利润', alias: 'profit', aggregation: 'average' }],
    rows: [{ region: '华东', profit: 5 }, { region: '华南', profit: -2 }],
    quality: { isSample: true },
  });
  const spec = decideVisualization({ question: '用饼图展示各地区平均利润', ...input }).spec;
  assert.equal(spec.type, 'column');
  assert.match(spec.decision.warnings.join('；'), /饼图要求/);
});

test('数值和百分比多指标时间序列自动选择双轴组合图', () => {
  const input = fixture({
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum' },
      { field: '销售额同比增长率', alias: 'revenue_yoy', aggregation: 'average', format: 'percentage' },
    ],
    rows: monthRows.map((row, index) => ({ ...row, revenue_yoy: index ? 0.05 : null })),
  });
  const spec = decideVisualization({ question: '按月查看销售额和同比增长率', ...input }).spec;
  assert.equal(spec.type, 'combo');
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue_yoy').axis, 'right');
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue_yoy').mark, 'line');
});

test('仅在结果 Schema 中出现的 derived-measure 仍参与组合图决策', () => {
  const input = fixture({ rows: monthRows.map((row, index) => ({ ...row, revenue_yoy: index ? 0.05 : null })) });
  input.resultSet.schema.push({
    name: 'revenue_yoy',
    sourceField: '订单金额',
    displayName: '销售额同比增长率',
    role: 'derived-measure',
    type: 'number',
    format: 'percentage',
  });
  const spec = decideVisualization({ question: '按月查看销售额和同比增长率', ...input }).spec;
  assert.equal(spec.type, 'combo');
  assert.equal(spec.encoding.measures.length, 2);
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue_yoy').axis, 'right');
});

test('非时间分类的混合单位组合图说明与实际图表类型一致', () => {
  const input = fixture({
    dimensions: [{ field: '客户地区', alias: 'region' }],
    rows: [
      { region: '华东', revenue: 100, revenue_yoy: 0.12 },
      { region: '华南', revenue: 80, revenue_yoy: -0.05 },
    ],
  });
  input.resultSet.schema.push({
    name: 'revenue_yoy',
    sourceField: '订单金额',
    displayName: '销售额同比增长率',
    role: 'derived-measure',
    type: 'number',
    format: 'percentage',
  });
  const spec = decideVisualization({ question: '各地区销售额和同比增长率', ...input }).spec;
  assert.equal(spec.type, 'combo');
  assert.match(spec.decision.reason, /双轴柱线组合图/);
  assert.doesNotMatch(spec.decision.reason, /柱形图适合/);
});

test('双维度根据自然语言确定分类和系列角色', () => {
  const input = fixture({
    dimensions: [
      { field: '订购日期', alias: 'period', grain: 'month' },
      { field: '客户地区', alias: 'region' },
    ],
    rows: [
      { period: '2025-01-01', region: '华东', revenue: 20 },
      { period: '2025-01-01', region: '华南', revenue: 10 },
      { period: '2025-02-01', region: '华东', revenue: 30 },
      { period: '2025-02-01', region: '华南', revenue: 15 },
    ],
  });
  const spec = decideVisualization({ question: '以月份为横轴，客户地区作为系列展示销售额', ...input }).spec;
  assert.equal(spec.encoding.category.field, 'period');
  assert.equal(spec.encoding.seriesDimension.field, 'region');
  assert.match(spec.decision.reason, /自然语言指定/);
});

test('高基数分类应用 TopN，极高基数与显式仅表格要求停止绘图', () => {
  const twentyFive = fixture({ dimensions: [{ field: '员工姓名', alias: 'employee' }], rows: Array.from({ length: 25 }, (_, index) => ({ employee: `员工${index + 1}`, revenue: 100 - index })) });
  const limited = decideVisualization({ question: '员工销售额排名', ...twentyFive }).spec;
  assert.equal(limited.type, 'bar');
  assert.equal(limited.options.categoryLimit, 20);
  const sixty = fixture({ dimensions: [{ field: '员工姓名', alias: 'employee' }], rows: Array.from({ length: 60 }, (_, index) => ({ employee: `员工${index + 1}`, revenue: index })) });
  assert.equal(decideVisualization({ question: '查看全部员工销售额', ...sixty }).spec, null);
  assert.equal(decideVisualization({ question: '不要图表，只显示表格', ...twentyFive }).spec, null);
});

test('问数文档放开单维度单指标限制并输出版本化可视化规格', () => {
  const input = fixture({
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum' },
      { field: '订单利润', alias: 'profit', aggregation: 'sum' },
    ],
    rows: monthRows.map(row => ({ ...row, profit: row.revenue * 0.2 })),
  });
  const plan = { request: input.request, intent: { ranking: null, derivedMetrics: [], semanticFrame: { time: { range: null }, accumulation: {} } }, semantic: {} };
  const document = composeQuestionDocument({ metadata, question: '按月查看销售额和利润', plan, resultSet: input.resultSet });
  const chart = document.blocks.find(block => block.type === 'chart');
  assert.ok(chart);
  assert.equal(chart.visualization.schema, VISUALIZATION_SPEC_SCHEMA);
  assert.equal(chart.visualization.encoding.measures.length, 2);
});
test('货币与计数指标在时间轴上自动使用双轴组合图', () => {
  const input = fixture({
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum' },
      { field: '订单利润', alias: 'profit', aggregation: 'sum' },
      { field: '订单编号', alias: 'order_count', aggregation: 'distinctCount' },
    ],
    rows: monthRows.map((row, index) => ({ ...row, profit: row.revenue * 0.2, order_count: index + 5 })),
  });
  const spec = decideVisualization({ question: '统计每年销售额、利润和订单数量', ...input }).spec;
  assert.equal(spec.type, 'combo');
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue').axis, 'left');
  assert.equal(spec.encoding.measures.find(item => item.field === 'profit').axis, 'left');
  assert.equal(spec.encoding.measures.find(item => item.field === 'order_count').axis, 'right');
  assert.equal(spec.encoding.measures.find(item => item.field === 'order_count').mark, 'line');
});