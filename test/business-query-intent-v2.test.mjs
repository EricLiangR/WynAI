import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildBusinessQueryIntent,
  compileBusinessQueryIntent,
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

test('业务时区在 Wyn UTC 序列化边界上按本地年份归并', () => {
  const intent = buildBusinessQueryIntent({ metadata, question: '2025年按年看销售额' });
  const { request } = compileBusinessQueryIntent(metadata, intent);
  const result = normalizeCanonicalResultSet({
    request,
    metadata,
    executionPlan: { id: 'exec-timezone', adapter: 'controlled-wax', adapterVersion: '1', warnings: [] },
    rawResult: { rows: [
      { period: '2024-12-31T16:00:00.000Z', revenue: 100 },
      { period: '2025-12-31T15:59:59.000Z', revenue: 50 },
      { period: '2025-12-31T16:00:00.000Z', revenue: 999 },
    ] },
  });
  assert.deepEqual(result.rows.map(row => [row.period, row.revenue]), [
    ['2025-01-01T00:00:00.000Z', 150],
    ['2026-01-01T00:00:00.000Z', 999],
  ]);
  assert.equal(result.scope.timeZone, 'Asia/Shanghai');
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
