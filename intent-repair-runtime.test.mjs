import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmGateway } from './llm-gateway.mjs';
import { createExplorationLlm } from './lib/llm/exploration-agent.mjs';
import { planBusinessQuestionAsync } from './lib/conversation/question-planner.mjs';

const metadata = { id: 'generic-repairs', fields: [
  { name: '订单金额', role: 'measure', type: 'Number' },
  { name: '产品名称', role: 'dimension', type: 'String' },
  { name: 'LedgerYear', role: 'dimension', type: 'String' },
] };
const good = { businessQuestion: '今年按产品统计销售额', metrics: [{ field: '订单金额', alias: 'revenue', aggregation: 'sum', concept: 'revenue' }],
  dimensions: [{ field: '产品名称', alias: 'product', concept: 'product' }],
  filters: [{ field: 'LedgerYear', operator: 'eq', value: '27' }],
  time: { field: 'LedgerYear', periods: ['27'], grain: 'year', grouping: null, groupingExplicit: false },
  expectedResult: { shape: 'table', requiredMetrics: ['revenue'], requiredDimensions: ['product'], requiredPeriods: ['27'] },
};
const skills = [{ id: 'generic-calendar', defaultCalendar: 'fiscal', calendarPolicy: { fiscalYearField: 'LedgerYear', fiscalYearStart: '06-01' } }];

test('Categorical grouping with a fiscal filter does not require a time-series column', async () => {
  const plan = await planBusinessQuestionAsync({ metadata, question: good.businessQuestion, skills, now: new Date('2026-09-11'),
    llm: { enabled: true, planQueryIntent: async () => structuredClone(good) } });
  assert.equal(plan.status, 'supported', plan.message);
  assert.deepEqual(plan.displayRequest.select.map(item => item.field), ['产品名称']);
});

test('Repair transport bypasses cached invalid JSON even with identical feedback', async () => {
  let calls = 0;
  const gateway = createLlmGateway({ providers: [{ id: 'test', baseUrl: 'https://example.test', model: 'fixture' }], cacheTtlMs: 60000,
    fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ attempt: calls }) } }] }), { status: 200 }); } });
  const llm = createExplorationLlm({ baseUrl: 'https://example.test', model: 'fixture', transport: ({ messages, ...options }) => gateway.completeJson(messages, options) });
  const input = { metadata, question: '销售额', repairFeedback: 'Invalid field' };
  await llm.planQueryIntent(input);
  await llm.planQueryIntent(input);
  assert.equal(calls, 2);
});

test('Each bounded repair includes the previous invalid intent', async () => {
  const calls = [];
  const invalid = { ...good, metrics: [{ field: 'unknown', alias: 'revenue', aggregation: 'sum' }] };
  const plan = await planBusinessQuestionAsync({ metadata, question: good.businessQuestion, skills, now: new Date('2026-09-11'), llm: {
    enabled: true, planQueryIntent: async input => { calls.push(structuredClone(input)); return structuredClone(calls.length < 3 ? invalid : good); },
  } });
  assert.equal(plan.status, 'supported', plan.message);
  assert.deepEqual(calls[1].previousInvalidIntent, invalid);
  assert.deepEqual(calls[2].previousInvalidIntent, invalid);
  assert.equal(calls[2].repairAttempt, 2);
});

test('Fiscal reference explicitly distinguishes the requested year from the anchor year', async () => {
  let input;
  await planBusinessQuestionAsync({ metadata, question: '去年销售额', skills, now: new Date('2026-09-11'), llm: { enabled: true, planQueryIntent: async value => { input = value; return structuredClone(good); } } });
  assert.equal(input.temporalReference.scope, 'requested-period');
  assert.equal(input.temporalReference.anchorFiscalYear, '27');
  assert.equal(input.temporalReference.relativeOffset, -1);
  assert.deepEqual(input.temporalReference.periods, ['26']);
});

test('Repeated singleton containsAny requires the LLM to make union versus intersection explicit', async () => {
  const tagged = { ...metadata, fields: [...metadata.fields, { name: 'Labels', role: 'dimension', type: 'String' }] };
  let calls = 0;
  const result = await planBusinessQuestionAsync({ metadata: tagged, question: good.businessQuestion, skills, now: new Date('2026-09-11'),
    llm: { enabled: true, planQueryIntent: async input => {
      calls += 1;
      if (calls === 2) assert.match(input.repairFeedback, /containsAny.*containsAll/);
      return { ...structuredClone(good), filters: [...good.filters,
        ...(calls === 1 ? [{ field: 'Labels', operator: 'containsAny', value: ['A'] }, { field: 'Labels', operator: 'containsAny', value: ['B'] }]
          : [{ field: 'Labels', operator: 'containsAny', value: ['A', 'B'] }])],
      };
    } },
  });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(calls, 2);
  assert.deepEqual(result.request.filters.find(filter => filter.field === 'Labels').value, ['A', 'B']);
});

for (const [description, accepted] of [
  ["当前日期2026-09-11所属财年为FY27，因此去年为FY26。", true],
  ['当前财年为FY27，去年为FY26。', true],
  ['今年为FY27，因此去年为FY26。', true],
  ['当前日期 2026-09-11 属于 FY27，因此去年为 FY26。', true],
  ['去年为FY27。', false],
  ['当前财年为FY25，因此去年为FY26。', false],
]) {
  test(`Fiscal explanations validate anchor and requested years separately: ${description}`, async () => {
    let calls = 0;
    const result = await planBusinessQuestionAsync({ metadata, question: '去年销售额', skills, now: new Date('2026-09-11'),
      llm: { enabled: true, planQueryIntent: async () => {
        calls += 1;
        return { ...structuredClone(good), businessQuestion: '去年销售额', dimensions: [],
          filters: [{ field: 'LedgerYear', operator: 'eq', value: '26' }], time: { field: 'LedgerYear', periods: ['26'] },
          assumptions: [description], expectedResult: { shape: 'scalar', requiredMetrics: ['revenue'], requiredPeriods: ['26'] } };
      } },
    });
    assert.equal(result.status, accepted ? 'supported' : 'error', result.message);
    assert.equal(calls, accepted ? 1 : 3);
  });
}
