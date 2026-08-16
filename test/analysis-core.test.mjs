import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDataset,
  buildAnalysisPlan,
  normalizeDatasetMetadata,
  selectAnalysisFields,
  toDate,
  toNumber,
} from '../lib/analysis-core.mjs';

function fixtureMetadata() {
  return normalizeDatasetMetadata(
    {
      id: 'dataset-sales',
      displayName: '销售经营数据',
      revisionNo: 7,
      docTypeExtFields: { supportChatAnalysis: true, indexed: true },
    },
    {
      Name: '销售经营数据',
      Indexed: true,
      Query: { DataSources: [{ Id: 'source-1', Name: '销售数据源', Type: 0 }], QueryParameters: [] },
      Fields: [
        { Name: '订单编号', TypeName: 'String', RawType: 'String', FieldType: 'Normal' },
        { Name: '订购日期', TypeName: 'Date', RawType: 'DateTime', FieldType: 'Normal' },
        { Name: '类别名称', TypeName: 'String', RawType: 'String', FieldType: 'Normal' },
        { Name: '客户地区', TypeName: 'String', RawType: 'String', FieldType: 'Normal' },
        { Name: '客户名称', TypeName: 'String', RawType: 'String', FieldType: 'Normal' },
        { Name: '订单金额', TypeName: 'Number', RawType: 'Double', Format: 'f2', FieldType: 'Normal' },
        { Name: '订单利润', TypeName: 'Number', RawType: 'Double', Format: 'f2', FieldType: 'Normal' },
      ],
      GroupFields: [],
      Filters: [],
      WAXExpressions: [],
      AIAssistantInfo: {
        Enabled: true,
        Description: '用于销售经营分析',
        ColumnAssistantInfos: [
          { ColumnName: '订单金额', Description: '订单金额在30万以上的就是重点客户', Synonyms: ['销售额', '成交金额'] },
        ],
      },
    },
  );
}

test('运营语义不会把类型编码和 TAT 时长误判为金额或日期', () => {
  const metadata = normalizeDatasetMetadata(
    { id: 'lab', displayName: '实验室运营', revisionNo: 1, docTypeExtFields: { indexed: true } },
    {
      Name: '实验室运营', Indexed: true,
      Fields: [
        { Name: '订单', TypeName: 'String', RawType: 'String' },
        { Name: '创建时间', TypeName: 'DateTime', RawType: 'DateTime' },
        { Name: '科室类型', TypeName: 'Number', RawType: 'Int32' },
        { Name: '总TAT', TypeName: 'Number', RawType: 'Double' },
        { Name: 'TAT是否达标', TypeName: 'Number', RawType: 'Int32' },
      ],
      AIAssistantInfo: { ColumnAssistantInfos: [
        { ColumnName: '科室类型', Description: '类型：1=院内科室 2=外部客户 3=参考实验室' },
        { ColumnName: '总TAT', Description: '总TAT时间（分钟）' },
        { ColumnName: 'TAT是否达标', Description: 'TAT是否达标：1=达标 0=不达标' },
      ] },
    },
  );
  const fields = Object.fromEntries(metadata.fields.map(field => [field.name, field]));
  assert.equal(fields.创建时间.role, 'time');
  assert.equal(fields.总TAT.role, 'measure');
  assert.equal(fields.总TAT.valueKind, 'duration');
  assert.equal(fields.TAT是否达标.role, 'measure');
  assert.equal(fields.TAT是否达标.valueKind, 'boolean');
  assert.equal(fields.科室类型.role, 'dimension');
  assert.equal(fields.科室类型.valueKind, 'categorical');
  const selected = selectAnalysisFields(metadata);
  assert.equal(selected.orderId.name, '订单');
  assert.equal(selected.primaryMeasure, null);
  assert.equal(selected.profitMeasure, null);
});

const rows = [
  { 订单编号: 'O-1', 订购日期: '2025-01-02', 类别名称: '饮料', 客户地区: '华东', 客户名称: '客户A', 订单金额: 200000, 订单利润: 40000 },
  { 订单编号: 'O-2', 订购日期: '2025-01-18', 类别名称: '饮料', 客户地区: '华东', 客户名称: '客户A', 订单金额: 160000, 订单利润: 32000 },
  { 订单编号: 'O-3', 订购日期: '2025-02-05', 类别名称: '饮料', 客户地区: '华东', 客户名称: '客户B', 订单金额: 100000, 订单利润: 10000 },
  { 订单编号: 'O-4', 订购日期: '2025-03-10', 类别名称: '点心', 客户地区: '华北', 客户名称: '客户C', 订单金额: 300000, 订单利润: 50000 },
];

test('基础类型转换只接受有效值', () => {
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toDate('2025-01-01')?.getFullYear(), 2025);
  assert.equal(toDate('invalid'), null);
});

test('数据集结构被规范化为可检索的语义目录', () => {
  const metadata = fixtureMetadata();
  assert.equal(metadata.name, '销售经营数据');
  assert.equal(metadata.fieldCount, 7);
  assert.equal(metadata.assistant.describedFieldCount, 1);
  assert.equal(metadata.assistant.synonymCount, 2);
  assert.deepEqual(metadata.roles.time, ['订购日期']);
  assert.ok(metadata.roles.measure.includes('订单金额'));
  assert.ok(metadata.roles.identifier.includes('订单编号'));
  assert.equal(metadata.fields.find(field => field.name === '订单金额').description, '订单金额在30万以上的就是重点客户');
});

test('分析字段选择遵循业务字段优先级', () => {
  const selected = selectAnalysisFields(fixtureMetadata());
  assert.equal(selected.date.name, '订购日期');
  assert.equal(selected.primaryMeasure.name, '订单金额');
  assert.equal(selected.profitMeasure.name, '订单利润');
  assert.equal(selected.category.name, '类别名称');
  assert.equal(selected.region.name, '客户地区');
  assert.equal(selected.customer.name, '客户名称');
});

test('分析计划覆盖语义、质量、指标、趋势、贡献和报告', () => {
  const plan = buildAnalysisPlan(fixtureMetadata(), '分析销售趋势');
  assert.equal(plan.steps.length, 6);
  assert.deepEqual(plan.steps.map(step => step.id), ['semantic', 'profile', 'overview', 'trend', 'drivers', 'report']);
  assert.equal(plan.selectedFields.primaryMeasure, '订单金额');
});

test('完整分析生成准确 KPI、趋势、贡献、重点客户与证据', () => {
  const result = analyzeDataset({ metadata: fixtureMetadata(), rows, goal: '全面分析销售经营情况' });
  assert.equal(result.profile.rowCount, 4);
  assert.equal(result.profile.completeness, 100);
  assert.equal(result.kpis.find(item => item.id === 'total').rawValue, 760000);
  assert.equal(result.kpis.find(item => item.id === 'orders').rawValue, 4);
  assert.equal(result.kpis.find(item => item.id === 'profit').rawValue, 132000);
  assert.equal(result.kpis.find(item => item.id === 'margin').rawValue, 132000 / 760000 * 100);
  assert.equal(result.charts.find(item => item.id === 'chart-trend').values.length, 3);
  assert.equal(result.charts.find(item => item.id === 'chart-category').labels[0], '饮料');
  assert.equal(result.charts.find(item => item.id === 'chart-region').labels[0], '华东');
  assert.match(result.insights.find(item => item.id === 'insight-key-customers').statement, /2 个客户/);
  assert.equal(result.validation.evidenceCoverage, 100);
  assert.equal(result.validation.sqlAllowed, false);
  assert.ok(result.evidence.every(item => item.queryPlan && item.method));
  assert.match(result.report.markdown, /管理摘要/);
  assert.match(result.report.markdown, /建议动作/);
});

test('WAX 聚合结果覆盖样本指标并保留质量样本边界', () => {
  const aggregates = {
    overview: { rows: [{ source_rows: 10000, total: 2000000, orders: 8000, profit: 400000, date_min: '2025-01-01', date_max: '2025-12-31' }], plan: { id: 'overview', purpose: '完整概览', queryType: 'WAX' }, durationMs: 12 },
    trend: { rows: [{ group1: '2025-01-02', value: 700000 }, { group1: '2025-01-20', value: 300000 }, { group1: '2025-02-01', value: 1000000 }], plan: { id: 'trend', purpose: '完整趋势', queryType: 'WAX' }, durationMs: 15 },
    category: { rows: [{ group1: '饮料', value: 1200000 }, { group1: '点心', value: 800000 }], plan: { id: 'category', purpose: '类别贡献', queryType: 'WAX' }, durationMs: 10 },
    region: { rows: [{ group1: '华东', value: 1500000 }, { group1: '华北', value: 500000 }], plan: { id: 'region', purpose: '区域贡献', queryType: 'WAX' }, durationMs: 10 },
    customer: { rows: [{ group1: '客户A', value: 500000 }, { group1: '客户B', value: 400000 }], plan: { id: 'customer', purpose: '客户贡献', queryType: 'WAX' }, durationMs: 10 },
  };
  const result = analyzeDataset({ metadata: fixtureMetadata(), rows, aggregates, filters: [{ field: '客户地区', operator: 'eq', value: '华东' }] });
  assert.equal(result.profile.rowCount, 10000);
  assert.equal(result.profile.sampleRowCount, 4);
  assert.equal(result.kpis.find(item => item.id === 'total').rawValue, 2000000);
  assert.equal(result.kpis.find(item => item.id === 'orders').rawValue, 8000);
  assert.deepEqual(result.charts.find(item => item.id === 'chart-trend').labels, ['2025-01', '2025-02']);
  assert.equal(result.charts.find(item => item.id === 'chart-category').labels[0], '饮料');
  assert.equal(result.validation.queryMode, 'dataset-wax-controlled');
  assert.match(result.evidence.find(item => item.id === 'ev-total').method, /WAX/);
  assert.match(result.report.markdown, /分析范围：10000 行/);
  assert.match(result.report.markdown, /客户地区 eq 华东/);
});

test('空数据仍然返回可展示的质量证据和报告', () => {
  const result = analyzeDataset({ metadata: fixtureMetadata(), rows: [], goal: '检查数据质量' });
  assert.equal(result.profile.rowCount, 0);
  assert.equal(result.profile.completeness, 0);
  assert.equal(result.charts.length, 0);
  assert.ok(result.evidence.some(item => item.id === 'ev-quality'));
  assert.equal(result.validation.evidenceCoverage, 100);
  assert.match(result.report.markdown, /质量样本：0 行/);
});
