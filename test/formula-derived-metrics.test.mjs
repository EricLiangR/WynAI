import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SkillRegistry } from '../lib/skills/skill-registry.mjs';
import { planBusinessQuestion, planBusinessQuestionAsync, composeQuestionDocument } from '../lib/conversation/question-planner.mjs';
import { applyQueryProgram } from '../lib/query/query-program.mjs';
import { decideVisualization } from '../lib/visualization/visualization-spec.mjs';

const metadata = {
  id: '2b445034-38fe-4350-9cab-b7684c28b5f8',
  revision: 12,
  name: '销售数据',
  fields: [
    { name: '订购日期', role: 'time', type: 'Date', rawType: 'DateTime' },
    { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单利润', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单编号', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '客户地区', role: 'dimension', type: 'String', rawType: 'String' },
  ],
};

const rawSkill = JSON.parse(await readFile(new URL('../skills/sales/skill.json', import.meta.url), 'utf8'));
const skill = new SkillRegistry([rawSkill]).get('sales-baseline');
const skills = [skill];
const skillRefs = [`${skill.id}@${skill.version}`];

function plan(question, extra = {}) {
  return planBusinessQuestion({ metadata, question, skills, skillRefs, now: new Date('2026-08-25T08:00:00+08:00'), ...extra });
}

function rawResult(request, rows) {
  return {
    id: 'result-formula',
    schema: [
      ...request.select.map(item => ({ name: item.alias, sourceField: item.field, displayName: item.field, type: item.grain ? 'date' : 'string', role: 'dimension', grain: item.grain })),
      ...request.measures.map(item => ({ name: item.alias, sourceField: item.field, displayName: item.field, type: 'number', role: 'measure', aggregation: item.aggregation })),
    ],
    rows,
    resultContract: {
      schema: 'wynai.query-result-contract/v1', version: 1, type: 'wyn-complete-aggregate-result',
      issuedBy: 'wyn-query-adapter', aggregate: true, isComplete: true, isSample: false,
      isTruncated: false, isEstimated: false, userLimitApplied: false,
      totalRowCount: rows.length, returnedRowCount: rows.length, countVerified: true,
    },
    quality: { isSample: false, isTruncated: false, warnings: [] },
  };
}

test('Skill 1.3.0 持久化受治理公式指标口径', () => {
  const metric = skill.metrics.find(item => item.id === 'grossMarginRate');
  assert.equal(skill.version, '1.3.0');
  assert.deepEqual(metric.formula, {
    schema: 'wynai.metric-formula/v1',
    operator: 'ratio',
    inputs: ['profit', 'revenue'],
    aggregationOrder: 'aggregate-then-calculate',
    zeroDivision: 'null',
  });
  assert.equal(metric.unitFamily, 'percentage');
});

test('每年销售额、利润和毛利率按聚合结果计算并生成双轴组合图', () => {
  const planned = plan('分析每年的销售额、利润和毛利率');
  assert.equal(planned.status, 'supported');
  assert.deepEqual(planned.intent.metrics.map(item => item.alias), ['revenue', 'profit']);
  assert.deepEqual(planned.intent.derivedMetrics.map(item => item.alias), ['gross_margin_rate']);
  const output = applyQueryProgram(rawResult(planned.request, [
    { period: '2023-01-01', revenue: 100, profit: 20 },
    { period: '2024-01-01', revenue: 250, profit: 75 },
    { period: '2025-01-01', revenue: 80, profit: -8 },
  ]), planned.queryProgram);
  assert.deepEqual(output.rows.map(item => item.gross_margin_rate), [0.2, 0.3, -0.1]);
  assert.equal(output.schema.find(item => item.name === 'gross_margin_rate').format, 'percentage');
  const visualization = decideVisualization({ question: '分析每年的销售额、利润和毛利率', request: planned.displayRequest, resultSet: output });
  assert.equal(visualization.spec.type, 'combo');
  assert.equal(visualization.spec.encoding.measures.find(item => item.field === 'gross_margin_rate').axis, 'right');
});

test('只问毛利率时查询内部依赖但最终仅公开请求指标', () => {
  const planned = plan('每年毛利率');
  assert.equal(planned.status, 'supported');
  assert.ok(planned.intent.metrics.every(item => item.internal));
  assert.deepEqual(planned.displayRequest.measures.map(item => item.alias), ['gross_margin_rate']);
  const output = applyQueryProgram(rawResult(planned.request, [
    { period: '2025-01-01', profit: 18, revenue: 120 },
  ]), planned.queryProgram);
  assert.deepEqual(Object.keys(output.rows[0]).sort(), ['gross_margin_rate', 'period']);
  assert.equal(output.rows[0].gross_margin_rate, 0.15);
});

test('按地区计算毛利率使用各组利润合计除以收入合计', () => {
  const planned = plan('按地区分析毛利率');
  assert.equal(planned.status, 'supported');
  const output = applyQueryProgram(rawResult(planned.request, [
    { region: '华东', profit: 30, revenue: 100 },
    { region: '华北', profit: 8, revenue: 80 },
  ]), planned.queryProgram);
  assert.deepEqual(output.rows, [
    { region: '华东', gross_margin_rate: 0.3 },
    { region: '华北', gross_margin_rate: 0.1 },
  ]);
});

test('派生指标排名在 Wyn 无法完整表达时明确不可用，不在平台本地执行 TopN', () => {
  const planned = plan('毛利率最高的地区');
  assert.equal(planned.status, 'needs_clarification');
  assert.equal(planned.request, undefined);
});

test('追加毛利率继承多轮时间上下文并保留已公开指标', () => {
  const first = plan('统计每年销售额');
  const second = plan('同时增加毛利率', { previousIntent: first.intent, previousRequest: first.displayRequest });
  assert.equal(second.status, 'supported');
  assert.equal(second.intent.transition.inheritsPriorContext, true);
  assert.equal(second.intent.time.grain, 'year');
  assert.deepEqual(second.displayRequest.measures.map(item => item.alias), ['revenue', 'gross_margin_rate']);
  assert.equal(second.intent.metrics.find(item => item.alias === 'profit').internal, true);
});

test('分母为零返回空值、不会产生 Infinity 或 NaN，并记录质量告警', () => {
  const planned = plan('按地区分析毛利率');
  const output = applyQueryProgram(rawResult(planned.request, [
    { region: '华东', profit: 12, revenue: 0 },
  ]), planned.queryProgram);
  assert.equal(output.rows[0].gross_margin_rate, null);
  assert.match(output.quality.warnings.join('；'), /分母为 0/);
});

test('未审批或缺失公式 Skill 时进入澄清而不静默遗漏毛利率', () => {
  const draft = { ...skill, status: 'draft' };
  const planned = planBusinessQuestion({ metadata, question: '每年毛利率', skills: [draft], skillRefs: [] });
  assert.equal(planned.status, 'needs_clarification');
  assert.ok(planned.intent.constraints.some(item => item.required && item.status === 'unresolved'));
});

test('LLM 遗漏或发明公式时均被覆盖校验拒绝且不返回业务 fallback', async () => {
  const baseline = plan('分析每年的销售额、利润和毛利率');
  const omitted = await planBusinessQuestionAsync({
    metadata,
    question: '分析每年的销售额、利润和毛利率',
    skills,
    skillRefs,
    llm: { enabled: true, async planQueryIntent() { return { ...baseline.intent, derivedMetrics: [] }; } },
  });
  assert.equal(omitted.status, 'supported');
  assert.deepEqual(omitted.intent.derivedMetrics.map(item => item.metricId), ['grossMarginRate']);

  const invented = await planBusinessQuestionAsync({
    metadata,
    question: '分析每年的销售额、利润和毛利率',
    skills,
    skillRefs,
    llm: { enabled: true, async planQueryIntent() {
      return { ...baseline.intent, derivedMetrics: [...baseline.intent.derivedMetrics, {
        type: 'formula', operator: 'ratio', metricId: 'inventedRate', alias: 'invented_rate',
        dependencies: [{ metricId: 'profit', sourceAlias: 'profit' }, { metricId: 'revenue', sourceAlias: 'revenue' }],
        aggregationOrder: 'aggregate-then-calculate', skillRef: skillRefs[0],
      }] };
    } },
  });
  assert.equal(invented.status, 'error');
  assert.equal(invented.code, 'INTENT_VALIDATION_FAILED');
  assert.equal(invented.request, undefined);
});

test('混合 LLM 丢失展示元数据或 internal 标记时由确定性 Skill 基线恢复', async () => {
  const planned = await planBusinessQuestionAsync({
    metadata,
    question: '每年毛利率',
    skills,
    skillRefs,
    llm: { enabled: true, async planQueryIntent() {
      const deterministicIntent = plan('每年毛利率').intent;
      return {
        ...deterministicIntent,
        metrics: deterministicIntent.metrics.map(({ internal, ...item }) => item),
        derivedMetrics: deterministicIntent.derivedMetrics.map(({ source, concept, unitFamily, resultType, ...item }) => item),
      };
    } },
  });
  assert.equal(planned.status, 'supported');
  assert.deepEqual(planned.displayRequest.measures.map(item => item.alias), ['gross_margin_rate']);
  assert.equal(planned.displayRequest.measures[0].field, '毛利率');
  assert.equal(planned.displayRequest.measures[0].unitFamily, 'percentage');
});

test('销售毛利率同义词和标量回答均使用百分比格式', () => {
  const planned = plan('销售毛利率是多少');
  assert.equal(planned.status, 'supported');
  assert.equal(planned.intent.derivedMetrics[0].metricId, 'grossMarginRate');
  const output = applyQueryProgram(rawResult(planned.request, [{ profit: 25, revenue: 100 }]), planned.queryProgram);
  const document = composeQuestionDocument({ metadata, question: '销售毛利率是多少', plan: { ...planned, request: planned.displayRequest }, resultSet: output });
  assert.equal(document.blocks.find(item => item.type === 'kpi').value, '25%');
});
test('销售额、利润和客单价从 Skill 识别并按地区计算', () => {
  const metric = skill.metrics.find(item => item.id === 'averageOrderValue');
  assert.deepEqual(metric.formula, {
    schema: 'wynai.metric-formula/v1',
    operator: 'ratio',
    inputs: ['revenue', 'orderCount'],
    aggregationOrder: 'aggregate-then-calculate',
    zeroDivision: 'null',
  });
  assert.equal(metric.unitFamily, 'currency');

  const planned = plan('2024年，统计每个地区的销售额、利润和客单价');
  assert.equal(planned.status, 'supported');
  assert.deepEqual(planned.intent.derivedMetrics.map(item => item.alias), ['average_order_value']);
  const orderCount = planned.intent.metrics.find(item => item.alias === 'order_count');
  assert.equal(orderCount.aggregation, 'distinctCount');
  assert.equal(orderCount.internal, true);

  const output = applyQueryProgram(rawResult(planned.request, [
    { region: '华东', revenue: 1200, profit: 300, order_count: 4 },
    { region: '华北', revenue: 900, profit: 200, order_count: 3 },
  ]), planned.queryProgram);
  assert.deepEqual(output.rows.map(item => item.average_order_value), [300, 300]);
  assert.ok(output.rows.every(item => !Object.hasOwn(item, 'order_count')));
});
