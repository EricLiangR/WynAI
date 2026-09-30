import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExecutableRequestSubset,
  compiledRequestUnitCoverageErrors,
  executableRequestUnitCoverageErrors
} from '../lib/semantics/request-unit-policy.mjs';
import { planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';
import { normalizeAIInteractionResponse } from '../lib/protocol/interaction-contract.mjs';

const now = new Date('2026-09-28T08:00:00+08:00');
const metadata = {
  id: 'single-authority-fixture', revision: 1, name: '通用商机数据',
  fields: [
    { name: '赢单财年', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '预计赢单日期', role: 'time', type: 'Date', rawType: 'Date' },
    { name: '销售地区', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '产品名称', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '产品大类', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '客户名称', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '客户母公司所在地', role: 'geography', type: 'String', rawType: 'String' },
    { name: '商机金额', role: 'measure', type: 'Number', rawType: 'Number' },
    { name: '商机编号', role: 'identifier', type: 'String', rawType: 'String' },
  ],
};

function baseIntent({ question, dimensions = [], metrics = [], requestUnits = [] }) {
  return {
    schema: 'wynai.business-query-intent/v2',
    businessQuestion: question,
    metrics,
    derivedMetrics: [],
    dimensions,
    filters: [],
    resultFilters: [],
    time: { field: null, calendar: null, timeZone: 'Asia/Shanghai', periods: [], range: null, grain: null },
    ranking: null,
    expectedResult: {
      shape: dimensions.length ? 'grouped-table' : 'scalar', minimumRows: 0, maximumRows: 20000,
      requiredPeriods: [], requiredMetrics: metrics.map(item => item.alias),
      requiredDimensions: dimensions.map(item => item.alias), timeZone: 'Asia/Shanghai',
    },
    constraints: [], assumptions: [], ambiguities: [], requestUnits,
  };
}

function fixedModel(intent) {
  return { enabled: true, async planQueryIntent() { return structuredClone(intent); } };
}

test('生产 LLM 路径接受模型选择的财年字段，不再用确定性日期基线否决', async () => {
  const question = '各财年的收入统计';
  const intent = baseIntent({
    question,
    dimensions: [{ field: '赢单财年', alias: 'fiscal_year', concept: 'time', grain: null }],
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [
      { id: 'year', kind: 'dimension', sourceText: '各财年', status: 'executable', criticality: 'scope-defining', field: '赢单财年', alias: 'fiscal_year' },
      { id: 'revenue', kind: 'metric', sourceText: '收入', status: 'executable', criticality: 'independent', field: '商机金额', alias: 'revenue' },
    ],
  });
  intent.time = {
    ...intent.time,
    field: '赢单财年',
    calendar: 'fiscal',
    groupingExplicit: false,
  };
  const result = await planBusinessQuestionAsync({ metadata, question, now, llm: fixedModel(intent) });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.select.map(item => item.field), ['赢单财年']);
  assert.equal(result.request.measures[0].field, '商机金额');
});

test('编译后 Canonical 查询遗漏可执行维度时必须被契约校验拦截', () => {
  const intent = baseIntent({
    question: '各财年的收入统计',
    dimensions: [{ field: '赢单财年', alias: 'fiscal_year', concept: 'time', grain: null }],
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    requestUnits: [
      { id: 'year', kind: 'dimension', sourceText: '各财年', status: 'executable', criticality: 'scope-defining', field: '赢单财年', alias: 'fiscal_year' },
    ],
  });
  const errors = compiledRequestUnitCoverageErrors(intent, {
    request: { select: [], measures: [{ field: '商机金额', alias: 'revenue' }], filters: [] },
    intent: { ...intent, dimensions: [] },
  });
  assert.deepEqual(errors, ['requestUnits 声明为可执行的要求未进入最终 Canonical 查询：各财年（dimension）']);
});

test('聚合结果筛选 resultFilters 也属于可执行筛选覆盖范围', () => {
  const intent = baseIntent({
    question: '按产品统计金额并筛选总金额大于1000万',
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '产品名称', alias: 'product', concept: 'product', grain: null }],
    requestUnits: [
      { id: 'amount-threshold', kind: 'filter', sourceText: '总金额大于1000万', status: 'executable', criticality: 'scope-defining', field: 'revenue', alias: 'revenue' },
    ],
  });
  intent.resultFilters = [{ field: 'revenue', operator: 'gt', value: 10_000_000 }];
  assert.deepEqual(executableRequestUnitCoverageErrors(intent), []);
});

test('结构化时间范围属于可执行筛选覆盖范围', () => {
  const intent = baseIntent({
    question: '截止目前的销售额',
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    requestUnits: [
      { id: 'as-of', kind: 'filter', sourceText: '截止目前', status: 'executable', criticality: 'scope-defining', field: '赢单财年', alias: '赢单财年' },
    ],
  });
  intent.time = {
    ...intent.time,
    field: '赢单财年',
    calendar: 'fiscal',
    periods: ['27'],
    modifier: 'current-fiscal-year',
  };
  assert.deepEqual(executableRequestUnitCoverageErrors(intent), []);
});

test('生产 LLM 路径将截止目前物化为日期排他上界并由 Wyn 执行', async () => {
  const question = '截止目前的销售额';
  const skill = {
    id: 'date-authority', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '赢单财年', dateField: '预计赢单日期', fiscalYearStart: '06-01' },
  };
  const intent = baseIntent({
    question,
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [{ id: 'as-of', kind: 'filter', sourceText: '截止目前', status: 'executable', criticality: 'scope-defining' }],
  });
  const result = await planBusinessQuestionAsync({
    metadata, question, skills: [skill], now: new Date('2026-09-28T08:00:00+08:00'), llm: fixedModel(intent),
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters, [{ field: '预计赢单日期', operator: 'lt', value: '2026-09-29', fieldType: 'time' }]);
  assert.equal(result.intent.time.scopePolicy, 'cumulative-to-date');
});

test('生产 LLM 路径将所有财年作为无过滤时间契约执行', async () => {
  const question = '所有财年中按销售地区统计收入';
  const skill = {
    id: 'fiscal-authority', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '赢单财年', dateField: '预计赢单日期', fiscalYearStart: '06-01' },
  };
  const intent = baseIntent({
    question,
    dimensions: [{ field: '销售地区', alias: 'region', concept: 'region', grain: null }],
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [{ id: 'all-years', kind: 'filter', sourceText: '所有财年', status: 'executable', criticality: 'scope-defining' }],
  });
  const result = await planBusinessQuestionAsync({
    metadata, question, skills: [skill], now, llm: fixedModel(intent),
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters, []);
  assert.equal(result.intent.time.scopePolicy, 'all-periods');
  assert.equal(result.intent.time.allPeriods, true);
});

test('最终 Canonical 查询的 resultFilters 也必须满足请求单元守恒', () => {
  const intent = baseIntent({
    question: '按产品统计金额并筛选总金额大于1000万',
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [{ field: '产品名称', alias: 'product', concept: 'product', grain: null }],
    requestUnits: [
      { id: 'amount-threshold', kind: 'filter', sourceText: '总金额大于1000万', status: 'executable', criticality: 'scope-defining', field: 'revenue', alias: 'revenue' },
    ],
  });
  const compiled = {
    request: {
      select: [{ field: '产品名称', alias: 'product' }],
      measures: [{ field: '商机金额', alias: 'revenue' }],
      filters: [],
      resultFilters: [{ field: 'revenue', operator: 'gt', value: 10_000_000 }],
    },
    intent,
  };
  assert.deepEqual(compiledRequestUnitCoverageErrors(intent, compiled), []);
});

test('编译后守恒校验识别 Wyn 排名后下钻阶段的真实返回维度', () => {
  const intent = baseIntent({
    question: '我最热卖的产品是什么，是哪些客户',
    dimensions: [
      { field: '产品名称', alias: 'product', concept: 'product', grain: null },
      { field: '客户名称', alias: 'customer', concept: 'customer', grain: null },
    ],
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    requestUnits: [
      { id: 'customer', kind: 'projection', sourceText: '是哪些客户', status: 'executable', criticality: 'required-output', field: '客户名称', alias: 'customer' },
    ],
  });
  const errors = compiledRequestUnitCoverageErrors(intent, {
    request: {
      select: [{ field: '产品名称', alias: 'product' }],
      measures: [{ field: '商机金额', alias: 'revenue' }],
      filters: [],
    },
    queryProgram: {
      stagedQuery: {
        type: 'wyn-rank-then-drilldown',
        drilldownDimensions: [{ field: '客户名称', alias: 'customer' }],
      },
    },
    intent,
  });
  assert.deepEqual(errors, []);
});

test('生产 LLM 路径接受模型选择的地区字段，不再被另一字段基线覆盖', async () => {
  const question = '各地区收入、项目数量统计';
  const intent = baseIntent({
    question,
    dimensions: [{ field: '销售地区', alias: 'region', concept: 'region', grain: null }],
    metrics: [
      { field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false },
      { field: '商机编号', aggregation: 'distinctCount', alias: 'project_count', concept: 'projectCount', internal: false },
    ],
  });
  const result = await planBusinessQuestionAsync({ metadata, question, now, llm: fixedModel(intent) });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.select.map(item => item.field), ['销售地区']);
});

test('可执行请求单元的真实维度必须进入查询，不能静默汇总为单值', async () => {
  const question = '每年的收入和项目数量';
  const fiscalSkill = {
    id: 'fiscal-default', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '赢单财年', dateField: '预计赢单日期', fiscalYearStart: '06-01' },
  };
  const unit = { id: 'year', kind: 'dimension', sourceText: '每年', status: 'executable', criticality: 'scope-defining', field: '赢单财年', alias: 'fiscal_year' };
  const omitted = baseIntent({
    question,
    metrics: [
      { field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' },
      { field: '商机编号', aggregation: 'distinctCount', alias: 'project_count', concept: 'projectCount' },
    ],
    requestUnits: [unit],
  });
  let calls = 0;
  const result = await planBusinessQuestionAsync({
    metadata, question, now, skills: [fiscalSkill],
    llm: { enabled: true, async planQueryIntent() {
      calls += 1;
      return structuredClone(omitted);
    } },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.select.map(item => item.field), ['赢单财年']);
});

test('相对财年先物化再校验请求单元，去年分组排名不会被错误拦截', async () => {
  const question = '去年按产品大类统计商机数量，列出数量最多的前三个产品大类';
  const fiscalSkill = {
    id: 'fiscal-default', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '赢单财年', dateField: '预计赢单日期', fiscalYearStart: '06-01' },
  };
  const intent = baseIntent({
    question,
    dimensions: [{ field: '产品大类', alias: 'product_category', concept: 'productCategory', grain: null }],
    metrics: [{ field: '商机编号', aggregation: 'distinctCount', alias: 'opportunity_count', concept: 'opportunityCount', internal: false }],
    requestUnits: [
      { id: 'last-year', kind: 'filter', sourceText: '去年', status: 'executable', criticality: 'scope-defining', field: '赢单财年' },
      { id: 'category', kind: 'dimension', sourceText: '产品大类', status: 'executable', criticality: 'required-output', field: '产品大类', alias: 'product_category' },
      { id: 'count', kind: 'metric', sourceText: '商机数量', status: 'executable', criticality: 'independent', field: '商机编号', alias: 'opportunity_count' },
      { id: 'rank', kind: 'ranking', sourceText: '数量最多的前三个', status: 'executable', criticality: 'scope-defining', alias: 'top-three' },
    ],
  });
  intent.ranking = {
    source: '数量最多的前三个产品大类', orderBy: 'opportunity_count', direction: 'desc', limit: 3,
    byDimension: 'product_category', thenDrilldown: false, drilldownDimensions: [],
  };
  const result = await planBusinessQuestionAsync({
    metadata, question, now, skills: [fiscalSkill], llm: fixedModel(intent),
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters, [{ field: '赢单财年', operator: 'eq', value: '26', fieldType: 'dimension' }]);
  assert.equal(result.request.select[0].field, '产品大类');
  assert.equal(result.request.limit, 3);
});

test('不存在的辅助返回字段不阻断其余可信查询并形成部分完成契约', async () => {
  const question = '统计收入，并返回不存在的备注字段';
  const intent = baseIntent({
    question,
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [
      { id: 'revenue', kind: 'metric', sourceText: '收入', status: 'executable', criticality: 'independent', field: '商机金额', alias: 'revenue' },
      { id: 'note', kind: 'projection', sourceText: '备注字段', status: 'unsupported', criticality: 'optional-output', field: '不存在的备注字段', reason: '当前数据集没有该字段' },
    ],
  });
  const result = await planBusinessQuestionAsync({ metadata, question, now, llm: fixedModel(intent) });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(result.completion.status, 'partial');
  assert.equal(result.completion.omittedUnits[0].sourceText, '备注字段');
  assert.equal(result.request.measures[0].field, '商机金额');
});

test('缺失筛选条件属于范围定义要求，不能通过删除条件扩大查询', async () => {
  const question = '统计神秘状态客户的收入';
  const intent = baseIntent({
    question,
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [
      { id: 'scope', kind: 'filter', sourceText: '神秘状态客户', status: 'unsupported', criticality: 'scope-defining', field: '不存在状态', reason: '当前数据集没有该筛选字段' },
      { id: 'revenue', kind: 'metric', sourceText: '收入', status: 'executable', criticality: 'independent', field: '商机金额', alias: 'revenue' },
    ],
  });
  const result = await planBusinessQuestionAsync({ metadata, question, now, llm: fixedModel(intent) });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.plannerDiagnostics.reason, 'request-unit-blocked');
  assert.equal(result.request, undefined);
});

test('LLM 声明具体对象值缺失时必须澄清，不能扩大为全量查询', async () => {
  const question = '某个客户的商机金额是多少';
  const intent = baseIntent({
    question,
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [
      { id: 'customer', kind: 'filter', sourceText: '某个客户', status: 'ambiguous', criticality: 'scope-defining', field: '客户名称', reason: '缺少可解析的具体客户值' },
      { id: 'revenue', kind: 'metric', sourceText: '商机金额', status: 'executable', criticality: 'independent', field: '商机金额', alias: 'revenue' },
    ],
  });
  intent.constraints = [{ id: 'customer', type: 'entity-value', source: '某个客户', normalized: null, required: true, status: 'unresolved' }];
  intent.ambiguities = [{ id: 'customer', slotId: 'customer', question: '请提供具体客户名称。', options: [], blocking: true, required: true }];
  const result = await planBusinessQuestionAsync({ metadata, question, now, llm: fixedModel(intent) });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.request, undefined);
});

test('首轮 LLM 意图成功后不再由隐式语义审计补写范围条件', async () => {
  const question = '某个客户的商机金额是多少';
  const unsafe = baseIntent({
    question,
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [{ id: 'revenue', kind: 'metric', sourceText: '商机金额', status: 'executable', criticality: 'independent', field: '商机金额', alias: 'revenue' }],
  });
  const reviewed = structuredClone(unsafe);
  reviewed.requestUnits.unshift({ id: 'customer', kind: 'filter', sourceText: '某个客户', status: 'ambiguous', criticality: 'scope-defining', field: '客户名称', reason: '缺少可解析的具体客户值' });
  reviewed.constraints = [{ id: 'customer', type: 'entity-value', source: '某个客户', normalized: null, required: true, status: 'unresolved' }];
  reviewed.ambiguities = [{ id: 'customer', slotId: 'customer', question: '请提供具体客户名称。', options: [], blocking: true, required: true }];
  let planned = 0;
  let reviewedCalls = 0;
  const result = await planBusinessQuestionAsync({
    metadata, question, now,
    llm: {
      enabled: true,
      async planQueryIntent() { planned += 1; return structuredClone(unsafe); },
      async reviewQueryIntent({ candidateIntent }) {
        reviewedCalls += 1;
        assert.equal(candidateIntent.businessQuestion, question);
        return structuredClone(reviewed);
      },
    },
  });
  assert.equal(planned, 1);
  assert.equal(reviewedCalls, 0);
  assert.equal(result.status, 'supported');
  assert.equal(result.plannerDiagnostics.auditAttempted, false);
  assert.deepEqual(result.intent.filters, []);
  assert.equal(result.intent.requestUnits[0].alias, 'revenue');
});

test('排名及下钻请求单元按结构化排名语义覆盖，不因 sourceText 产生误阻断', async () => {
  const intent = baseIntent({
    question: '我最热卖的产品是什么，是哪些客户',
    dimensions: [
      { field: '产品名称', alias: 'product', concept: 'product', grain: null },
      { field: '客户名称', alias: 'customer_name', concept: 'customer', grain: null },
    ],
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    requestUnits: [
      { id: 'rank', kind: 'ranking', sourceText: '最热卖', status: 'executable', criticality: 'scope-defining', alias: 'top_product' },
      { id: 'customer', kind: 'projection', sourceText: '是哪些客户', status: 'executable', criticality: 'required-output', field: '客户名称', alias: 'customer_name' },
    ],
  });
  intent.ranking = {
    source: '最热卖', orderBy: 'revenue', direction: 'desc', limit: 1,
    thenDrilldown: true, byDimension: 'product', drilldownDimensions: ['customer_name'],
  };
  assert.deepEqual(executableRequestUnitCoverageErrors(intent), []);
});

test('排名请求单元不能被缺少排序指标和方向的不完整 ranking 覆盖', () => {
  const intent = baseIntent({
    question: '我最热卖的产品是什么',
    dimensions: [{ field: '产品名称', alias: 'product', concept: 'product', grain: null }],
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    requestUnits: [
      { id: 'rank', kind: 'ranking', sourceText: '最热卖', status: 'executable', criticality: 'scope-defining', alias: 'top_product' },
    ],
  });
  intent.ranking = { source: '最热卖', byDimension: 'product' };
  assert.match(executableRequestUnitCoverageErrors(intent)[0], /最热卖（ranking）/);
});

test('LLM 已声明的真实返回字段可从 requestUnits 归一化到 dimensions', () => {
  const intent = baseIntent({
    question: '我最热卖的产品是什么，是哪些客户',
    dimensions: [{ field: '产品名称', alias: 'product', concept: 'product', grain: null }],
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    requestUnits: [
      { id: 'rank', kind: 'ranking', sourceText: '最热卖', status: 'executable', criticality: 'scope-defining', alias: 'top_product' },
      { id: 'customer', kind: 'projection', sourceText: '是哪些客户', status: 'executable', criticality: 'required-output', field: '客户名称', alias: 'customer' },
    ],
  });
  intent.ranking = {
    source: '最热卖', orderBy: 'revenue', direction: 'desc', limit: 1,
    thenDrilldown: true, byDimension: 'product', drilldownDimensions: ['customer'],
  };
  const result = applyExecutableRequestSubset(intent, metadata);
  assert.equal(result.status, 'executable');
  assert.deepEqual(result.intent.dimensions.map(item => item.alias), ['product', 'customer']);
});

test('没有具体字段的列表请求由实际明细维度满足，而不是把“有哪些”当成字段', () => {
  const intent = baseIntent({
    question: '有哪些商机',
    dimensions: [{ field: '销售地区', alias: 'project_name', concept: 'projectName', grain: null }],
    requestUnits: [{
      id: 'list', kind: 'projection', sourceText: '有哪些', status: 'executable',
      criticality: 'required-output', dependencies: [],
    }],
  });
  assert.deepEqual(executableRequestUnitCoverageErrors(intent), []);
});

test('列表请求不应因模型未填写结果 shape 而被错误拦截', () => {
  const intent = {
    ...baseIntent({
      question: 'recurring 的商机有哪些',
      dimensions: [{ field: '商机编号', alias: 'opportunity_id', concept: 'opportunity', grain: null }],
      requestUnits: [{
        id: 'list', kind: 'projection', sourceText: '有哪些', status: 'executable',
        criticality: 'required-output', dependencies: [],
      }],
    }),
    expectedResult: { ...baseIntent({}).expectedResult, shape: undefined },
  };
  assert.deepEqual(executableRequestUnitCoverageErrors(intent), []);
});

test('独立派生指标缺少依赖时可省略该指标并返回其它独立指标', () => {
  const intent = baseIntent({
    question: '统计收入和不存在的增长率',
    metrics: [{ field: '商机金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue', internal: false }],
    requestUnits: [
      { id: 'revenue', kind: 'metric', sourceText: '收入', status: 'executable', criticality: 'independent', field: '商机金额', alias: 'revenue' },
      { id: 'growth', kind: 'derived', sourceText: '增长率', status: 'unsupported', criticality: 'dependency', alias: 'growth', reason: '缺少必要依赖' },
    ],
  });
  const result = applyExecutableRequestSubset(intent, metadata);
  assert.equal(result.status, 'executable');
  assert.equal(result.completion.status, 'partial');
  assert.deepEqual(result.intent.metrics.map(item => item.alias), ['revenue']);
});

test('交互协议显式保留 completed-partial 和未完成单元', () => {
  const response = normalizeAIInteractionResponse({
    status: 'completed-partial',
    queryRequests: [],
    completion: { status: 'partial', executedUnitIds: ['revenue'], omittedUnits: [{ id: 'note', sourceText: '备注', reason: '字段不存在' }] },
  });
  assert.equal(response.status, 'completed-partial');
  assert.equal(response.completion.status, 'partial');
  assert.equal(response.completion.omittedUnits[0].reason, '字段不存在');
});

