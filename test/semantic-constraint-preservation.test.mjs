import test from 'node:test';
import assert from 'node:assert/strict';
import { planBusinessQuestion, planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';

const now = new Date('2026-09-15T08:00:00+08:00');
const metadata = {
  id: 'dataset-semantic-preservation', revision: 1, name: '通用业务数据',
  fields: [
    ['业务日期', 'time', 'Date'], ['销售额', 'measure', 'Number'], ['利润', 'measure', 'Number'],
    ['业务编号', 'identifier', 'String'], ['客户地区', 'geography', 'String'],
    ['客户省份', 'geography', 'String'], ['客户城市', 'geography', 'String'],
  ].map(([name, role, type]) => ({ name, role, type, rawType: type })),
};

function modelThatChanges(change) {
  let calls = 0;
  return {
    llm: {
      enabled: true,
      async planQueryIntent({ metadata: inputMetadata, question, skills }) {
        calls += 1;
        const baseline = planBusinessQuestion({ metadata: inputMetadata, question, skills, now }).intent;
        return change(structuredClone(baseline));
      },
    },
    calls: () => calls,
  };
}

test('同一问题中的多个直接指标字段按各自概念绑定', () => {
  const plan = planBusinessQuestion({ metadata, question: '按客户省份统计销售额和利润', now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.metrics.map(item => [item.concept, item.field]), [
    ['revenue', '销售额'], ['profit', '利润'],
  ]);
});

test('LLM 遗漏用户明确要求的指标时归类为覆盖失败', async () => {
  const model = modelThatChanges(intent => ({ ...intent, metrics: intent.metrics.filter(item => item.concept === 'revenue') }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额和利润', now, llm: model.llm });
  assert.equal(result.status, 'error');
  assert.equal(result.plannerDiagnostics.reason, 'INTENT_COVERAGE_INVALID');
  assert.match(result.message, /利润/);
  assert.equal(model.calls(), 3);
});

test('逐行返回数值字段可以由原始字段投影满足，而不能丢失该列', async () => {
  const model = modelThatChanges(intent => {
    const metric = intent.metrics.find(item => item.field === '销售额');
    const amount = { field: '销售额', alias: 'raw_revenue', concept: metric.concept };
    return {
      ...intent,
      metrics: [],
      dimensions: [...intent.dimensions, amount],
      expectedResult: {
        ...intent.expectedResult,
        shape: 'detail-table',
        requiredMetrics: [],
        requiredDimensions: [...intent.expectedResult.requiredDimensions, amount.alias],
      },
    };
  });
  const result = await planBusinessQuestionAsync({
    metadata, question: '逐条列出客户省份和销售额，不聚合、不去重', now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(result.request.mode, 'projection');
  assert.ok(result.request.select.some(item => item.field === '销售额'));
  assert.equal(result.request.measures.length, 0);

  const missing = modelThatChanges(intent => ({
    ...intent,
    metrics: [],
    expectedResult: { ...intent.expectedResult, requiredMetrics: [] },
  }));
  const rejected = await planBusinessQuestionAsync({
    metadata, question: '逐条列出客户省份和销售额，不聚合、不去重', now, llm: missing.llm,
  });
  assert.equal(rejected.status, 'error');
  assert.match(rejected.message, /销售额|指标/);
});

test('LLM 遗漏用户明确要求的维度时归类为覆盖失败', async () => {
  const model = modelThatChanges(intent => ({ ...intent, dimensions: [] }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'error');
  assert.equal(result.plannerDiagnostics.reason, 'INTENT_COVERAGE_INVALID');
  assert.match(result.message, /客户省份|维度/);
  assert.equal(model.calls(), 3);
});

test('LLM 遗漏用户明确要求的筛选条件时归类为覆盖失败', async () => {
  const model = modelThatChanges(intent => ({ ...intent, filters: [] }));
  const result = await planBusinessQuestionAsync({ metadata, question: '只看华东的销售额', now, llm: model.llm });
  assert.equal(result.status, 'error');
  assert.equal(result.plannerDiagnostics.reason, 'INTENT_COVERAGE_INVALID');
  assert.match(result.message, /筛选条件|客户地区/);
  assert.equal(model.calls(), 3);
});

test('数据集不支持用户要求的字段时返回能力不可用澄清', async () => {
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [...intent.dimensions, { field: '不存在字段', fieldRef: '不存在字段', alias: 'missing_field', concept: 'dimension' }],
  }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按不存在字段统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.plannerDiagnostics.failureCategory, 'capability-unavailable');
  assert.match(result.clarification, /当前数据集不包含.*不存在字段/);
  assert.equal(result.request, undefined);
  assert.equal(model.calls(), 3);
});

test('LLM 可增加数据集中真实存在的业务辅助字段', async () => {
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [...intent.dimensions, { field: '客户城市', fieldRef: '客户城市', alias: 'customer_city', concept: 'city' }],
  }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.displayRequest.select.map(item => item.field), ['客户省份', '客户城市']);
  assert.equal(model.calls(), 1);
});

test('内部诊断字段不能作为用户结果字段进入查询', async () => {
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [...intent.dimensions, { field: 'traceId', fieldRef: 'traceId', alias: 'trace_id', concept: 'diagnostic' }],
  }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.plannerDiagnostics.failureCategory, 'capability-unavailable');
  assert.equal(result.request, undefined);
  assert.equal(model.calls(), 3);
});

test('完整数据集字段名优先于其内部较短泛化词', () => {
  const catalog = {
    id: 'dataset-exact-field-priority',
    fields: [
      { name: '销售额', role: 'measure', type: 'Number' },
      { name: '产品名称', role: 'dimension', type: 'String' },
      { name: '产品大类', role: 'dimension', type: 'String' },
    ],
  };
  const plan = planBusinessQuestion({ metadata: catalog, question: '按产品大类统计销售额', now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.dimensions.map(item => item.field), ['产品大类']);
});

test('财年物化移除规划器预选的其它日期字段', () => {
  const catalog = {
    id: 'dataset-fiscal-materialization',
    fields: [
      { name: '预计结束日期', role: 'time', type: 'Date' },
      { name: '实际日期', role: 'time', type: 'Date' },
      { name: '业务财年', role: 'dimension', type: 'String' },
      { name: '销售额', role: 'measure', type: 'Number' },
    ],
  };
  const fiscalSkill = {
    id: 'fiscal-policy', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { fiscalYearField: '业务财年', dateField: '实际日期', fiscalYearStart: '06-01' },
  };
  const plan = planBusinessQuestion({ metadata: catalog, question: '去年销售额', skills: [fiscalSkill], now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.filters.map(item => item.field), ['业务财年']);
});

test('实体限定指标范围时不强制分组，明确按实体统计时才输出维度', () => {
  const catalog = {
    id: 'dataset-entity-role',
    fields: [
      { name: '客户名称', role: 'dimension', type: 'String' },
      { name: '客户类型', role: 'dimension', type: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number' },
    ],
  };
  const scoped = planBusinessQuestion({ metadata: catalog, question: '某类客户的商机金额是多少', now });
  assert.deepEqual(scoped.intent.dimensions, []);
  const grouped = planBusinessQuestion({ metadata: catalog, question: '按客户统计商机金额', now });
  assert.deepEqual(grouped.intent.dimensions.map(item => item.field), ['客户名称']);
});

test('Skill 中更具体的层级别名覆盖同概念族的泛化字段', () => {
  const catalog = {
    id: 'dataset-skill-hierarchy',
    fields: [
      { name: '产品名称', role: 'dimension', type: 'String' },
      { name: '产品大类', role: 'dimension', type: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number' },
    ],
  };
  const skill = {
    id: 'generic-product-hierarchy', version: '1.0.0', status: 'approved',
    businessEntities: [
      { id: 'product', concept: 'product', name: '产品', field: '产品名称', synonyms: ['产品名称'] },
      { id: 'productCategory', concept: 'productCategory', name: '产品大类', field: '产品大类', synonyms: ['Level0'] },
    ],
  };
  const plan = planBusinessQuestion({ metadata: catalog, question: '按产品Level0统计商机金额', skills: [skill], now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.dimensions.map(item => item.field), ['产品大类']);
});

test('LLM 将泛化实体解析为同一 Skill 概念族筛选时不强制输出该实体', async () => {
  const catalog = {
    id: 'dataset-scope-family',
    fields: [
      { name: '客户名称', role: 'dimension', type: 'String' },
      { name: '客户类型', role: 'dimension', type: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number' },
    ],
  };
  const skill = {
    id: 'generic-customer-scope', version: '1.0.0', status: 'approved',
    businessEntities: [
      { id: 'customer', concept: 'customer', name: '客户', field: '客户名称', synonyms: ['客户'] },
      { id: 'customerType', concept: 'customerType', name: '客户类型', field: '客户类型', synonyms: ['A类'] },
    ],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    semanticFrame: null,
    dimensions: [],
    filters: [{ field: '客户类型', operator: 'eq', value: 'A类' }],
    expectedResult: { ...intent.expectedResult, shape: 'scalar', requiredDimensions: [], maximumRows: 1 },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog, question: '不是A类客户的商机金额是多少', skills: [skill], now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.select, []);
  assert.deepEqual(result.request.filters.map(item => item.field), ['客户类型']);
});

test('分类型财年字段不能被追加日期范围比较条件', async () => {
  const catalog = {
    id: 'dataset-fiscal-field-type', revision: 1,
    fields: [
      { name: '赢单日期', role: 'time', type: 'Date', rawType: 'DateTime' },
      { name: '赢单财年', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '产品大类', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const fiscalSkill = {
    id: 'fiscal-field-policy', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '赢单财年', dateField: '赢单日期', fiscalYearStart: '06-01' },
    businessEntities: [
      { id: 'productCategory', concept: 'productCategory', name: '产品大类', field: '产品大类', synonyms: ['Level0'] },
    ],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    filters: [{ field: '赢单财年', operator: 'eq', value: '26' }],
    time: {
      field: '赢单财年', calendar: 'fiscal', timeZone: 'Asia/Shanghai',
      periods: ['FY26'], range: { start: '2025-06-01', endExclusive: '2026-06-01' },
      grain: null, grouping: null, explicit: true, modifier: null, groupedYears: false,
    },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog,
    question: '按产品大类统计财年26的总商机金额',
    skills: [fiscalSkill],
    now,
    llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters, [{ field: '赢单财年', operator: 'eq', value: '26', fieldType: 'dimension' }]);
  assert.equal(result.intent.time.range, null);
});
