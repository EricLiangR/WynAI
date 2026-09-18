import test from 'node:test';
import assert from 'node:assert/strict';

import { planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';
import { applyQueryProgram } from '../lib/query/query-program.mjs';
import {
  compileBusinessQueryIntent,
  normalizeBusinessQueryIntentV2,
  validateIntentCoverage,
} from '../lib/semantics/business-query-intent.mjs';

const metadata = {
  id: 'dataset-generic-records',
  revision: 1,
  name: '通用记录数据集',
  fields: [
    { name: '记录编号', role: 'identifier', type: 'String', rawType: 'String' },
    { name: '项目名称', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '金额', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '发生日期', role: 'time', type: 'Date', rawType: 'DateTime' },
  ],
};

function detailIntent(overrides = {}) {
  return normalizeBusinessQueryIntentV2({
    schema: 'wynai.business-query-intent/v2',
    businessQuestion: '列出每条原始记录，返回记录编号、项目名称、金额和发生日期，不聚合、不去重',
    metrics: [],
    derivedMetrics: [],
    dimensions: [
      { field: '记录编号', alias: 'record_id', concept: 'recordId', grain: null },
      { field: '项目名称', alias: 'project_name', concept: 'projectName', grain: null },
      { field: '金额', alias: 'amount', concept: 'amount', grain: null },
      { field: '发生日期', alias: 'occurred_at', concept: 'occurredAt', grain: null },
    ],
    filters: [],
    time: { field: null, calendar: null, timeZone: 'Asia/Shanghai', periods: [], range: null, grain: null },
    ranking: null,
    expectedResult: {
      shape: 'detail-table',
      minimumRows: 0,
      maximumRows: 20000,
      requiredPeriods: [],
      requiredMetrics: [],
      requiredDimensions: ['record_id', 'project_name', 'amount', 'occurred_at'],
      timeZone: 'Asia/Shanghai',
    },
    constraints: [],
    assumptions: [],
    confidence: 1,
    skillRefs: [],
    mappingEvidence: [],
    ambiguities: [],
    ...overrides,
  }, { metadata });
}

test('BusinessQueryIntent 以 detail-table 保留原始数值和日期投影并编译为受控投影查询', () => {
  const intent = detailIntent();
  const compiled = compileBusinessQueryIntent(metadata, intent);
  assert.equal(compiled.status, 'supported');
  assert.equal(compiled.request.mode, 'projection');
  assert.equal(compiled.request.sensitivity, 'controlled-detail');
  assert.equal(compiled.request.limit, 20000);
  assert.deepEqual(compiled.request.select.map(item => item.field), ['记录编号', '项目名称', '金额', '发生日期']);
  assert.deepEqual(compiled.request.measures, []);
  assert.deepEqual(compiled.request.orderBy, []);
  assert.deepEqual(compiled.displayRequest.select.map(item => item.field), ['记录编号', '项目名称', '金额', '发生日期']);
});

test('包含数值和日期返回字段的列表请求按字段角色直接规范为投影查询', async () => {
  let calls = 0;
  const llm = {
    enabled: true,
    async planQueryIntent({ repairFeedback }) {
      calls += 1;
      assert.equal(repairFeedback, undefined);
      return detailIntent({
        businessQuestion: '有哪些记录，返回项目名称、金额和发生日期',
        metrics: [{ field: '金额', aggregation: 'sum', alias: 'amount_sum', concept: 'amount' }],
        dimensions: [
          { field: '项目名称', alias: 'project_name', concept: 'projectName', grain: null },
          { field: '金额', alias: 'amount', concept: 'amount', grain: null },
          { field: '发生日期', alias: 'occurred_at', concept: 'occurredAt', grain: null },
        ],
        expectedResult: {
          shape: 'grouped-table', minimumRows: 0, maximumRows: 20000,
          requiredPeriods: [], requiredMetrics: ['amount_sum'],
          requiredDimensions: ['project_name', 'amount', 'occurred_at'], timeZone: 'Asia/Shanghai',
        },
      });
    },
  };

  const plan = await planBusinessQuestionAsync({
    metadata,
    question: '有哪些记录，返回项目名称、金额和发生日期',
    now: new Date('2026-09-14T12:00:00+08:00'),
    llm,
  });
  assert.equal(plan.status, 'supported', JSON.stringify(plan));
  assert.equal('queryMode' in plan.intent, false);
  assert.equal(plan.request.mode, 'projection');
  assert.deepEqual(plan.request.measures, []);
  assert.equal(plan.plannerDiagnostics.repairAttempted, false);
  assert.equal(plan.plannerDiagnostics.llmCalls, 1);
  assert.equal(calls, 1);
});

test('普通去重名单被模型标为 detail-table 时按查询结构规范为 grouped-table', async () => {
  const llm = {
    enabled: true,
    async planQueryIntent() {
      return detailIntent({
        businessQuestion: '列出项目名单',
        dimensions: [{ field: '项目名称', alias: 'project_name', concept: 'projectName', grain: null }],
        expectedResult: {
          shape: 'detail-table', minimumRows: 0, maximumRows: 20000,
          requiredPeriods: [], requiredMetrics: [], requiredDimensions: ['project_name'], timeZone: 'Asia/Shanghai',
        },
      });
    },
  };

  const plan = await planBusinessQuestionAsync({
    metadata,
    question: '列出项目名单',
    now: new Date('2026-09-17T12:00:00+08:00'),
    llm,
  });
  assert.equal(plan.status, 'supported', JSON.stringify(plan));
  assert.equal(plan.intent.expectedResult.shape, 'grouped-table');
  assert.equal(plan.request.mode, 'aggregate');
  assert.equal(plan.request.measures[0].aggregation, 'distinctCount');
});

test('detail 模式拒绝聚合指标、派生指标和聚合排名', () => {
  const invalid = detailIntent({
    metrics: [{ field: '金额', aggregation: 'sum', alias: 'total_amount', concept: 'amount' }],
    derivedMetrics: [{ type: 'share-of-total', sourceAlias: 'total_amount', alias: 'amount_share' }],
    ranking: { orderBy: 'total_amount', direction: 'desc', limit: 10 },
  });
  const validation = validateIntentCoverage(invalid);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('；'), /不得包含聚合指标/);
  assert.match(validation.errors.join('；'), /不得包含派生指标/);
  assert.match(validation.errors.join('；'), /不得包含聚合排名/);
  assert.equal(compileBusinessQueryIntent(metadata, invalid).status, 'needs_clarification');
});

test('受限明细结果的未知总行数在 QueryProgram 后仍保持 null', () => {
  const compiled = compileBusinessQueryIntent(metadata, detailIntent());
  const rows = [
    { record_id: 'R-1', project_name: 'A', amount: 10, occurred_at: '2026-01-01' },
    { record_id: 'R-2', project_name: 'B', amount: 20, occurred_at: '2026-01-02' },
  ];
  const result = applyQueryProgram({
    schema: [
      { name: 'record_id', role: 'dimension', type: 'string' },
      { name: 'project_name', role: 'dimension', type: 'string' },
      { name: 'amount', role: 'dimension', type: 'number' },
      { name: 'occurred_at', role: 'dimension', type: 'date' },
    ],
    rows,
    statistics: { rowCount: 2, totalRowCount: null, returnedRowCount: 2 },
    quality: { isSample: true, isTruncated: true, limitReached: true, totalRowCount: null },
  }, compiled.queryProgram);

  assert.equal(result.statistics.totalRowCount, null);
  assert.equal(result.quality.totalRowCount, null);
  assert.equal(result.statistics.internalCalculationRowCount, 2);
});
