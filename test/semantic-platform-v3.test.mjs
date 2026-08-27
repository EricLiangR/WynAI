import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBusinessQueryIntent,
  compileBusinessQueryIntent,
  validateIntentCoverage,
  validateResultAgainstIntent,
} from '../lib/semantics/business-query-intent.mjs';
import { extractQuestionSemanticFrame } from '../lib/semantics/question-semantic-frame.mjs';
import { planBusinessQuestion } from '../lib/conversation/question-planner.mjs';

const fields = [
  ['订购日期', 'time', 'Date'], ['订单金额', 'measure', 'Number'], ['订单利润', 'measure', 'Number'],
  ['购买数量', 'measure', 'Number'], ['类别名称', 'dimension', 'String'], ['商品名称', 'dimension', 'String'],
  ['客户名称', 'dimension', 'String'], ['客户地区', 'geography', 'String'], ['客户省份', 'geography', 'String'],
  ['客户省份简称', 'geography', 'String'], ['客户城市', 'geography', 'String'], ['总部省份', 'geography', 'String'],
  ['供应商名称', 'dimension', 'String'], ['员工姓名', 'dimension', 'String'], ['支付方式', 'dimension', 'String'],
  ['运货商', 'dimension', 'String'],
];

const metadata = {
  id: 'dataset-sales-v3', revision: 7, name: '销售数据', indexed: true,
  fields: fields.map(([name, role, type]) => ({ name, role, type, rawType: type, valueKind: role === 'measure' ? 'continuous' : role === 'time' ? 'temporal' : 'categorical' })),
};
const now = new Date('2026-08-23T08:00:00+08:00');

function assertPlan([question, dimensions, metrics, ranking = null, grain = null]) {
  const plan = planBusinessQuestion({ metadata, question, now });
  assert.equal(plan.status, 'supported', question);
  assert.deepEqual(plan.request.select.map(item => item.field), dimensions, question);
  assert.deepEqual(plan.request.measures.map(item => item.field), metrics, question);
  assert.equal(plan.intent.time.grain, grain, question);
  if (ranking) {
    assert.equal(plan.request.limit, ranking.limit, question);
    assert.deepEqual(plan.request.orderBy, [{ field: plan.request.measures[0].alias, direction: ranking.direction }], question);
  }
  assert.equal(validateIntentCoverage(plan.intent).valid, true, question);
}

const fiftyQuestionMatrix = [
  ['去年每类产品销售额是多少', ['类别名称'], ['订单金额']],
  ['去年各类商品利润', ['类别名称'], ['订单利润']],
  ['去年按品类看销量', ['类别名称'], ['购买数量']],
  ['商品类别销售额前五', ['类别名称'], ['订单金额'], { limit: 5, direction: 'desc' }],
  ['利润最低的产品类别是哪个', ['类别名称'], ['订单利润'], { limit: 1, direction: 'asc' }],
  ['每个产品销售额', ['商品名称'], ['订单金额']],
  ['商品利润最高', ['商品名称'], ['订单利润'], { limit: 1, direction: 'desc' }],
  ['销量前十的产品', ['商品名称'], ['购买数量'], { limit: 10, direction: 'desc' }],
  ['客户城市销售额', ['客户城市'], ['订单金额']],
  ['每个城市利润', ['客户城市'], ['订单利润']],
  ['销售额最高的城市', ['客户城市'], ['订单金额'], { limit: 1, direction: 'desc' }],
  ['销售最低的三个城市', ['客户城市'], ['订单金额'], { limit: 3, direction: 'asc' }],
  ['过去五年累计销售排名前五的城市', ['客户城市'], ['订单金额'], { limit: 5, direction: 'desc' }],
  ['去年城市销量前五', ['客户城市'], ['购买数量'], { limit: 5, direction: 'desc' }],
  ['各省销售额', ['客户省份'], ['订单金额']],
  ['省份利润最高', ['客户省份'], ['订单利润'], { limit: 1, direction: 'desc' }],
  ['销售额倒数两个省', ['客户省份'], ['订单金额'], { limit: 2, direction: 'asc' }],
  ['客户省份利润', ['客户省份'], ['订单利润']],
  ['总部省份销售额', ['总部省份'], ['订单金额']],
  ['各地区销售额', ['客户地区'], ['订单金额']],
  ['客户地区利润前五', ['客户地区'], ['订单利润'], { limit: 5, direction: 'desc' }],
  ['每个客户销售额', ['客户名称'], ['订单金额']],
  ['客户利润最高', ['客户名称'], ['订单利润'], { limit: 1, direction: 'desc' }],
  ['各供应商销售额', ['供应商名称'], ['订单金额']],
  ['供应商利润后五', ['供应商名称'], ['订单利润'], { limit: 5, direction: 'asc' }],
  ['每个员工销售额', ['员工姓名'], ['订单金额']],
  ['销售员利润最高', ['员工姓名'], ['订单利润'], { limit: 1, direction: 'desc' }],
  ['各支付方式销售额', ['支付方式'], ['订单金额']],
  ['付款方式利润', ['支付方式'], ['订单利润']],
  ['各运货商销售额', ['运货商'], ['订单金额']],
  ['承运商利润前五', ['运货商'], ['订单利润'], { limit: 5, direction: 'desc' }],
  ['2025年销售总额', [], ['订单金额']],
  ['去年利润总额', [], ['订单利润']],
  ['前年销量', [], ['购买数量']],
  ['2023、2024、2025年销售额', ['订购日期'], ['订单金额'], null, 'year'],
  ['23、24、25年利润分别是多少', ['订购日期'], ['订单利润'], null, 'year'],
  ['2023至2025每年销售额', ['订购日期'], ['订单金额'], null, 'year'],
  ['近三年销售额趋势', ['订购日期'], ['订单金额'], null, 'year'],
  ['过去五年累计销售额', [], ['订单金额']],
  ['2023至2025累计利润', [], ['订单利润']],
  ['近三年各省销售额', ['客户省份'], ['订单金额']],
  ['近三年每年各省销售额', ['客户省份', '订购日期'], ['订单金额'], null, 'year'],
  ['过去三年累计各省销售额', ['客户省份'], ['订单金额']],
  ['去年各省销售额和利润', ['客户省份'], ['订单金额', '订单利润']],
  ['销售额最高的客户', ['客户名称'], ['订单金额'], { limit: 1, direction: 'desc' }],
  ['销量最少的产品', ['商品名称'], ['购买数量'], { limit: 1, direction: 'asc' }],
  ['Top 5城市销售额', ['客户城市'], ['订单金额'], { limit: 5, direction: 'desc' }],
  ['倒数五个商品类别利润', ['类别名称'], ['订单利润'], { limit: 5, direction: 'asc' }],
  ['今年每月销售额', ['订购日期'], ['订单金额'], null, 'month'],
  ['2025年按季度看利润', ['订购日期'], ['订单利润'], null, 'quarter'],
];

test('50 条差异化业务问法保留指标、层级、时间和排名约束', () => {
  assert.equal(fiftyQuestionMatrix.length, 50);
  for (const item of fiftyQuestionMatrix) assertPlan(item);
});

test('三个用户失败案例生成正确查询结构', () => {
  const category = planBusinessQuestion({ metadata, question: '去年每类产品销售额是多少', now });
  assert.equal(category.request.select[0].field, '类别名称');
  assert.equal(category.request.limit, 100);

  const cities = planBusinessQuestion({ metadata, question: '过去五年累计销售排名前五的城市，城市名称和销售额', now });
  assert.equal(cities.request.select[0].field, '客户城市');
  assert.equal(cities.intent.time.grain, null);
  assert.equal(cities.intent.semanticFrame.accumulation.mode, 'cumulative-window');
  assert.equal(cities.request.limit, 5);

  const province = planBusinessQuestion({ metadata, question: '销售利润最高的省份是哪个，利润是多少', now });
  assert.equal(province.request.select[0].field, '客户省份');
  assert.equal(province.request.limit, 1);
  assert.deepEqual(province.request.orderBy, [{ field: 'profit', direction: 'desc' }]);
});

test('原问题语义覆盖校验拒绝静默丢失维度', () => {
  const intent = buildBusinessQueryIntent({ metadata, question: '销售额最高的城市', now });
  intent.dimensions = [];
  const validation = validateIntentCoverage(intent);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('；'), /城市|维度/);
});

test('商品类别与商品名称并列出现时保留两个产品层级维度', () => {
  const frame = extractQuestionSemanticFrame('统计每个月、商品类型、商品名称的销售额、利润、产品销量', {
    time: buildBusinessQueryIntent({ metadata, question: '统计每个月、商品类型、商品名称的销售额、利润、产品销量', now }).time,
  });
  assert.deepEqual(frame.dimensions.map(item => item.concept), ['category', 'product']);
});

test('过去五年累计是过滤窗口，不自动创建年份分组', () => {
  const frame = extractQuestionSemanticFrame('过去五年累计销售排名前五的城市', {
    time: buildBusinessQueryIntent({ metadata, question: '过去五年累计销售排名前五的城市', now }).time,
  });
  assert.equal(frame.time.grouping, null);
  assert.equal(frame.accumulation.mode, 'cumulative-window');
});

test('分区排名编译为每个分组内部 TopN，不退化成全局 Top1', () => {
  const plan = planBusinessQuestion({ metadata, question: '去年每个城市利润最高的产品', now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.ranking.partitionBy, ['city']);
  assert.equal(plan.queryProgram.steps.some(step => step.type === 'partition-rank'), true);
});

test('QuestionSemanticFrame v2 是独立持久化的版本契约', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(await readFile(new URL('../schemas/wynai.question-semantic-frame.v2.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, 'wynai.question-semantic-frame/v2');
  assert.ok(schema.required.includes('derivedMetrics'));
});

test('排名结果校验拒绝错序和超量结果', () => {
  const intent = buildBusinessQueryIntent({ metadata, question: '销售额前两个城市', now });
  const compiled = compileBusinessQueryIntent(metadata, intent);
  assert.equal(compiled.status, 'supported');
  const validation = validateResultAgainstIntent({
    schema: [{ name: 'city' }, { name: 'revenue' }],
    rows: [
      { city: 'A', revenue: 10 },
      { city: 'B', revenue: 20 },
      { city: 'C', revenue: 30 },
    ],
    quality: {},
  }, intent);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('；'), /超过要求|顺序/);
});
