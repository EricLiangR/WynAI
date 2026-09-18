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

test('用户指定饼图遇到样本、负值或不可加指标时必须确认，不自动替换', () => {
  const input = fixture({
    dimensions: [{ field: '客户地区', alias: 'region' }],
    measures: [{ field: '订单利润', alias: 'profit', aggregation: 'average' }],
    rows: [{ region: '华东', profit: 5 }, { region: '华南', profit: -2 }],
    quality: { isSample: true },
  });
  assert.throws(() => decideVisualization({ question: '用饼图展示各地区平均利润', ...input }), { code: 'VISUALIZATION_CONFIRMATION_REQUIRED' });
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
  assert.match(spec.decision.reason, /业务语义分组/);
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

test('排名应用 TopN，较多分类启用缩放，显式仅表格要求停止绘图', () => {
  const twentyFive = fixture({ dimensions: [{ field: '员工姓名', alias: 'employee' }], rows: Array.from({ length: 25 }, (_, index) => ({ employee: `员工${index + 1}`, revenue: 100 - index })) });
  const limited = decideVisualization({ question: '员工销售额排名', ...twentyFive }).spec;
  assert.equal(limited.type, 'bar');
  assert.equal(limited.options.categoryLimit, 20);
  const sixty = fixture({ dimensions: [{ field: '员工姓名', alias: 'employee' }], rows: Array.from({ length: 60 }, (_, index) => ({ employee: `员工${index + 1}`, revenue: index })) });
  const zoomed = decideVisualization({ question: '查看全部员工销售额', ...sixty }).spec;
  assert.equal(zoomed.options.categoryLimit, 0);
  assert.equal(zoomed.options.dataZoom, true);
  assert.equal(decideVisualization({ question: '不要图表，只显示表格', ...twentyFive }).spec, null);
});

test('三个可见维度使用分面保留分组层次', () => {
  const input = fixture({
    dimensions: [
      { field: '订购日期', alias: 'period', grain: 'month' },
      { field: '客户地区', alias: 'region' },
      { field: '员工姓名', alias: 'employee' },
    ],
    rows: [{ period: '2025-01-01', region: '华东', employee: '甲', revenue: 10 }],
  });
  const decision = decideVisualization({ question: '按月、地区和员工分析销售额', ...input });
  assert.equal(decision.spec.encoding.category.field, 'period');
  assert.equal(decision.spec.encoding.seriesDimension.field, 'region');
  assert.equal(decision.spec.encoding.facetDimension.field, 'employee');
});

test('超过三个指标时保留表格，三个指标仍允许图表', () => {
  const three = fixture({
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum' },
      { field: '订单利润', alias: 'profit', aggregation: 'sum' },
      { field: '订单编号', alias: 'orders', aggregation: 'countRows' },
    ],
    rows: monthRows.map(row => ({ ...row, profit: row.revenue * 0.2, orders: 2 })),
  });
  assert.ok(decideVisualization({ question: '按月分析销售额、利润和订单数', ...three }).spec);

  const four = fixture({
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum' },
      { field: '订单利润', alias: 'profit', aggregation: 'sum' },
      { field: '订单编号', alias: 'orders', aggregation: 'countRows' },
      { field: '客单价', alias: 'aov', aggregation: 'average' },
    ],
    rows: monthRows.map(row => ({ ...row, profit: row.revenue * 0.2, orders: 2, aov: 20 })),
  });
  const decision = decideVisualization({ question: '按月分析销售额、利润、订单数和客单价', ...four });
  assert.equal(decision.spec, null);
  assert.deepEqual(decision.decision.warnings, ['measure-count-exceeded']);
  assert.match(decision.decision.reason, /超过三个指标/);
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

test('组合图先按业务语义分组，不能因订单量数值更大而挤走金额组', () => {
  const input = fixture({
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum', semanticGroup: 'financial' },
      { field: '订单利润', alias: 'profit', aggregation: 'sum', semanticGroup: 'financial' },
      { field: '订单编号', alias: 'order_count', aggregation: 'distinctCount', semanticGroup: 'volume' },
    ],
    rows: monthRows.map(row => ({ ...row, revenue: 10, profit: 2, order_count: 100000 })),
  });
  const spec = decideVisualization({ question: '按月分析收入、利润和订单量', ...input }).spec;
  assert.equal(spec.type, 'combo');
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue').axis, 'left');
  assert.equal(spec.encoding.measures.find(item => item.field === 'profit').axis, 'left');
  assert.equal(spec.encoding.measures.find(item => item.field === 'order_count').axis, 'right');
  assert.match(spec.decision.reason, /业务语义分组/);
});

test('用户明确指定左右轴时优先于自动业务分组', () => {
  const input = fixture({
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum', semanticGroup: 'financial' },
      { field: '订单利润', alias: 'profit', aggregation: 'sum', semanticGroup: 'financial' },
      { field: '订单编号', alias: 'order_count', aggregation: 'distinctCount', semanticGroup: 'volume' },
    ],
    rows: monthRows.map(row => ({ ...row, revenue: 10, profit: 2, order_count: 100 })),
  });
  const spec = decideVisualization({ question: '组合图，订单金额放右轴，订单编号放左轴', ...input }).spec;
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue').axis, 'right');
  assert.equal(spec.encoding.measures.find(item => item.field === 'order_count').axis, 'left');
  assert.match(spec.decision.reason, /用户明确要求组合图及左右轴分配/);
});

test('非销售领域使用数据集提供的语义组而非销售专用规则', () => {
  const input = fixture({
    measures: [
      { field: '治疗费用', alias: 'cost', aggregation: 'sum', semanticGroup: 'clinical-finance' },
      { field: '医保支付额', alias: 'coverage', aggregation: 'sum', semanticGroup: 'clinical-finance' },
      { field: '平均住院天数', alias: 'los', aggregation: 'average', semanticGroup: 'clinical-duration' },
    ],
    rows: monthRows.map(row => ({ ...row, cost: 100, coverage: 80, los: 99999 })),
  });
  const spec = decideVisualization({ question: '按月分析治疗费用、医保支付额和平均住院天数', ...input }).spec;
  assert.equal(spec.type, 'combo');
  assert.equal(spec.encoding.measures.find(item => item.field === 'cost').axis, 'left');
  assert.equal(spec.encoding.measures.find(item => item.field === 'coverage').axis, 'left');
  assert.equal(spec.encoding.measures.find(item => item.field === 'los').axis, 'right');
});

test('混合量纲在存在地区系列时仍使用双轴组合图并保留指标编码', () => {
  const input = fixture({
    dimensions: [
      { field: '订购日期', alias: 'period', grain: 'year' },
      { field: '客户地区', alias: 'region' },
    ],
    measures: [
      { field: '订单金额', alias: 'revenue', aggregation: 'sum' },
      { field: '订单利润', alias: 'profit', aggregation: 'sum' },
      { field: '销售额同比增长率', alias: 'revenue_yoy', aggregation: 'average', format: 'percentage' },
    ],
    rows: [
      { period: '2024-01-01', region: '华东', revenue: 1000, profit: 200, revenue_yoy: 0.1 },
      { period: '2024-01-01', region: '华南', revenue: 800, profit: 160, revenue_yoy: 0.08 },
      { period: '2025-01-01', region: '华东', revenue: 1200, profit: 260, revenue_yoy: 0.2 },
      { period: '2025-01-01', region: '华南', revenue: 900, profit: 190, revenue_yoy: 0.125 },
    ],
  });
  const spec = decideVisualization({ question: '每年按地区展示销售额、利润和同比增长率', ...input }).spec;
  assert.equal(spec.type, 'combo');
  assert.equal(spec.encoding.seriesDimension.field, 'region');
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue').mark, 'bar');
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue_yoy').axis, 'right');
  assert.equal(spec.encoding.measures.find(item => item.field === 'revenue_yoy').mark, 'line');
});

test('三维结果自动形成分面编码，分面成员过多时保留表格', () => {
  const input = fixture({
    dimensions: [
      { field: '订购日期', alias: 'period', grain: 'year' },
      { field: '客户地区', alias: 'region' },
      { field: '员工姓名', alias: 'employee' },
    ],
    rows: [
      { period: '2025-01-01', region: '华东', employee: '甲', revenue: 10 },
      { period: '2025-01-01', region: '华南', employee: '甲', revenue: 8 },
      { period: '2025-01-01', region: '华东', employee: '乙', revenue: 7 },
    ],
  });
  const spec = decideVisualization({ question: '按年、地区和员工分别展示销售额', ...input }).spec;
  assert.equal(spec.encoding.category.field, 'period');
  assert.ok(spec.encoding.seriesDimension);
  assert.ok(spec.encoding.facetDimension);
  const crowded = fixture({
    dimensions: input.request.select,
    rows: Array.from({ length: 9 }, (_, index) => ({ period: '2025-01-01', region: '华东', employee: `员工${index}`, revenue: index + 1 })),
  });
  assert.equal(decideVisualization({ question: '按年、地区和员工分别展示销售额', ...crowded }).spec, null);
});

test('分类基数超过 24 时启用 dataZoom，用户显式图表类型优先保留', () => {
  const input = fixture({
    dimensions: [{ field: '员工姓名', alias: 'employee' }],
    rows: Array.from({ length: 30 }, (_, index) => ({ employee: `员工${index + 1}`, revenue: 100 - index })),
  });
  const automatic = decideVisualization({ question: '查看全部员工销售额', ...input }).spec;
  assert.equal(automatic.type, 'bar');
  assert.equal(automatic.options.dataZoom, true);
  const explicit = decideVisualization({ question: '希望展示为柱形图，查看员工销售额', ...input }).spec;
  assert.equal(explicit.type, 'column');
  assert.equal(explicit.decision.source, 'user');
});
