import test from 'node:test';
import assert from 'node:assert/strict';
import { planBusinessQuestion, planBusinessQuestionAsync } from './lib/conversation/question-planner.mjs';
import { normalizeBusinessQueryIntentV2, validateIntentCoverage } from './lib/semantics/business-query-intent.mjs';
import { SmartQueryConversationStore } from './lib/conversation/session.mjs';

const metadata = {
  id: 'dataset-sales-v1', revision: 7, name: '销售数据',
  fields: [
    { name: '订购日期', role: 'time', type: 'Date', rawType: 'DateTime' },
    { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单利润', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单编号', role: 'identifier', type: 'String', rawType: 'String' },
    { name: '购买数量', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '员工姓名', role: 'dimension', type: 'String', rawType: 'String' },
  ],
};

function twoYearSalespersonIntent(question = '去年和前年相比，每个销售顾问的收入、利润、订单数量') {
  const currentYear = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
  return {
    schema: 'wynai.business-query-intent/v2', businessQuestion: question,
    metrics: [
      { field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' },
      { field: '订单利润', aggregation: 'sum', alias: 'profit', concept: 'profit' },
      { field: '订单编号', aggregation: 'distinctCount', alias: 'orderCount', concept: 'orderCount' },
    ],
    derivedMetrics: [],
    dimensions: [{ field: '员工姓名', alias: 'salesperson', concept: 'employee' }, { field: '订购日期', alias: 'year', concept: 'time', grain: 'year' }],
    filters: [{ field: '订购日期', operator: 'gte', value: `${currentYear - 2}-01-01` }, { field: '订购日期', operator: 'lt', value: `${currentYear}-01-01` }],
    time: { field: '订购日期', periods: ['previous-complete-year', 'two-years-ago'], range: { start: `${currentYear - 2}-01-01`, endExclusive: `${currentYear}-01-01` }, grain: 'year', grouping: 'year', explicit: true },
    ranking: null,
    expectedResult: { shape: 'table', minimumRows: 1, maximumRows: 100, requiredPeriods: ['previous-complete-year', 'two-years-ago'], requiredMetrics: ['revenue', 'profit', 'orderCount'], requiredDimensions: ['salesperson', 'year'], timeZone: 'Asia/Shanghai' },
    constraints: [], assumptions: [], ambiguities: [],
  };
}

function completeAggregateContract(rows) {
  return {
    schema: 'wynai.query-result-contract/v1', version: 1, type: 'wyn-complete-aggregate-result',
    issuedBy: 'wyn-query-adapter', aggregate: true, isComplete: true, isSample: false,
    isTruncated: false, isEstimated: false, userLimitApplied: false,
    totalRowCount: rows.length, returnedRowCount: rows.length, countVerified: true,
  };
}

test('非阈值派生指标误标 aggregate-result 时按结构化声明归一化', () => {
  const intent = normalizeBusinessQueryIntentV2({
    businessQuestion: '产品占比和金额',
    metrics: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '产品类别', alias: 'category', concept: 'category' }],
    derivedMetrics: [{ type: 'share-of-total', source: '产品类别占比', sourceConcept: 'revenue', sourceAlias: 'revenue', alias: 'revenue_share' }],
    filters: [], resultFilters: [], time: { field: null, periods: [], grain: null },
    expectedResult: { shape: 'grouped-table', maximumRows: 20000, requiredMetrics: ['revenue', 'revenue_share'], requiredDimensions: ['category'] },
    constraints: [{ id: 'share', type: 'aggregate-result-filter', source: '占比', normalized: { scope: 'aggregate-result', field: '占比' }, required: true, status: 'resolved' }],
  }, { metadata: { fields: [
    { name: '订单金额', role: 'measure', type: 'Number' },
    { name: '产品类别', role: 'dimension', type: 'String' },
  ] } });
  assert.equal(validateIntentCoverage(intent).valid, true);
});

test('真正的聚合结果阈值没有 resultFilters 时仍然阻断', () => {
  const intent = normalizeBusinessQueryIntentV2({
    businessQuestion: '按类别筛选总金额大于1000万',
    metrics: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '产品类别', alias: 'category', concept: 'category' }],
    filters: [], resultFilters: [], time: { field: null, periods: [], grain: null },
    expectedResult: { shape: 'grouped-table', maximumRows: 20000, requiredMetrics: ['revenue'], requiredDimensions: ['category'] },
    constraints: [{ id: 'having', type: 'aggregate-result-filter', source: '总金额大于1000万', normalized: { scope: 'aggregate-result', field: 'revenue', operator: 'gt' }, required: true, status: 'resolved' }],
  }, { metadata: { fields: [
    { name: '订单金额', role: 'measure', type: 'Number' },
    { name: '产品类别', role: 'dimension', type: 'String' },
  ] } });
  assert.equal(validateIntentCoverage(intent).valid, false);
});

test('LLM 仅返回默认假设时不应阻断完整查询', async () => {
  const modelIntent = twoYearSalespersonIntent();
  const plan = await planBusinessQuestionAsync({
    metadata,
    question: '去年和前年相比，每个销售顾问的收入、利润、订单数量',
    llm: { enabled: true, async planQueryIntent() { return { ...modelIntent, ambiguities: ['用户未明确指定币种，默认使用数据集金额字段。'] }; } },
  });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.request.measures.length, 3);
  assert.equal(plan.intent.ambiguities[0].blocking, false);
});

test('LLM 把截止目前误写为当天时由通用时间协议修正为累计上界', async () => {
  const question = '截止目前销售额是多少';
  const now = new Date('2026-09-20T12:00:00+08:00');
  const alternateMetadata = {
    ...metadata,
    fields: [...metadata.fields, { name: '预计交付日期', role: 'time', type: 'Date', rawType: 'DateTime' }],
  };
  const modelIntent = planBusinessQuestion({ metadata: alternateMetadata, question, now }).intent;
  modelIntent.time = {
    ...modelIntent.time,
    field: '预计交付日期', calendar: 'gregorian', periods: [],
    range: { start: '2026-09-20', endExclusive: '2026-09-21' },
    grain: null, grouping: null, modifier: 'as-of',
  };
  modelIntent.filters = [
    { field: '预计交付日期', operator: 'gte', value: '2026-09-20' },
    { field: '预计交付日期', operator: 'lt', value: '2026-09-21' },
  ];
  modelIntent.ambiguities = [];
  const plan = await planBusinessQuestionAsync({
    metadata: alternateMetadata, question, now,
    llm: { enabled: true, async planQueryIntent() { return modelIntent; } },
  });
  assert.equal(plan.status, 'supported', JSON.stringify(plan.plannerDiagnostics));
  assert.equal(plan.intent.time.scopePolicy, 'cumulative-to-date');
  assert.equal(plan.intent.time.field, '预计交付日期');
  assert.deepEqual(plan.intent.time.range, { start: null, endExclusive: '2026-09-21' });
  assert.deepEqual(plan.request.filters.map(item => ({ field: item.field, operator: item.operator, value: item.value })), [
    { field: '预计交付日期', operator: 'lt', value: '2026-09-21' },
  ]);
});

test('同比对象歧义生成可交互确认选项', async () => {
  const base = planBusinessQuestion({ metadata, question: '去年和前年相比，每个销售经理的收入、利润、订单数量' });
  const plan = await planBusinessQuestionAsync({
    metadata,
    question: '去年和前年相比，每个销售经理的收入、利润、订单数量以及同比增长率',
    llm: { enabled: true, async planQueryIntent() { return {
      ...base.intent,
      businessQuestion: '去年和前年相比，每个销售经理的收入、利润、订单数量以及同比增长率',
      ambiguities: ['同比增长率未明确指定基于哪个指标，默认基于销售额计算。'],
    }; } },
  });
  assert.equal(plan.status, 'needs_clarification');
  assert.match(plan.clarification, /同比增长率/);
  assert.deepEqual(plan.options, ['销售额同比增长率', '利润同比增长率', '订单数量同比增长率', '销售额、利润、订单数量都做同比增长率']);
});

test('模型擅自默认增长率对象时平台仍要求结构化澄清', async () => {
  const question = '去年和前年相比，每个销售顾问的收入、利润、订单数量以及同比增长率';
  const modelIntent = twoYearSalespersonIntent(question);
  modelIntent.derivedMetrics = [{ type: 'formula', operator: 'ratio', metricId: 'revenueGrowthRate', alias: 'revenueGrowthRate', concept: 'growthRate', dependencies: ['revenue'] }];
  modelIntent.expectedResult.requiredMetrics.push('revenueGrowthRate');
  modelIntent.assumptions = ['同比增长率默认只针对收入计算'];
  const plan = await planBusinessQuestionAsync({ metadata, question, llm: { enabled: true, async planQueryIntent() { return modelIntent; } } });
  assert.equal(plan.status, 'needs_clarification');
  assert.match(plan.clarification, /应用到哪个指标/);
  assert.deepEqual(plan.options, ['销售额同比增长率', '利润同比增长率', '订单数量同比增长率', '销售额、利润、订单数量都做同比增长率']);
});

test('模型 growthRate 变体归一为平台同比步骤', async () => {
  const base = planBusinessQuestion({ metadata, question: '2025年每月销售额和同比增长率' });
  const plan = await planBusinessQuestionAsync({
    metadata,
    question: '2025年每月销售额和同比增长率',
    llm: { enabled: true, async planQueryIntent() { return { ...base.intent, derivedMetrics: [{ operator: 'growthRate', alias: 'revenueGrowthRate', dependencies: ['revenue'] }], ambiguities: [] }; } },
  });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.derivedMetrics[0].type, 'yoy');
  assert.equal(plan.intent.derivedMetrics[0].sourceAlias, 'revenue');
  assert.equal(plan.queryProgram.steps.some(step => step.type === 'derive-period-growth'), true);
});

test('分别计算增长率时显示名绑定到各自来源指标', async () => {
  const question = '去年和前年相比，每个销售顾问的收入、利润、订单数量以及同比增长率分别是多少';
  const modelIntent = twoYearSalespersonIntent(question);
  modelIntent.derivedMetrics = [{ type: 'yoy', source: '同比增长率', sourceAlias: 'revenue', sourceConcept: 'revenue', alias: 'revenueGrowthRate' }];
  modelIntent.expectedResult.requiredMetrics.push('revenueGrowthRate');
  const plan = await planBusinessQuestionAsync({ metadata, question, llm: { enabled: true, async planQueryIntent() { return modelIntent; } } });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.derivedMetrics.map(item => item.source), ['销售额同比增长率', '利润同比增长率', '订单数量同比增长率']);
  assert.deepEqual(plan.displayRequest.measures.filter(item => item.derived).map(item => item.field), ['销售额同比增长率', '利润同比增长率', '订单数量同比增长率']);
});

test('Skill 派生指标自动注入内部依赖并统一可见字段契约', async () => {
  const skill = {
    id: 'sales-baseline', version: '1.3.0', status: 'approved', metrics: [
      { id: 'revenue', concept: 'revenue', name: '销售额', field: '订单金额', aggregation: 'sum', unitFamily: 'currency' },
      { id: 'profit', concept: 'profit', name: '利润', field: '订单利润', aggregation: 'sum', unitFamily: 'currency' },
      { id: 'orderCount', concept: 'orderCount', name: '订单数', field: '订单编号', aggregation: 'distinctCount', unitFamily: 'count' },
      { id: 'grossMarginRate', concept: 'grossMarginRate', name: '毛利率', outputAlias: 'gross_margin_rate', unitFamily: 'percentage', formula: { operator: 'ratio', inputs: ['profit', 'revenue'], aggregationOrder: 'aggregate-then-calculate' } },
      { id: 'averageOrderValue', concept: 'averageOrderValue', name: '客单价', outputAlias: 'average_order_value', unitFamily: 'currency', formula: { operator: 'ratio', inputs: ['revenue', 'orderCount'], aggregationOrder: 'aggregate-then-calculate' } },
    ],
  };
  const question = '按照年月、大区、省份、城市统计销售额、利润、毛利率和平均客单价';
  const modelIntent = { schema: 'wynai.business-query-intent/v2', businessQuestion: question, metrics: [
    { field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' },
    { field: '订单利润', aggregation: 'sum', alias: 'profit', concept: 'profit' },
  ], dimensions: [
    { field: '订购日期', alias: 'year_month', grain: 'month', concept: 'time' },
    { field: '客户地区', alias: 'region', concept: 'region' },
    { field: '客户省份', alias: 'province', concept: 'customerProvince' },
    { field: '客户城市', alias: 'city', concept: 'city' },
  ], filters: [], time: { field: '订购日期', periods: [], range: null, grain: 'month', grouping: 'month', groupingExplicit: true, explicit: false }, ranking: null,
    expectedResult: { shape: 'table', maximumRows: 10000, requiredMetrics: ['revenue', 'profit', 'grossMarginRate', 'averageOrderValue'], requiredDimensions: ['year_month', 'region', 'province', 'city'] }, constraints: [], ambiguities: [],
  };
  const plan = await planBusinessQuestionAsync({ metadata: { ...metadata, fields: [...metadata.fields, { name: '客户地区', role: 'geography', type: 'String' }, { name: '客户省份', role: 'geography', type: 'String' }, { name: '客户城市', role: 'geography', type: 'String' }] }, question, skills: [skill], llm: { enabled: true, async planQueryIntent() { return modelIntent; } } });
  assert.equal(plan.status, 'supported', JSON.stringify(plan.plannerDiagnostics));
  assert.ok(plan.request.measures.some(item => item.alias === 'orderCount'));
  assert.equal(plan.request.expectedResult.requiredMetrics.includes('gross_margin_rate'), true);
  assert.equal(plan.request.expectedResult.requiredMetrics.includes('average_order_value'), true);
});

test('显式年月被遗漏时触发 LLM 修复轮次', async () => {
  const question = '按照年月、大区统计销售额';
  const omitted = {
    schema: 'wynai.business-query-intent/v2', businessQuestion: question,
    metrics: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '客户地区', alias: 'region', concept: 'region' }],
    filters: [], time: { field: null, periods: [], range: null, grain: null, grouping: null, explicit: false }, ranking: null,
    expectedResult: { shape: 'table', minimumRows: 1, maximumRows: 1000, requiredPeriods: [], requiredMetrics: ['revenue'], requiredDimensions: ['region'] },
    constraints: [], ambiguities: [], assumptions: [],
  };
  const repaired = {
    ...omitted,
    dimensions: [{ field: '订购日期', alias: 'month', concept: 'time', grain: 'month' }, ...omitted.dimensions],
    time: { field: '订购日期', periods: [], range: null, grain: 'month', grouping: 'month', explicit: true },
    expectedResult: { ...omitted.expectedResult, requiredDimensions: ['month', 'region'] },
  };
  let calls = 0;
  const plan = await planBusinessQuestionAsync({
    metadata: { ...metadata, fields: [...metadata.fields, { name: '客户地区', role: 'dimension', type: 'String' }] },
    question,
    llm: { enabled: true, async planQueryIntent({ repairFeedback }) {
      calls += 1;
      if (calls === 1) return omitted;
      assert.match(repairFeedback, /遗漏了时间分组字段/);
      return repaired;
    } },
  });
  assert.equal(calls, 2);
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.dimensions[0].grain, 'month');
});

test('相对时间语义标签在执行前物化为具体年份', async () => {
  const currentYear = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
  const startYear = currentYear - 2;
  const modelIntent = twoYearSalespersonIntent();
  const plan = await planBusinessQuestionAsync({ metadata, question: '去年和前年相比，每个销售顾问的收入、利润、订单数量', llm: { enabled: true, async planQueryIntent() { return modelIntent; } } });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.time.periods, [String(startYear), String(currentYear - 1)]);
  assert.deepEqual(plan.intent.expectedResult.requiredPeriods, [String(startYear), String(currentYear - 1)]);
  assert.deepEqual(plan.queryProgram.steps.find(step => step.type === 'project-periods').periods, [String(startYear), String(currentYear - 1)]);
});

test('结构化歧义可通过同一会话选项继续执行', async () => {
  let calls = 0;
  const complete = {
    schema: 'wynai.business-query-intent/v2', businessQuestion: '按销售顾问比较去年和前年销售额同比',
    metrics: [
      { field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' },
      { field: '订单利润', aggregation: 'sum', alias: 'profit', concept: 'profit' },
      { field: '订单编号', aggregation: 'distinctCount', alias: 'orderCount', concept: 'orderCount' },
    ],
    derivedMetrics: [{ type: 'yoy', source: '销售额同比增长率', sourceAlias: 'revenue', sourceConcept: 'revenue', alias: 'revenue_yoy', offset: 1, resultType: 'percentage' }],
    dimensions: [{ field: '员工姓名', alias: 'employee', concept: 'employee' }, { field: '订购日期', alias: 'period', concept: 'time', grain: 'year' }],
    filters: [{ field: '订购日期', operator: 'gte', value: '2024-01-01' }, { field: '订购日期', operator: 'lt', value: '2026-01-01' }],
    time: { field: '订购日期', periods: ['2024', '2025'], range: { start: '2024-01-01', endExclusive: '2026-01-01' }, grain: 'year', grouping: 'year', explicit: true }, ranking: null,
    expectedResult: { shape: 'table', minimumRows: 1, maximumRows: 100, requiredPeriods: [], requiredMetrics: ['revenue', 'profit', 'orderCount', 'revenue_yoy'], requiredDimensions: ['employee', 'period'] }, constraints: [], ambiguities: [],
  };
  const intentLlm = { enabled: true, async planQueryIntent() {
    calls += 1;
    if (calls === 1) return { ...complete, derivedMetrics: [], ambiguities: [{ question: '同比增长率需要按哪个指标计算？', options: [{ label: '销售额同比增长率', concepts: ['revenue'], mode: 'single' }], blocking: true, required: true }] };
    return complete;
  } };
  const store = new SmartQueryConversationStore({
    loadMetadata: async () => metadata,
    runAnalysis: async () => { throw new Error('不应进入洞察降级'); },
    executeQuery: async ({ requests }) => { const rows = [{ employee: 'A', period: '2024-01-01', revenue: 100, profit: 20, orderCount: 10 }, { employee: 'A', period: '2025-01-01', revenue: 120, profit: 25, orderCount: 12 }]; return { resultSets: [{ id: 'rs-clarified', requestId: requests[0].id, schema: [{ name: 'employee', role: 'dimension', type: 'string' }, { name: 'period', role: 'dimension', type: 'date', grain: 'year' }, { name: 'revenue', role: 'measure', type: 'number' }, { name: 'profit', role: 'measure', type: 'number' }, { name: 'orderCount', role: 'measure', type: 'number' }], rows, quality: { isSample: false, isTruncated: false, isEstimated: false, userLimitApplied: false }, statistics: { totalRowCount: rows.length, returnedRowCount: rows.length }, resultContract: completeAggregateContract(rows) }] }; },
    intentLlm,
  });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: '去年和前年相比，每个销售顾问的收入、利润、订单数量以及同比增长率' });
  assert.equal(first.response.status, 'needs_clarification');
  assert.equal(first.response.clarification.options[0].label, '销售额同比增长率');
  assert.equal(first.conversation.conversationState, 'awaiting_clarification');
  const second = await store.ask(conversation.id, { question: '销售额同比增长率', clarificationSelection: { slotId: 'growth', concepts: ['revenue'], mode: 'single' } });
  assert.equal(second.response.status, 'ok');
  assert.equal(second.conversation.conversationState, 'ready');
  assert.equal(second.conversation.pendingContext, null);
});

test('澄清确认是强约束：模型把同比误写为 ratio 时仍编译为跨期增长', async () => {
  let calls = 0;
  const base = twoYearSalespersonIntent('去年和前年相比，每个销售顾问的收入、利润、订单数量以及同比增长率');
  const intentLlm = { enabled: true, async planQueryIntent() {
    calls += 1;
    if (calls === 1) return {
      ...base,
      ambiguities: [{
        id: 'growth-metric-binding', slotId: 'growth-metric-binding', question: '“同比增长率”要应用到哪个指标？',
        options: [
          { label: '销售额同比增长率', concepts: ['revenue'], mode: 'single' },
          { label: '利润同比增长率', concepts: ['profit'], mode: 'single' },
          { label: '订单数量同比增长率', concepts: ['orderCount'], mode: 'single' },
          { label: '销售额、利润、订单数量都做同比增长率', concepts: ['revenue', 'profit', 'orderCount'], mode: 'all' },
        ], blocking: true, required: true,
      }],
    };
    return {
      ...base,
      derivedMetrics: ['revenue', 'profit', 'orderCount'].map(alias => ({
        type: 'formula', operator: 'ratio', metricId: `${alias}_yoy_growth`, alias: `${alias}_yoy_growth`,
        concept: 'yearOverYearGrowth', dependencies: [alias],
      })),
      expectedResult: { ...base.expectedResult, requiredMetrics: [...base.expectedResult.requiredMetrics, 'revenue_yoy_growth', 'profit_yoy_growth', 'orderCount_yoy_growth'] },
      ambiguities: [],
    };
  } };
  const executeQuery = async ({ requests }) => { const rows = [
    { salesperson: 'A', year: '2023-01-01', revenue: 80, profit: 16, orderCount: 8 },
    { salesperson: 'A', year: '2024-01-01', revenue: 100, profit: 20, orderCount: 10 },
    { salesperson: 'A', year: '2025-01-01', revenue: 120, profit: 25, orderCount: 15 },
  ]; return { resultSets: [{
    id: 'rs-clarified-growth', requestId: requests[0].id,
    schema: [
      { name: 'salesperson', role: 'dimension', type: 'string' },
      { name: 'year', role: 'dimension', type: 'date', grain: 'year' },
      { name: 'revenue', role: 'measure', type: 'number' },
      { name: 'profit', role: 'measure', type: 'number' },
      { name: 'orderCount', role: 'measure', type: 'number' },
    ],
    rows, quality: { isSample: false, isTruncated: false, isEstimated: false, userLimitApplied: false },
    statistics: { totalRowCount: rows.length, returnedRowCount: rows.length },
    resultContract: completeAggregateContract(rows),
  }] }; };
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, executeQuery, runAnalysis: async () => { throw new Error('不应降级'); }, intentLlm });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: base.businessQuestion });
  assert.equal(first.response.status, 'needs_clarification');
  const second = await store.ask(conversation.id, {
    question: '销售额、利润、订单数量都做同比增长率',
    clarificationSelection: { slotId: 'growth-metric-binding', concepts: ['revenue', 'profit', 'orderCount'], mode: 'all' },
  });
  assert.equal(second.response.status, 'ok');
  assert.deepEqual(second.response.businessIntent.derivedMetrics.map(item => item.type), ['yoy', 'yoy', 'yoy']);
  assert.deepEqual(second.response.businessIntent.derivedMetrics.map(item => item.alias), ['revenue_yoy', 'profit_yoy', 'orderCount_yoy']);
  assert.equal(second.response.resultSets[0].rows[0].revenue_yoy, null);
  assert.equal(second.response.resultSets[0].rows[0].profit_yoy, null);
  assert.equal(second.response.resultSets[0].rows[0].orderCount_yoy, null);
  assert.deepEqual(second.response.resultSets[0].rows[1], {
    salesperson: 'A', year: '2025-01-01', revenue: 120, profit: 25, orderCount: 15,
    revenue_yoy: 0.2, profit_yoy: 0.25, orderCount_yoy: 0.5,
  });
});
