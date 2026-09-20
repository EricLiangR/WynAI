import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildBusinessQueryIntent,
  compileBusinessQueryIntent,
  normalizeBusinessQueryIntentV2,
  validateIntentCoverage,
  validateResultAgainstIntent,
} from '../lib/semantics/business-query-intent.mjs';
import { parseBusinessTimeSemantics } from '../lib/semantics/time-semantics.mjs';
import { normalizeCanonicalResultSet } from '../lib/query/result-normalizer.mjs';

const metadata = {
  id: 'dataset-sales-v1', revision: 9, name: '销售数据',
  fields: [
    { name: '订购日期', role: 'time', type: 'Date', rawType: 'DateTime', description: '订单发生的业务日期' },
    { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double', description: '销售收入金额' },
    { name: '订单利润', role: 'measure', type: 'Number', rawType: 'Double', description: '订单利润' },
    { name: '类别名称', role: 'dimension', type: 'String', rawType: 'String', description: '商品所属类别' },
    { name: '客户地区', role: 'geography', type: 'String', rawType: 'String', description: '客户所在地区' },
  ],
};

test('BusinessQueryIntent v2 JSON Schema 是持久化的版本契约', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/wynai.business-query-intent.v2.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, 'wynai.business-query-intent/v2');
  assert.ok(schema.required.includes('constraints'));
  assert.ok(schema.required.includes('expectedResult'));
  assert.ok(schema.required.includes('resultFilters'));
});

test('聚合结果筛选使用指标别名并完整编译到 Canonical 请求', () => {
  const intent = normalizeBusinessQueryIntentV2({
    businessQuestion: '按类别统计总金额并筛选总金额大于1000万',
    metrics: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '类别名称', alias: 'category', concept: 'category' }],
    filters: [],
    resultFilters: [{ field: 'revenue', operator: 'gt', value: 10000000 }],
    time: { field: null, periods: [], grain: null },
    expectedResult: { shape: 'grouped-table', minimumRows: 1, maximumRows: 20000, requiredPeriods: [], requiredMetrics: ['revenue'], requiredDimensions: ['category'], timeZone: 'Asia/Shanghai' },
    constraints: [{ id: 'having-1', type: 'aggregate-result-filter', source: '总金额大于1000万', normalized: { scope: 'aggregate-result', field: 'revenue', operator: 'gt', value: 10000000 }, required: true, status: 'resolved' }],
  }, { metadata });
  assert.equal(validateIntentCoverage(intent).valid, true);
  const compiled = compileBusinessQueryIntent(metadata, intent);
  assert.equal(compiled.status, 'supported');
  assert.deepEqual(compiled.request.resultFilters, [{ field: 'revenue', operator: 'gt', value: 10000000 }]);
});

test('聚合筛选账本不能在 resultFilters 缺失或引用错误别名时静默通过', () => {
  const base = normalizeBusinessQueryIntentV2({
    businessQuestion: '按类别统计总金额并筛选总金额大于1000万',
    metrics: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '类别名称', alias: 'category', concept: 'category' }],
    filters: [], resultFilters: [], time: { field: null, periods: [], grain: null },
    expectedResult: { shape: 'grouped-table', minimumRows: 1, maximumRows: 20000, requiredPeriods: [], requiredMetrics: ['revenue'], requiredDimensions: ['category'], timeZone: 'Asia/Shanghai' },
    constraints: [{ id: 'having-1', type: 'aggregate-result-filter', source: '总金额大于1000万', normalized: { scope: 'aggregate-result', field: 'revenue', operator: 'gt', value: 10000000 }, required: true, status: 'resolved' }],
  }, { metadata });
  assert.match(validateIntentCoverage(base).errors.join('；'), /未进入可执行查询/);
  const wrong = { ...base, resultFilters: [{ field: 'unknown_metric', operator: 'gt', value: 10000000 }] };
  assert.match(validateIntentCoverage(wrong).errors.join('；'), /未引用实际指标别名/);
});

test('多年份表达统一生成按年意图、连续时间范围和必需期间', () => {
  for (const question of ['2023、2024和2025年销售额分别是多少', '2023至2025年按年看收入', '近3年销售额趋势']) {
    const intent = buildBusinessQueryIntent({ metadata, question, now: new Date('2026-08-22T08:00:00+08:00') });
    assert.deepEqual(intent.time.periods, [2023, 2024, 2025], question);
    assert.equal(intent.time.grain, 'year', question);
    assert.equal(intent.dimensions[0].grain, 'year', question);
    assert.deepEqual(intent.expectedResult.requiredPeriods, ['2023', '2024', '2025'], question);
    const compiled = compileBusinessQueryIntent(metadata, intent);
    assert.equal(compiled.status, 'supported', question);
    assert.deepEqual(compiled.request.filters.map(item => [item.operator, item.value]), [['gte', '2023-01-01'], ['lt', '2026-01-01']]);
  }
});

test('两位年份和修改式时间粒度继承同一约束账本', () => {
  const firstTime = parseBusinessTimeSemantics('23、24、25年销售额分别是多少', { now: new Date('2026-08-22T00:00:00+08:00') });
  assert.deepEqual(firstTime.periods, [2023, 2024, 2025]);
  const first = buildBusinessQueryIntent({ metadata, question: '23、24、25年销售额分别是多少', now: new Date('2026-08-22T00:00:00+08:00'), skillRefs: ['sales-definition@1.0.0'] });
  const second = buildBusinessQueryIntent({ metadata, question: '改成利润', previousIntent: first });
  assert.deepEqual(second.time.periods, [2023, 2024, 2025]);
  assert.equal(second.metrics[0].field, '订单利润');
  assert.deepEqual(second.skillRefs, ['sales-definition@1.0.0']);
  assert.equal(second.transition.inheritsPriorContext, true);
  const third = buildBusinessQueryIntent({ metadata, question: '只看华东', previousIntent: second });
  assert.deepEqual(third.time.periods, [2023, 2024, 2025]);
  assert.equal(third.time.grain, 'year');
  assert.equal(third.dimensions[0].grain, 'year');
  assert.equal(third.filters.find(item => item.field === '客户地区')?.value, '华东');
  const replaced = buildBusinessQueryIntent({ metadata, question: '2025年利润总额是多少', previousIntent: third });
  assert.deepEqual(replaced.skillRefs, []);
  assert.equal(replaced.transition.mode, 'replace');
});

test('未确认 Wyn 时间粒度表达时阻断，不在平台本地按业务时区归并', () => {
  const intent = buildBusinessQueryIntent({ metadata, question: '2025年按年看销售额' });
  const { request } = compileBusinessQueryIntent(metadata, intent);
  assert.throws(() => normalizeCanonicalResultSet({
    request,
    metadata,
    executionPlan: { id: 'exec-timezone', adapter: 'controlled-wax', adapterVersion: '1', warnings: [] },
    rawResult: { rows: [
      { period: '2024-12-31T16:00:00.000Z', revenue: 100 },
      { period: '2025-12-31T15:59:59.000Z', revenue: 50 },
      { period: '2025-12-31T16:00:00.000Z', revenue: 999 },
    ] },
  }), error => error.code === 'QUERY_CAPABILITY_UNAVAILABLE' && error.details.operation === 'time-grain');
});

test('结果覆盖校验会拒绝缺失用户明确要求的年份', () => {
  const intent = buildBusinessQueryIntent({ metadata, question: '2023至2025年销售额分别是多少' });
  const validation = validateResultAgainstIntent({
    schema: [{ name: 'period' }, { name: 'revenue' }],
    rows: [
      { period: '2023-01-01T00:00:00.000Z', revenue: 1 },
      { period: '2025-01-01T00:00:00.000Z', revenue: 3 },
    ],
    quality: {},
  }, intent);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('；'), /2024/);
});

test('华东和华南解析为同一地区字段的 in 筛选', () => {
  const intent = buildBusinessQueryIntent({ metadata, question: '过去五年，华东和华南地区每年的销售额和利润', now: new Date('2026-08-27T00:00:00+08:00') });
  const plan = compileBusinessQueryIntent(metadata, intent);
  assert.equal(plan.status, 'supported');
  const region = intent.filters.find(item => item.field === '客户地区');
  assert.deepEqual(region, { field: '客户地区', operator: 'in', value: ['华东', '华南'] });
  assert.deepEqual(plan.request.filters.find(item => item.field === '客户地区').value, ['华东', '华南']);
});

test('地区 in 筛选的结果覆盖校验会拒绝静默缺失成员', () => {
  const intent = {
    expectedResult: { minimumRows: 1, requiredMetrics: ['revenue'], requiredDimensions: ['region'], requiredPeriods: [] },
    filters: [{ field: '客户地区', operator: 'in', value: ['华东', '华南'] }],
    dimensions: [{ field: '客户地区', alias: 'region' }],
  };
  const validation = validateResultAgainstIntent({
    schema: [{ name: 'region' }, { name: 'revenue' }],
    rows: [{ region: '华东', revenue: 100 }],
  }, intent);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('；'), /客户地区=华南/);
});
test('LLM Intent 的每个筛选都进入账本并守恒编译为 Canonical 筛选', () => {
  const intent = normalizeBusinessQueryIntentV2({
    businessQuestion: '筛选多个客户类型并统计销售额',
    metrics: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '客户地区', alias: 'region', concept: 'region' }],
    filters: [
      { field: '客户地区', operator: 'containsAny', value: ['华东', '华南'] },
      { field: '订购日期', operator: 'gte', value: '2026-01-01' },
    ],
    time: { field: '订购日期', timeZone: 'Asia/Shanghai', periods: [], grain: null },
    expectedResult: { shape: 'grouped-table', minimumRows: 1, maximumRows: 20000, requiredPeriods: [], requiredMetrics: ['revenue'], requiredDimensions: ['region'], timeZone: 'Asia/Shanghai' },
  }, { metadata });
  const ledger = intent.constraints.filter(item => item.id.startsWith('filter-ledger-'));
  assert.deepEqual(ledger.map(item => item.normalized), [
    { field: '客户地区', operator: 'containsAny', value: ['华东', '华南'], negated: false },
    { field: '订购日期', operator: 'gte', value: '2026-01-01', negated: false },
  ]);
  const compiled = compileBusinessQueryIntent(metadata, intent);
  assert.equal(compiled.status, 'supported');
  assert.deepEqual(compiled.request.filters.map(({ field, operator, value }) => ({ field, operator, value })), intent.filters);
});

test('多值字符串成员结果校验会拒绝违反成员筛选的已投影记录', () => {
  const intent = {
    expectedResult: { minimumRows: 1, requiredMetrics: ['revenue'], requiredDimensions: ['region'], requiredPeriods: [] },
    filters: [{ field: '客户地区', operator: 'containsAny', value: ['华东', '华南'] }],
    dimensions: [{ field: '客户地区', alias: 'region' }],
  };
  const validation = validateResultAgainstIntent({
    schema: [{ name: 'region' }, { name: 'revenue' }],
    rows: [{ region: '华东', revenue: 100 }, { region: '华北', revenue: 80 }],
  }, intent);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('；'), /多值筛选条件/);
});
