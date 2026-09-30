import assert from 'node:assert/strict';
import test from 'node:test';
import { planBusinessQuestionAsync } from './lib/conversation/question-planner.mjs';
import { createExplorationLlm } from './lib/llm/exploration-agent.mjs';

const metadata = { id: 'generic-fiscal', fields: [
  { name: '订单金额', role: 'measure', type: 'Number' },
  { name: 'LedgerYear', role: 'dimension', type: 'String' },
  { name: 'BookedAt', role: 'time', type: 'Date' },
] };
const skills = [{ id: 'generic-calendar', status: 'approved', defaultCalendar: 'fiscal', calendarPolicy: { fiscalYearField: 'LedgerYear', dateField: 'BookedAt', fiscalYearStart: '06-01' } }];
const correct = {
  businessQuestion: '今年销售额是多少',
  metrics: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
  dimensions: [], filters: [{ field: 'LedgerYear', operator: 'eq', value: '27' }],
  time: { field: 'LedgerYear', calendar: 'fiscal', periods: ['27'] },
  constraints: [{ id: 't1', type: 'time', normalized: '今年 FY27', required: true, status: 'resolved' }],
  assumptions: ['今年对应 FY27。'], expectedResult: { shape: 'scalar', requiredMetrics: ['revenue'] },
};

async function plan(first, repaired = correct, now = new Date('2026-09-11T00:00:00Z')) {
  const calls = [];
  const result = await planBusinessQuestionAsync({ metadata, question: correct.businessQuestion, skills, now,
    llm: { enabled: true, planQueryIntent: async input => { calls.push(input); return structuredClone(calls.length === 1 ? first : repaired); } },
  });
  return { result, calls };
}

for (const part of ['filter', 'ledger', 'assumption']) {
  test(`A stale fiscal ${part} is repaired by the LLM before execution`, async () => {
    const wrong = structuredClone(correct);
    if (part === 'filter') wrong.filters[0].value = '26';
    if (part === 'ledger') wrong.constraints[0].normalized = '今年 FY26';
    if (part === 'assumption') wrong.assumptions = ['今年对应 FY26。'];
    const { result, calls } = await plan(wrong);
    assert.equal(result.status, 'supported', result.message);
    // A stale source filter is materialized from the approved Skill calendar
    // before coverage validation. Ledger and assumption contradictions still
    // require an LLM repair because they are not executable filters.
    if (part === 'filter') {
      assert.equal(calls.length, 1);
    } else {
      assert.equal(calls.length, 2);
      assert.match(calls[1].repairFeedback, /FY27/);
    }
    assert.equal(JSON.stringify(result.intent).includes('FY26'), false);
  });
}

test('Repeated fiscal disagreement fails without silently changing the answer', async () => {
  const wrong = { ...correct, assumptions: ['今年对应 FY26。'] };
  const { result, calls } = await plan(wrong, wrong);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INTENT_VALIDATION_FAILED');
  assert.equal(result.request, undefined);
  assert.equal(calls.length, 3);
});

test('A planning turn shares one date anchor with all LLM attempts', async () => {
  const { calls } = await plan(correct);
  assert.equal(calls[0].currentDate, '2026-09-11');
});

test('Intent transport uses the supplied business date, not a second wall clock read', async () => {
  let input;
  const llm = createExplorationLlm({ baseUrl: 'https://example.test', model: 'fixture', transport: async request => { input = JSON.parse(request.messages[1].content); return correct; } });
  await llm.planQueryIntent({ metadata, question: '今年销售额', currentDate: '2026-05-31' });
  assert.equal(input.currentDate, '2026-05-31');
});
