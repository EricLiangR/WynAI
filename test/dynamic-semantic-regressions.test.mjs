import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';
import { loadSkillsFromDirectory } from '../lib/skills/skill-registry.mjs';

const metadata = {
  id: 'dynamic-semantic-regression-fixture',
  revision: 1,
  fields: [
    { name: 'pipelineCode', role: 'identifier', type: 'String', rawType: 'String' },
    { name: 'pipelineName', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '客户名称', role: 'dimension', type: 'String', rawType: 'String' },
    { name: 'recurring', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '预计结束日期', role: 'time', type: 'Date', rawType: 'Date' },
    { name: '赢单财年', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '赢单季度', role: 'dimension', type: 'String', rawType: 'String' },
    { name: 'Opportunity_amount_CNY', role: 'measure', type: 'Number', rawType: 'Double' },
  ],
};

const skill = {
  id: 'sales-opportunity-regression-fixture',
  version: '1.0.0',
  status: 'approved',
  defaultCalendar: 'fiscal',
  calendarPolicy: {
    default: 'fiscal',
    fiscalYearField: '赢单财年',
    dateField: '预计结束日期',
    fiscalYearStart: '06-01',
  },
  metrics: [
    { name: '商机数量', field: 'pipelineCode', aggregation: 'distinctCount', synonyms: ['商机数'] },
  ],
  businessEntities: [
    { id: 'customer', name: '客户', field: '客户名称', synonyms: ['客户名单'] },
    { id: 'opportunity', name: '商机', field: 'pipelineCode', synonyms: ['项目'] },
  ],
  temporalSemantics: [
    { id: 'won-quarter', field: '赢单季度', grain: 'quarter' },
  ],
};

function baseIntent(overrides = {}) {
  return {
    schema: 'wynai.business-query-intent/v2',
    businessQuestion: '动态语义回归问题',
    metrics: [],
    derivedMetrics: [],
    dimensions: [],
    filters: [],
    time: {
      field: null,
      calendar: null,
      timeZone: 'Asia/Shanghai',
      periods: [],
      range: null,
      grain: null,
    },
    ranking: null,
    expectedResult: {
      shape: 'grouped-table',
      minimumRows: 0,
      maximumRows: 20000,
      requiredPeriods: [],
      requiredMetrics: [],
      requiredDimensions: [],
      timeZone: 'Asia/Shanghai',
    },
    constraints: [],
    assumptions: [],
    confidence: 1,
    skillRefs: [],
    mappingEvidence: [],
    ambiguities: [],
    ...overrides,
  };
}

function intentFor(question) {
  if (question.includes('客户名单')) {
    return baseIntent({
      businessQuestion: question,
      filters: [{ field: 'recurring', operator: 'eq', value: 'No' }],
      dimensions: [{ field: '客户名称', alias: 'customer', concept: 'customer', grain: null }],
      expectedResult: {
        ...baseIntent().expectedResult,
        requiredDimensions: ['customer'],
      },
    });
  }
  if (question.includes('赢单季度')) {
    return baseIntent({
      businessQuestion: question,
      metrics: [
        { field: 'Opportunity_amount_CNY', aggregation: 'sum', alias: 'revenue', concept: 'revenue' },
        { field: 'pipelineCode', aggregation: 'distinctCount', alias: 'opportunity_count', concept: 'opportunityCount' },
      ],
      dimensions: [{ field: '赢单季度', alias: 'won_quarter', concept: 'wonQuarter', grain: 'quarter' }],
      time: {
        ...baseIntent().time,
        field: '赢单财年',
        calendar: 'fiscal',
        periods: ['26'],
        grain: 'quarter',
        groupingExplicit: true,
        authority: { calendar: 'fiscal', fiscalYearField: '赢单财年' },
      },
      filters: [{ field: '赢单财年', operator: 'eq', value: '26' }],
      expectedResult: {
        ...baseIntent().expectedResult,
        shape: 'time-series',
        requiredMetrics: ['revenue', 'opportunity_count'],
        requiredDimensions: ['won_quarter'],
        requiredPeriods: ['26'],
      },
    });
  }
  return baseIntent({
    businessQuestion: question,
    dimensions: [
      { field: 'pipelineName', alias: 'project', concept: 'projectName', grain: null },
      { field: '客户名称', alias: 'customer', concept: 'customer', grain: null },
      { field: '预计结束日期', alias: 'end_date', concept: 'endDate', grain: null },
    ],
    expectedResult: {
      ...baseIntent().expectedResult,
      requiredDimensions: ['project', 'customer', 'end_date'],
    },
  });
}

async function plan(question) {
  return planWithSkills(question, [skill]);
}

async function planWithSkills(question, skills) {
  return planBusinessQuestionAsync({
    metadata,
    skills,
    question,
    now: new Date('2026-09-29T12:00:00+08:00'),
    llm: {
      enabled: true,
      async planQueryIntent() {
        return intentFor(question);
      },
    },
  });
}

test('动态回归：客户名单不因数据集存在 pipelineCode 而扩展到商机粒度', async () => {
  const planResult = await plan('所有财年中不是 recurring 的客户名单');
  assert.equal(planResult.status, 'supported', JSON.stringify(planResult));
  assert.equal(planResult.request.mode, 'projection');
  assert.deepEqual(planResult.request.select.map(item => item.field), ['客户名称']);
  assert.equal(planResult.request.select.some(item => item.field === 'pipelineCode'), false);
  assert.deepEqual(planResult.request.measures, []);
  assert.deepEqual(planResult.displayRequest.measures, []);
});

test('动态回归：商机列表保留 LLM 选择的业务字段，不自动扩展 pipelineCode 粒度', async () => {
  const planResult = await plan('去年产品小类为 Risk Management 的商机，返回项目名称、客户和预计结束日期');
  assert.equal(planResult.status, 'supported', JSON.stringify(planResult));
  assert.equal(planResult.request.mode, 'projection');
  assert.equal(planResult.request.select.some(item => item.field === 'pipelineCode'), false);
  assert.deepEqual(planResult.request.measures, []);
  assert.deepEqual(planResult.request.select.map(item => item.field), ['pipelineName', '客户名称', '预计结束日期']);
  assert.deepEqual(planResult.displayRequest.measures, []);
});

test('动态回归：Skill 声明的赢单季度可作为 Wyn 时间分组维度', async () => {
  const planResult = await plan('去年按赢单季度统计销售额和商机数量');
  assert.equal(planResult.status, 'supported', JSON.stringify(planResult));
  assert.equal(['aggregate', 'compare'].includes(planResult.request.mode), true);
  assert.equal(planResult.request.select.some(item => item.field === '赢单季度' && item.grain === 'quarter'), true);
  assert.equal(planResult.request.measures.some(item => item.alias === 'revenue'), true);
  assert.equal(planResult.request.measures.some(item => item.alias === 'opportunity_count'), true);
});

test('动态回归：注册器加载的时间语义仍可作为 Wyn 时间分组维度', async () => {
  const registry = await loadSkillsFromDirectory(fileURLToPath(new URL('../skills', import.meta.url)));
  const loadedSkill = registry.resolve({
    datasetId: '18b86197-65e3-4682-8501-6e7125afad02',
    question: '去年按赢单季度统计销售额和商机数量',
  }).find(item => item.id === 'sales-opportunity-a53');
  assert.ok(loadedSkill);
  const planResult = await planWithSkills('去年按赢单季度统计销售额和商机数量', [loadedSkill]);
  assert.equal(planResult.status, 'supported', JSON.stringify(planResult));
  assert.equal(planResult.request.select.some(item => item.field === '赢单季度' && item.grain === 'quarter'), true);
});
