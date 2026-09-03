import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planBusinessQuestion, planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';
import { applyQueryProgram } from '../lib/query/query-program.mjs';
import { SmartQueryConversationStore } from '../lib/conversation/session.mjs';
import { SkillRegistry } from '../lib/skills/skill-registry.mjs';

const fields = [
  ['订购日期', 'time', 'Date'],
  ['订单金额', 'measure', 'Number'],
  ['订单利润', 'measure', 'Number'],
  ['订单编号', 'identifier', 'String'],
  ['购买数量', 'measure', 'Number'],
  ['客户地区', 'geography', 'String'],
  ['客户省份', 'geography', 'String'],
  ['客户城市', 'geography', 'String'],
  ['商品名称', 'dimension', 'String'],
  ['员工姓名', 'dimension', 'String'],
];
const metadata = {
  id: 'dataset-advanced-sales',
  revision: 7,
  name: '销售数据',
  fields: fields.map(([name, role, type]) => ({ name, role, type, rawType: type })),
};
const now = new Date('2026-08-24T08:00:00+08:00');

function resultSet(request, rows) {
  return {
    id: 'rs-advanced',
    requestId: request.id,
    schema: [
      ...request.select.map(item => ({ name: item.alias, role: 'dimension', type: item.grain ? 'date' : 'string', grain: item.grain || null })),
      ...request.measures.map(item => ({ name: item.alias, role: 'measure', type: 'number' })),
    ],
    rows,
    statistics: {},
    quality: { isSample: false, isTruncated: false, warnings: [] },
  };
}

test('QueryProgram 按年份分别取销售额第一的省份', () => {
  const plan = planBusinessQuestion({ metadata, question: '2023、2024、2025年销售额排名第一的省份分别是哪个', now });
  assert.equal(plan.status, 'supported');
  const raw = resultSet(plan.request, [
    { province: 'A', period: '2023-01-01T00:00:00.000Z', revenue: 10 },
    { province: 'B', period: '2023-01-01T00:00:00.000Z', revenue: 30 },
    { province: 'A', period: '2024-01-01T00:00:00.000Z', revenue: 50 },
    { province: 'B', period: '2024-01-01T00:00:00.000Z', revenue: 20 },
    { province: 'A', period: '2025-01-01T00:00:00.000Z', revenue: 40 },
    { province: 'B', period: '2025-01-01T00:00:00.000Z', revenue: 60 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows.map(row => [row.period.slice(0, 4), row.province, row.revenue]), [
    ['2023', 'B', 30], ['2024', 'A', 50], ['2025', 'B', 60],
  ]);
});

test('同比查询自动扩大基期并只投影用户要求期间', () => {
  const plan = planBusinessQuestion({ metadata, question: '2023至2025年销售额和销售额同比增长率', now });
  assert.equal(plan.request.filters.find(item => item.operator === 'gte').value, '2022-01-01');
  const raw = resultSet(plan.request, [
    { period: '2022-01-01T00:00:00.000Z', revenue: 100 },
    { period: '2023-01-01T00:00:00.000Z', revenue: 120 },
    { period: '2024-01-01T00:00:00.000Z', revenue: 90 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 135 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows.map(row => row.period.slice(0, 4)), ['2023', '2024', '2025']);
  assert.deepEqual(output.rows.map(row => row.revenue_yoy), [0.2, -0.25, 0.5]);
  assert.equal(output.schema.find(column => column.name === 'revenue_yoy').format, 'percentage');
  assert.equal(output.statistics.totalRowCount, 3);
  assert.equal(output.statistics.returnedRowCount, 3);
  assert.equal(output.statistics.internalCalculationRowCount, 4);
  assert.equal(output.quality.totalRowCount, 3);
  assert.equal(output.quality.isTruncated, false);
});

test('时间分组不再被误当成显式时间范围', () => {
  const plan = planBusinessQuestion({ metadata, question: '华东地区每年销售额和同比增长率', now });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.time.scopeExplicit, false);
  assert.equal(plan.intent.time.groupingExplicit, true);
  assert.equal(plan.intent.constraints.some(item => item.type === 'time-scope'), false);
});

test('澄清状态机保留 pending，受控 IntentPatch 成功后再提交', async () => {
  const skillRegistry = new SkillRegistry([{
    id: 'sales-entities',
    version: '1.0.0',
    scope: 'dataset',
    datasetIds: [metadata.id],
    status: 'approved',
    triggers: ['销售', '销售经理'],
    businessEntities: [{ id: 'salesManager', concept: 'employee', name: '销售经理', field: '员工姓名', synonyms: ['销售经理', '销售员'] }],
  }]);
  const executeQuery = async ({ requests }) => ({
    resultSets: [resultSet(requests[0], [
      { employee: '张三', revenue: 300 },
      { employee: '李四', revenue: 200 },
      { employee: '王五', revenue: 100 },
    ])],
  });
  const store = new SmartQueryConversationStore({
    loadMetadata: async () => metadata,
    runAnalysis: async () => { throw new Error('不应降级'); },
    executeQuery,
    skillRegistry,
  });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: '过去三年销售额累计排名前三的是谁' });
  assert.equal(first.response.status, 'needs_clarification');
  assert.equal(first.conversation.conversationState, 'awaiting_clarification');
  assert.equal(first.conversation.committedContext, null);
  assert.ok(first.conversation.pendingContext.unresolvedSlots.some(slot => slot.type === 'dimension'));

  const second = await store.ask(conversation.id, { question: '我是需要按照销售经理作为维度' });
  assert.equal(second.response.status, 'ok');
  assert.equal(second.response.intentPatch.schema, 'wynai.intent-patch/v1');
  assert.ok(second.response.intentPatch.operations.some(operation => operation.path === '/dimensions'));
  assert.equal(second.conversation.pendingContext, null);
  assert.equal(second.conversation.conversationState, 'ready');
  assert.equal(second.conversation.committedContext.intent.dimensions[0].field, '员工姓名');
  assert.deepEqual(second.conversation.committedContext.intent.time.periods, [2023, 2024, 2025]);
});

test('月度环比使用上月基期并保留年度内月份', () => {
  const plan = planBusinessQuestion({ metadata, question: '2025年每月销售额和环比增长率', now });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.request.filters.find(item => item.operator === 'gte').value, '2024-12-01');
  const raw = resultSet(plan.request, [
    { period: '2024-12-01T00:00:00.000Z', revenue: 100 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 120 },
    { period: '2025-02-01T00:00:00.000Z', revenue: 90 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows.map(row => row.period.slice(0, 7)), ['2025-01', '2025-02']);
  assert.deepEqual(output.rows.map(row => row.revenue_mom), [0.2, -0.25]);
});

test('月度同比使用上年同月且筛选追问保留派生指标', () => {
  const first = planBusinessQuestion({ metadata, question: '2025年每月销售额和同比增长率', now });
  assert.equal(first.request.filters.find(item => item.operator === 'gte').value, '2024-01-01');
  const raw = resultSet(first.request, [
    { period: '2024-01-01T00:00:00.000Z', revenue: 100 },
    { period: '2024-02-01T00:00:00.000Z', revenue: 200 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 150 },
    { period: '2025-02-01T00:00:00.000Z', revenue: 180 },
  ]);
  const output = applyQueryProgram(raw, first.queryProgram);
  assert.deepEqual(output.rows.map(row => row.revenue_yoy), [0.5, -0.1]);

  const second = planBusinessQuestion({
    metadata,
    question: '只看华东',
    previousIntent: first.intent,
    previousRequest: first.displayRequest,
    now,
  });
  assert.equal(second.status, 'supported');
  assert.deepEqual(second.intent.derivedMetrics.map(item => item.alias), ['revenue_yoy']);
  assert.equal(second.intent.filters.find(item => item.field === '客户地区').value, '华东');
});

test('筛选追问继承全部复合指标，派生追问继承当前指标', () => {
  const composite = planBusinessQuestion({ metadata, question: '2023至2025年销售额、利润和销售额同比增长率', now });
  const filtered = planBusinessQuestion({ metadata, question: '只看华东', previousIntent: composite.intent, previousRequest: composite.displayRequest, now });
  assert.deepEqual(filtered.intent.metrics.map(item => item.field), ['订单金额', '订单利润']);
  assert.deepEqual(filtered.intent.derivedMetrics.map(item => item.alias), ['revenue_yoy']);

  const profit = planBusinessQuestion({ metadata, question: '2025年每月利润', now });
  const yoy = planBusinessQuestion({ metadata, question: '再看同比增长率', previousIntent: profit.intent, previousRequest: profit.displayRequest, now });
  assert.equal(yoy.status, 'supported');
  assert.deepEqual(yoy.intent.derivedMetrics.map(item => item.alias), ['profit_yoy']);
});
test('低风险且有已审批 Skill 的完整意图走快路径', async () => {
  let llmCalls = 0;
  const llm = {
    enabled: true,
    async planQueryIntent() {
      llmCalls += 1;
      await new Promise(() => {});
    },
  };
  const startedAt = Date.now();
  const plan = await planBusinessQuestionAsync({
    metadata,
    question: '2025年销售收入总额',
    skillRefs: ['sales-baseline@1.0.0'],
    now,
    llm,
  });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.plannerMode, 'deterministic-fast-path');
  assert.equal(plan.plannerDiagnostics.llmAttempted, false);
  assert.equal(llmCalls, 0);
  assert.ok(Date.now() - startedAt < 100);
  assert.deepEqual(plan.intent.time.periods, [2025]);
  assert.equal(plan.request.filters.find(item => item.operator === 'gte').value, '2025-01-01');
});

test('意图大模型连续失败后触发短时熔断并保留确定性澄清', async () => {
  let llmCalls = 0;
  const llm = {
    enabled: true,
    async planQueryIntent() {
      llmCalls += 1;
      const error = new Error('模拟意图模型超时');
      error.code = 'LLM_TIMEOUT';
      throw error;
    },
  };
  const input = {
    metadata,
    question: '过去三年销售额累计排名前三的是谁',
    now,
    llm,
  };
  const first = await planBusinessQuestionAsync(input);
  const second = await planBusinessQuestionAsync(input);
  const third = await planBusinessQuestionAsync(input);
  assert.equal(first.plannerDiagnostics.llmAttempted, true);
  assert.equal(second.plannerDiagnostics.circuitOpen, true);
  assert.equal(third.plannerDiagnostics.reason, 'high-risk-intent-llm-circuit-open');
  assert.equal(third.plannerDiagnostics.llmAttempted, false);
  assert.equal(llmCalls, 2);
  assert.equal(third.status, 'needs_clarification');
});

const governedSalesSkill = {
  id: 'sales-baseline',
  version: '1.1.0',
  scope: 'dataset',
  datasetIds: [metadata.id],
  status: 'approved',
  triggers: ['销售', '订单数', '订单数量', '大区'],
  metrics: [
    { id: 'revenue', concept: 'revenue', name: '销售额', field: '订单金额', aggregation: 'sum', synonyms: ['销售收入'], unitFamily: 'currency' },
    { id: 'profit', concept: 'profit', name: '利润', field: '订单利润', aggregation: 'sum', synonyms: ['毛利'], unitFamily: 'currency' },
    { id: 'orderCount', concept: 'orderCount', name: '订单数', field: '订单编号', aggregation: 'distinctCount', synonyms: ['订单数量', '订单量'], unitFamily: 'count' },
  ],
  businessEntities: [
    { id: 'salesRegion', concept: 'region', name: '销售大区', field: '客户地区', synonyms: ['大区', '区域', '地区'] },
  ],
};

test('开放式每年排名按时间分区而不是退化为全局 TopN', () => {
  const plan = planBusinessQuestion({ metadata, question: '统计每年，销售排名前三的城市和销售额', now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.ranking.partitionBy, ['period']);
  assert.equal(plan.request.limit, 20000);
  const raw = resultSet(plan.request, [
    { city: 'A', period: '2024-01-01', revenue: 10 },
    { city: 'B', period: '2024-01-01', revenue: 40 },
    { city: 'C', period: '2024-01-01', revenue: 30 },
    { city: 'D', period: '2024-01-01', revenue: 20 },
    { city: 'A', period: '2025-01-01', revenue: 70 },
    { city: 'B', period: '2025-01-01', revenue: 50 },
    { city: 'C', period: '2025-01-01', revenue: 60 },
    { city: 'D', period: '2025-01-01', revenue: 5 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows.map(row => [row.period.slice(0, 4), row.city]), [
    ['2024', 'B'], ['2024', 'C'], ['2024', 'D'],
    ['2025', 'A'], ['2025', 'C'], ['2025', 'B'],
  ]);
});

test('Skill 指标口径优先于数量字段泛化并支持订单数去重计数', () => {
  const plan = planBusinessQuestion({
    metadata,
    question: '统计每年销售额、利润和订单数量',
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
  });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.metrics.map(item => [item.field, item.aggregation, item.alias]), [
    ['订单金额', 'sum', 'revenue'],
    ['订单利润', 'sum', 'profit'],
    ['订单编号', 'distinctCount', 'order_count'],
  ]);
});

test('单年度同比自动建立基期上下文并隐藏内部时间维度', () => {
  const plan = planBusinessQuestion({
    metadata,
    question: '去年各省份的销售额和同比增长率',
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
  });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.request.filters.find(item => item.operator === 'gte').value, '2024-01-01');
  assert.equal(plan.intent.dimensions.find(item => item.grain)?.internal, true);
  assert.deepEqual(plan.displayRequest.select.map(item => item.alias), ['province']);
  const raw = resultSet(plan.request, [
    { province: 'A', period: '2024-01-01', revenue: 100 },
    { province: 'B', period: '2024-01-01', revenue: 200 },
    { province: 'A', period: '2025-01-01', revenue: 120 },
    { province: 'B', period: '2025-01-01', revenue: 150 },
  ]);
  const output = applyQueryProgram(raw, plan.queryProgram);
  assert.deepEqual(output.rows, [
    { province: 'A', revenue: 120, revenue_yoy: 0.2 },
    { province: 'B', revenue: 150, revenue_yoy: -0.25 },
  ]);
  assert.equal(output.schema.some(column => column.name === 'period'), false);
});

test('Skill 业务实体把大区统一映射到数据集地区字段', () => {
  const plan = planBusinessQuestion({
    metadata,
    question: '统计去年，每个大区的销售额和销售额同比增长率',
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
  });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.dimensions.find(item => !item.grain).field, '客户地区');
  assert.equal(plan.intent.dimensions.find(item => !item.grain).concept, 'region');
});

test('追加式多轮追问继承已有上下文并增加指标', () => {
  const first = planBusinessQuestion({
    metadata,
    question: '统计每年销售额',
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
  });
  const second = planBusinessQuestion({
    metadata,
    question: '同时增加利润和订单数量',
    previousIntent: first.intent,
    previousRequest: first.displayRequest,
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
  });
  assert.equal(second.status, 'supported');
  assert.deepEqual(second.intent.metrics.map(item => item.alias), ['revenue', 'profit', 'order_count']);
  assert.equal(second.intent.transition.inheritsPriorContext, true);
  assert.equal(second.intent.time.grain, 'year');
});

test('模型语义覆盖失败不会被计为供应商熔断故障', async () => {
  let calls = 0;
  const llm = {
    enabled: true,
    async planQueryIntent() {
      calls += 1;
      return { dimensions: [] };
    },
  };
  const input = {
    metadata,
    question: '去年各省份的销售额和同比增长率',
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
    llm,
  };
  const first = await planBusinessQuestionAsync(input);
  const second = await planBusinessQuestionAsync(input);
  assert.equal(first.plannerDiagnostics.reason, 'INTENT_COVERAGE_INVALID');
  assert.equal(second.plannerDiagnostics.llmAttempted, true);
  assert.equal(second.plannerDiagnostics.circuitOpen, false);
  assert.equal(calls, 2);
});
test('模型不得把同比计算依赖扩张为用户可见时间维度', async () => {
  const llm = {
    enabled: true,
    async planQueryIntent({ deterministicIntent }) {
      return {
        ...deterministicIntent,
        dimensions: deterministicIntent.dimensions.map(({ internal, ...item }) => item),
      };
    },
  };
  const plan = await planBusinessQuestionAsync({
    metadata,
    question: '去年各省份的销售额和同比增长率',
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
    llm,
  });
  assert.equal(plan.plannerMode, 'hybrid-llm-validated');
  assert.equal(plan.intent.dimensions.find(item => item.grain)?.internal, true);
  assert.deepEqual(plan.displayRequest.select.map(item => item.field), ['客户省份']);
});

test('模型新增用户未要求的可见维度时回退到已校验计划且不触发熔断', async () => {
  let calls = 0;
  const llm = {
    enabled: true,
    async planQueryIntent({ deterministicIntent }) {
      calls += 1;
      return {
        ...deterministicIntent,
        dimensions: [
          ...deterministicIntent.dimensions,
          { field: '客户地区', alias: 'region', concept: 'region', grain: null },
        ],
      };
    },
  };
  const input = {
    metadata,
    question: '各省份销售额为什么不同',
    skills: [governedSalesSkill],
    skillRefs: ['sales-baseline@1.1.0'],
    now,
    llm,
  };
  const first = await planBusinessQuestionAsync(input);
  const second = await planBusinessQuestionAsync(input);
  assert.equal(first.plannerDiagnostics.reason, 'INTENT_SCOPE_EXPANSION_INVALID');
  assert.deepEqual(first.displayRequest.select.map(item => item.field), ['客户省份']);
  assert.equal(second.plannerDiagnostics.llmAttempted, true);
  assert.equal(second.plannerDiagnostics.circuitOpen, false);
  assert.equal(calls, 2);
});

test('多指标未明确同比对象时必须澄清，不静默绑定最后一个指标', () => {
  const plan = planBusinessQuestion({ metadata, question: '2023至2025年销售额、利润和同比增长率', now });
  assert.equal(plan.status, 'needs_clarification');
  assert.match(plan.clarification, /同比增长率/);
  assert.deepEqual(plan.intent.derivedMetrics, []);
});

test('派生关系语义支持并列指标和分别/全部表达', () => {
  const first = planBusinessQuestion({ metadata, question: '2023至2025年销售额和同比增长率、利润、订单数量', now });
  assert.equal(first.status, 'supported');
  assert.deepEqual(first.intent.metrics.filter(item => !item.internal).map(item => item.concept), ['revenue', 'profit', 'orderCount']);
  assert.deepEqual(first.intent.derivedMetrics.map(item => item.alias), ['revenue_yoy']);
  const all = planBusinessQuestion({ metadata, question: '2023至2025年销售额、利润和订单数都做同比增长率', now });
  assert.equal(all.status, 'supported');
  assert.deepEqual(all.intent.derivedMetrics.map(item => item.alias), ['revenue_yoy', 'profit_yoy', 'orderCount_yoy']);
});

test('派生指标澄清支持自由文本全部选择并清除旧待决槽位', async () => {
  const executeQuery = async ({ requests }) => ({ resultSets: [resultSet(requests[0], [
    { period: '2023-01-01T00:00:00.000Z', revenue: 100, profit: 20, revenue_yoy: 0.1, profit_yoy: 0.2 },
    { period: '2024-01-01T00:00:00.000Z', revenue: 110, profit: 24, revenue_yoy: 0.1, profit_yoy: 0.2 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 120, profit: 28, revenue_yoy: 0.09, profit_yoy: 0.16 },
  ])] });
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, runAnalysis: async () => { throw new Error('不应降级'); }, executeQuery });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: '2023至2025年销售额、利润和同比增长率' });
  assert.equal(first.response.status, 'needs_clarification');
  const second = await store.ask(conversation.id, { question: '三个都算' });
  assert.equal(second.response.status, 'ok');
  assert.equal(second.conversation.pendingContext, null);
  assert.deepEqual(second.conversation.committedContext.intent.derivedMetrics.map(item => item.alias), ['revenue_yoy', 'profit_yoy']);
});

test('公式指标与泛化同比并存时澄清选择清除旧未决槽位', async () => {
  const formulaMetadata = { ...metadata, id: '2b445034-38fe-4350-9cab-b7684c28b5f8' };
  const formulaSkill = new SkillRegistry([JSON.parse(await readFile(new URL('../skills/sales/skill.json', import.meta.url), 'utf8'))]);
  const executeQuery = async ({ requests }) => ({ resultSets: [{ id: 'rs-formula-clarify', requestId: requests[0].id, schema: [
    { name: 'period', role: 'dimension', type: 'date', grain: 'year' },
    { name: 'revenue', role: 'measure', type: 'number' }, { name: 'profit', role: 'measure', type: 'number' },
    { name: 'gross_margin_rate', role: 'measure', type: 'number', format: 'percentage' },
    { name: 'revenue_yoy', role: 'measure', type: 'number', format: 'percentage' }, { name: 'profit_yoy', role: 'measure', type: 'number', format: 'percentage' },
  ], rows: [{ period: '2024-01-01', revenue: 100, profit: 20, gross_margin_rate: 0.2, revenue_yoy: 0.1, profit_yoy: 0.2 }, { period: '2025-01-01', revenue: 110, profit: 24, gross_margin_rate: 0.218, revenue_yoy: 0.1, profit_yoy: 0.2 }], quality: { isSample: false, isTruncated: false, warnings: [] } }] });
  const store = new SmartQueryConversationStore({ loadMetadata: async () => formulaMetadata, executeQuery, runAnalysis: async () => { throw new Error('不应走旧降级路径'); }, skillRegistry: formulaSkill });
  const conversation = await store.create({ datasetId: formulaMetadata.id });
  const first = await store.ask(conversation.id, { question: '过去两年每年销售额、利润和毛利率，并比较同比变化' });
  assert.equal(first.response.status, 'needs_clarification');
  const second = await store.ask(conversation.id, { question: '销售额和利润都做同比增长率', clarificationSelection: { concepts: ['revenue', 'profit'], mode: 'all' } });
  assert.equal(second.response.status, 'ok');
  assert.equal(second.conversation.pendingContext, null);
  assert.deepEqual(second.conversation.committedContext.intent.derivedMetrics.map(item => item.alias), ['gross_margin_rate', 'revenue_yoy', 'profit_yoy']);
});

test('澄清中的新问题不会继承旧的派生指标或筛选上下文', async () => {
  const executeQuery = async ({ requests }) => ({ resultSets: [resultSet(requests[0], [
    { period: '2023-01-01T00:00:00.000Z', revenue: 100, profit: 20 },
    { period: '2024-01-01T00:00:00.000Z', revenue: 110, profit: 24 },
    { period: '2025-01-01T00:00:00.000Z', revenue: 120, profit: 28 },
  ])] });
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, executeQuery, runAnalysis: async () => { throw new Error('不应走旧降级路径'); } });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: '销售额、利润和同比增长率' });
  assert.equal(first.response.status, 'needs_clarification');
  const fresh = await store.ask(conversation.id, { question: '2023至2025年每年销售额和利润' });
  assert.equal(fresh.response.status, 'ok');
  assert.deepEqual(fresh.conversation.committedContext.intent.derivedMetrics, []);
  assert.deepEqual(fresh.conversation.activeMetrics, ['订单金额', '订单利润']);
});
